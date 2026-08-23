import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, closePool } from "../src/db/pool.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let keyCounter = 0;
const nextKey = (): string => `k-${keyCounter++}`;

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

/** Checkout to create a payment we can refund. Returns paymentId + amount. */
async function checkoutOnce(quantity: number): Promise<{ paymentId: number; amount: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/checkout",
    headers: { "idempotency-key": nextKey() },
    payload: { customerRef: "cust", items: [{ sku: "SKU-MUG", quantity }] },
  });
  const b = res.json();
  return { paymentId: b.paymentId, amount: b.totalAmount };
}

function refundReq(paymentId: number, body: object, key = nextKey()) {
  return app.inject({
    method: "POST",
    url: `/payments/${paymentId}/refunds`,
    headers: { "idempotency-key": key },
    payload: body,
  });
}

async function ledgerTotals(): Promise<{ debit: bigint; credit: bigint }> {
  const res = await pool.query<{ direction: string; total: string }>(
    `SELECT direction, COALESCE(SUM(amount),0)::text AS total FROM ledger_entries GROUP BY direction`,
  );
  let debit = 0n;
  let credit = 0n;
  for (const r of res.rows) {
    if (r.direction === "debit") debit = BigInt(r.total);
    if (r.direction === "credit") credit = BigInt(r.total);
  }
  return { debit, credit };
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

describe("refunds", () => {
  it("fully refunds a payment and marks it refunded", async () => {
    const { paymentId, amount } = await checkoutOnce(3); // 29700
    const res = await refundReq(paymentId, {}); // no amount = full
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.amount).toBe(amount);
    expect(body.remainingAfter).toBe(0);
    expect(body.paymentStatus).toBe("refunded");

    const payment = await pool.query(`SELECT status FROM payments WHERE id = $1`, [paymentId]);
    expect(payment.rows[0].status).toBe("refunded");

    // Refund links to its payment (the audit-matching requirement).
    // payment_id is BIGINT, which node-postgres returns as a string.
    const link = await pool.query(`SELECT payment_id FROM refunds WHERE id = $1`, [body.refundId]);
    expect(Number(link.rows[0].payment_id)).toBe(paymentId);

    // Global invariant holds after the reversal; net cash movement is zero.
    const { debit, credit } = await ledgerTotals();
    expect(debit).toBe(credit);
    expect(debit).toBe(BigInt(amount * 2)); // checkout + reversal
  });

  it("supports partial refunds until fully refunded", async () => {
    const { paymentId } = await checkoutOnce(3); // 29700

    const first = await refundReq(paymentId, { amount: 10000 });
    expect(first.statusCode).toBe(201);
    expect(first.json().paymentStatus).toBe("partially_refunded");
    expect(first.json().remainingAfter).toBe(19700);

    const second = await refundReq(paymentId, { amount: 19700 });
    expect(second.statusCode).toBe(201);
    expect(second.json().paymentStatus).toBe("refunded");
    expect(second.json().remainingAfter).toBe(0);

    // A further refund is now impossible.
    const third = await refundReq(paymentId, { amount: 1 });
    expect(third.statusCode).toBe(422);
    expect(third.json().error).toBe("PaymentNotRefundableError");
  });

  it("rejects a refund larger than the remaining amount (422)", async () => {
    const { paymentId } = await checkoutOnce(1); // 9900
    const res = await refundReq(paymentId, { amount: 10000 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("RefundExceedsRemainingError");
  });

  it("returns 404 for an unknown payment", async () => {
    const res = await refundReq(999999, { amount: 100 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("PaymentNotFoundError");
  });

  it("is idempotent: same key retried refunds once", async () => {
    const { paymentId } = await checkoutOnce(2); // 19800
    const key = "refund-key";
    const first = await refundReq(paymentId, { amount: 5000 }, key);
    const second = await refundReq(paymentId, { amount: 5000 }, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().refundId).toBe(first.json().refundId);
    expect(second.headers["idempotent-replayed"]).toBe("true");

    const count = await pool.query(`SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1`, [paymentId]);
    expect(count.rows[0].n).toBe(1);
  });
});
