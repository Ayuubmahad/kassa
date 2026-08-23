import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, closePool } from "../src/db/pool.js";
import { buildApp } from "../src/app.js";
import { matchRefunds } from "../src/audit/refundMatching.js";
import { runAudit } from "../src/audit/scheduler.js";

let app: FastifyInstance;
let keyCounter = 0;
const nextKey = (): string => `a-${keyCounter++}`;

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
async function checkoutThenRefund(): Promise<number> {
  const co = await app.inject({
    method: "POST", url: "/checkout", headers: { "idempotency-key": nextKey() },
    payload: { customerRef: "c", items: [{ sku: "SKU-MUG", quantity: 2 }] },
  });
  const paymentId = co.json().paymentId;
  await app.inject({
    method: "POST", url: `/payments/${paymentId}/refunds`,
    headers: { "idempotency-key": nextKey() }, payload: { amount: 5000 },
  });
  return paymentId;
}

beforeAll(async () => { await migrate(); app = buildApp(); await app.ready(); });
beforeEach(reset);
afterAll(async () => { await app.close(); await closePool(); });

describe("audit jobs", () => {
  it("refund matching reports 100% matched after real refunds", async () => {
    await checkoutThenRefund();
    const report = await matchRefunds();
    expect(report.total).toBe(1);
    expect(report.allMatched).toBe(true);
    expect(report.orphanCount).toBe(0);
  });

  it("refund matching flags an orphan refund (no ledger transaction)", async () => {
    const paymentId = await checkoutThenRefund();
    // Tamper: a refund pointing at a real payment but with no reversal posting.
    await pool.query(
      `INSERT INTO refunds (payment_id, amount, currency, status, ledger_transaction_id)
       VALUES ($1, 100, 'SEK', 'succeeded', NULL)`,
      [paymentId],
    );
    const report = await matchRefunds();
    expect(report.allMatched).toBe(false);
    expect(report.orphans[0].reason).toBe("no ledger transaction");
  });

  it("runAudit combines drift + refund matching into one ok flag", async () => {
    await checkoutThenRefund();
    const audit = await runAudit();
    expect(audit.ok).toBe(true);
    expect(audit.drift.ok).toBe(true);
    expect(audit.refunds.allMatched).toBe(true);
  });

  it("GET /audit/status returns the audit report", async () => {
    await checkoutThenRefund();
    const res = await app.inject({ method: "GET", url: "/audit/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
