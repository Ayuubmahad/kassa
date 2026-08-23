import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, closePool } from "../src/db/pool.js";
import { buildApp } from "../src/app.js";
import { checkDrift } from "../src/audit/drift.js";

let app: FastifyInstance;
let keyCounter = 0;
const nextKey = (): string => `d-${keyCounter++}`;

async function migrate(): Promise<void> {
  const sql = await readFile(resolve(process.cwd(), "db", "schema.sql"), "utf8");
  await pool.query(sql);
}
async function reset(): Promise<void> {
  await pool.query(
    `TRUNCATE ledger_entries, ledger_transactions, payments, refunds,
              order_items, orders, inventory, accounts, idempotency_keys
              RESTART IDENTITY CASCADE`,
  );
  await pool.query(`INSERT INTO accounts (code, name, type) VALUES
    ('cash','Cash','asset'), ('merchant_payable','Merchant Payable','liability');`);
  await pool.query(`INSERT INTO inventory (sku, name, unit_price, available_qty) VALUES
    ('SKU-MUG','Ceramic Mug',9900,50);`);
}
async function checkoutOnce(q: number): Promise<number> {
  const res = await app.inject({
    method: "POST", url: "/checkout", headers: { "idempotency-key": nextKey() },
    payload: { customerRef: "c", items: [{ sku: "SKU-MUG", quantity: q }] },
  });
  return res.json().paymentId;
}

beforeAll(async () => { await migrate(); app = buildApp(); await app.ready(); });
beforeEach(reset);
afterAll(async () => { await app.close(); await closePool(); });

describe("drift checker", () => {
  it("reports ok after checkout + partial refund", async () => {
    const paymentId = await checkoutOnce(3); // 29700 captured
    await app.inject({
      method: "POST", url: `/payments/${paymentId}/refunds`,
      headers: { "idempotency-key": nextKey() }, payload: { amount: 10000 },
    });
    const report = await checkDrift();
    expect(report.ok).toBe(true);
    expect(report.global.balanced).toBe(true);
    expect(report.reconciliation.capturedMinusRefunded).toBe("19700");
    expect(report.reconciliation.cashMatches).toBe(true);
    expect(report.reconciliation.merchantPayableMatches).toBe(true);
  });

  it("CATCHES a deliberately unbalanced entry (proves it isn't rubber-stamping)", async () => {
    await checkoutOnce(1);
    // Inject a lone debit leg — a transaction that cannot balance.
    const txn = await pool.query<{ id: string }>(
      `INSERT INTO ledger_transactions (kind, reference) VALUES ('BOGUS','tamper') RETURNING id`,
    );
    const cash = await pool.query<{ id: string }>(`SELECT id FROM accounts WHERE code='cash'`);
    await pool.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
       VALUES ($1, $2, 'debit', 500)`,
      [txn.rows[0]!.id, cash.rows[0]!.id],
    );

    const report = await checkDrift();
    expect(report.ok).toBe(false);
    expect(report.global.balanced).toBe(false);
    expect(report.unbalancedTransactions.map((t) => t.transactionId)).toContain(
      Number(txn.rows[0]!.id),
    );
  });
});
