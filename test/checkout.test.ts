import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, withTransaction, closePool } from "../src/db/pool.js";
import { checkout } from "../src/checkout/checkout.js";
import { InsufficientInventoryError } from "../src/checkout/errors.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

async function migrate(): Promise<void> {
  const sql = await readFile(resolve(process.cwd(), "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

async function reset(): Promise<void> {
  await pool.query(
    `TRUNCATE ledger_entries, ledger_transactions, payments, refunds,
              order_items, orders, inventory, accounts RESTART IDENTITY CASCADE`,
  );
  await pool.query(`
    INSERT INTO accounts (code, name, type) VALUES
      ('cash', 'Cash', 'asset'),
      ('merchant_payable', 'Merchant Payable', 'liability');
  `);
  await pool.query(`
    INSERT INTO inventory (sku, name, unit_price, available_qty) VALUES
      ('SKU-MUG', 'Ceramic Mug', 9900, 50),
      ('SKU-COFFEE-1KG', 'Coffee Beans 1kg', 15000, 100);
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

describe("checkout happy path", () => {
  it("confirms the order, decrements inventory, posts a balanced ledger, records payment", async () => {
    const result = await withTransaction((tx) =>
      checkout(tx, {
        customerRef: "cust-1",
        items: [
          { sku: "SKU-MUG", quantity: 2 }, // 2 * 9900 = 19800
          { sku: "SKU-COFFEE-1KG", quantity: 1 }, // 15000
        ],
      }),
    );

    expect(result.totalAmount).toBe(34800);

    const order = await pool.query(`SELECT status, total_amount FROM orders WHERE id = $1`, [result.orderId]);
    expect(order.rows[0].status).toBe("confirmed");
    expect(order.rows[0].total_amount).toBe("34800");

    const mug = await pool.query(`SELECT available_qty FROM inventory WHERE sku = 'SKU-MUG'`);
    expect(mug.rows[0].available_qty).toBe(48); // 50 - 2

    // Ledger balances for this transaction.
    const legs = await pool.query<{ direction: string; total: string }>(
      `SELECT direction, SUM(amount)::text AS total FROM ledger_entries
       WHERE transaction_id = $1 GROUP BY direction`,
      [result.ledgerTransactionId],
    );
    const totals = Object.fromEntries(legs.rows.map((r) => [r.direction, r.total]));
    expect(totals.debit).toBe("34800");
    expect(totals.credit).toBe("34800");

    const payment = await pool.query(`SELECT status, amount FROM payments WHERE id = $1`, [result.paymentId]);
    expect(payment.rows[0].status).toBe("succeeded");
    expect(payment.rows[0].amount).toBe("34800");
  });

  it("rejects insufficient inventory and rolls the whole thing back", async () => {
    await expect(
      withTransaction((tx) =>
        checkout(tx, { customerRef: "cust-2", items: [{ sku: "SKU-MUG", quantity: 999 }] }),
      ),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);

    // Nothing changed: no order, inventory intact, ledger empty.
    const orders = await pool.query(`SELECT count(*)::int AS n FROM orders`);
    expect(orders.rows[0].n).toBe(0);
    const mug = await pool.query(`SELECT available_qty FROM inventory WHERE sku = 'SKU-MUG'`);
    expect(mug.rows[0].available_qty).toBe(50);
    const entries = await pool.query(`SELECT count(*)::int AS n FROM ledger_entries`);
    expect(entries.rows[0].n).toBe(0);
  });
});

describe("POST /checkout", () => {
  it("returns 201 with the order + payment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": "http-201" },
      payload: { customerRef: "cust-http", items: [{ sku: "SKU-MUG", quantity: 1 }] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.totalAmount).toBe(9900);
    expect(body.orderId).toBeGreaterThan(0);
  });

  it("returns 422 for an unknown SKU (client error, not a crash)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": "http-422" },
      payload: { customerRef: "cust-x", items: [{ sku: "NOPE", quantity: 1 }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("UnknownSkuError");
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      payload: { customerRef: "cust-nokey", items: [{ sku: "SKU-MUG", quantity: 1 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("MissingIdempotencyKey");
  });

  it("returns 400 for an invalid body (schema validation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      payload: { items: [] }, // missing customerRef, empty items
    });
    expect(res.statusCode).toBe(400);
  });
});
