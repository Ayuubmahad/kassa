import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, closePool } from "../src/db/pool.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

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
  await pool.query(`
    INSERT INTO accounts (code, name, type) VALUES
      ('cash', 'Cash', 'asset'),
      ('merchant_payable', 'Merchant Payable', 'liability');
  `);
  await pool.query(`
    INSERT INTO inventory (sku, name, unit_price, available_qty) VALUES
      ('SKU-MUG', 'Ceramic Mug', 9900, 50);
  `);
}

beforeAll(async () => {
  await migrate();
  app = buildApp();
  await app.ready();
});
beforeEach(reset);
afterAll(async () => {
  await app.close();
  await closePool();
});

const payload = { customerRef: "cust-1", items: [{ sku: "SKU-MUG", quantity: 3 }] };

describe("idempotency", () => {
  it("charges once when the same request is retried with the same key", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": "abc-123" },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": "abc-123" },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    // Same order returned both times, and the replay is flagged.
    expect(second.json().orderId).toBe(first.json().orderId);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.headers["idempotent-replayed"]).toBe("true");

    // The database proves it: exactly ONE charge, ONE inventory decrement.
    const orders = await pool.query(`SELECT count(*)::int AS n FROM orders`);
    const payments = await pool.query(`SELECT count(*)::int AS n FROM payments`);
    const txns = await pool.query(`SELECT count(*)::int AS n FROM ledger_transactions`);
    expect(orders.rows[0].n).toBe(1);
    expect(payments.rows[0].n).toBe(1);
    expect(txns.rows[0].n).toBe(1);

    const mug = await pool.query(`SELECT available_qty FROM inventory WHERE sku = 'SKU-MUG'`);
    expect(mug.rows[0].available_qty).toBe(47); // 50 - 3, decremented once
  });

  it("stress: same key fired 25x concurrently still charges exactly once", async () => {
    const requests = Array.from({ length: 25 }, () =>
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": "burst-key" },
        payload,
      }),
    );
    const results = await Promise.all(requests);

    // Every response is a success (201) — none error out.
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    // All resolve to the same order.
    const orderIds = new Set(results.map((r) => r.json().orderId));
    expect(orderIds.size).toBe(1);
    // And the ledger recorded exactly one charge.
    const payments = await pool.query(`SELECT count(*)::int AS n FROM payments`);
    expect(payments.rows[0].n).toBe(1);
  });

  it("rejects reuse of a key with a different body (422)", async () => {
    await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": "same-key" },
      payload,
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": "same-key" },
      payload: { customerRef: "cust-1", items: [{ sku: "SKU-MUG", quantity: 1 }] },
    });
    expect(conflict.statusCode).toBe(422);
    expect(conflict.json().error).toBe("IdempotencyKeyReuseError");
  });
});
