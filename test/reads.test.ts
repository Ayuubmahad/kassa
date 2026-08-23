import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, closePool } from "../src/db/pool.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let keyCounter = 0;
const nextKey = (): string => `r-${keyCounter++}`;

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
async function checkoutOnce(quantity: number): Promise<{ orderId: number; paymentId: number }> {
  const res = await app.inject({
    method: "POST", url: "/checkout", headers: { "idempotency-key": nextKey() },
    payload: { customerRef: "c", items: [{ sku: "SKU-MUG", quantity }] },
  });
  return { orderId: res.json().orderId, paymentId: res.json().paymentId };
}

beforeAll(async () => { await migrate(); app = buildApp(); await app.ready(); });
beforeEach(reset);
afterAll(async () => { await app.close(); await closePool(); });

describe("read endpoints", () => {
  it("GET /orders/:id returns order, items, and payment", async () => {
    const { orderId } = await checkoutOnce(2); // 19800
    const res = await app.inject({ method: "GET", url: `/orders/${orderId}` });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.status).toBe("confirmed");
    expect(b.totalAmount).toBe(19800);
    expect(b.items).toHaveLength(1);
    expect(b.payment.amount).toBe(19800);
  });

  it("GET /orders/:id 404s for a missing order", async () => {
    const res = await app.inject({ method: "GET", url: "/orders/999999" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /payments/:id reflects refunds in refundedTotal + remaining", async () => {
    const { paymentId } = await checkoutOnce(2); // 19800
    await app.inject({
      method: "POST", url: `/payments/${paymentId}/refunds`,
      headers: { "idempotency-key": nextKey() }, payload: { amount: 5000 },
    });
    const res = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
    const b = res.json();
    expect(b.refundedTotal).toBe(5000);
    expect(b.remaining).toBe(14800);
    expect(b.status).toBe("partially_refunded");
  });

  it("GET /ledger/accounts: cash balance = captured − refunded", async () => {
    await checkoutOnce(1); // 9900 captured
    const res = await app.inject({ method: "GET", url: "/ledger/accounts" });
    const cash = res.json().find((a: { code: string }) => a.code === "cash");
    expect(cash.balance).toBe(9900);
  });

  it("GET /ledger/transactions paginates and includes legs", async () => {
    await checkoutOnce(1);
    await checkoutOnce(1);
    const res = await app.inject({ method: "GET", url: "/ledger/transactions?limit=1" });
    const b = res.json();
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0].legs.length).toBe(2); // debit cash + credit merchant_payable
  });

  it("GET /audit/drift is ok after normal activity", async () => {
    await checkoutOnce(1);
    const res = await app.inject({ method: "GET", url: "/audit/drift" });
    expect(res.json().ok).toBe(true);
  });
});
