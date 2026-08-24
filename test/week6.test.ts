import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, closePool, isSerializationError } from "../src/db/pool.js";
import { deleteExpiredIdempotencyKeys } from "../src/idempotency/idempotency.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let keyCounter = 0;
const nextKey = (): string => `w6-${keyCounter++}`;

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

beforeAll(async () => { await migrate(); app = buildApp(); await app.ready(); });
beforeEach(reset);
afterAll(async () => { await app.close(); await closePool(); });

describe("order status on full refund", () => {
  it("marks the order 'refunded' when the payment is fully refunded", async () => {
    const co = await app.inject({
      method: "POST", url: "/checkout", headers: { "idempotency-key": nextKey() },
      payload: { customerRef: "c", items: [{ sku: "SKU-MUG", quantity: 1 }] },
    });
    const { orderId, paymentId } = co.json();

    await app.inject({
      method: "POST", url: `/payments/${paymentId}/refunds`,
      headers: { "idempotency-key": nextKey() }, payload: {}, // full refund
    });

    const order = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    expect(order.rows[0].status).toBe("refunded");
  });

  it("leaves the order 'confirmed' on a partial refund", async () => {
    const co = await app.inject({
      method: "POST", url: "/checkout", headers: { "idempotency-key": nextKey() },
      payload: { customerRef: "c", items: [{ sku: "SKU-MUG", quantity: 2 }] }, // 19800
    });
    const { orderId, paymentId } = co.json();
    await app.inject({
      method: "POST", url: `/payments/${paymentId}/refunds`,
      headers: { "idempotency-key": nextKey() }, payload: { amount: 5000 },
    });
    const order = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    expect(order.rows[0].status).toBe("confirmed");
  });
});

describe("idempotency key retention", () => {
  it("deletes keys older than the TTL, keeps recent ones", async () => {
    await pool.query(
      `INSERT INTO idempotency_keys (key, endpoint, request_hash, created_at)
       VALUES ('old', 'POST /checkout', 'h', now() - interval '100 days'),
              ('fresh', 'POST /checkout', 'h', now())`,
    );
    const removed = await deleteExpiredIdempotencyKeys(60_000); // 1 minute TTL
    expect(removed).toBe(1);
    const left = await pool.query(`SELECT key FROM idempotency_keys ORDER BY key`);
    expect(left.rows.map((r) => r.key)).toEqual(["fresh"]);
  });
});

describe("isSerializationError", () => {
  it("recognises 40001 and 40P01, rejects others", () => {
    expect(isSerializationError({ code: "40001" })).toBe(true);
    expect(isSerializationError({ code: "40P01" })).toBe(true);
    expect(isSerializationError({ code: "23514" })).toBe(false);
    expect(isSerializationError(new Error("nope"))).toBe(false);
    expect(isSerializationError(null)).toBe(false);
  });
});
