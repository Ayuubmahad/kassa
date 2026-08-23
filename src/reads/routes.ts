import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getAccountBalances } from "../ledger/balances.js";
import { checkDrift } from "../audit/drift.js";

const idParams = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

export async function readRoutes(app: FastifyInstance): Promise<void> {
  // Order + items + payment summary.
  app.get("/orders/:id", { schema: { params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const order = await pool.query(
      `SELECT id, customer_ref, status, currency, total_amount, created_at
       FROM orders WHERE id = $1`,
      [id],
    );
    if (order.rowCount === 0) return reply.code(404).send({ error: "OrderNotFound" });

    const items = await pool.query(
      `SELECT sku, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY id`,
      [id],
    );
    const payment = await pool.query(
      `SELECT id, amount, status FROM payments WHERE order_id = $1 ORDER BY id LIMIT 1`,
      [id],
    );

    const o = order.rows[0];
    return {
      id: Number(o.id),
      customerRef: o.customer_ref,
      status: o.status,
      currency: o.currency,
      totalAmount: Number(o.total_amount),
      createdAt: o.created_at,
      items: items.rows.map((r) => ({
        sku: r.sku,
        quantity: r.quantity,
        unitPrice: Number(r.unit_price),
      })),
      payment: payment.rows[0]
        ? { id: Number(payment.rows[0].id), amount: Number(payment.rows[0].amount), status: payment.rows[0].status }
        : null,
    };
  });

  // Payment + refunded total + remaining + refund list.
  app.get("/payments/:id", { schema: { params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const payment = await pool.query(
      `SELECT id, order_id, amount, currency, status FROM payments WHERE id = $1`,
      [id],
    );
    if (payment.rowCount === 0) return reply.code(404).send({ error: "PaymentNotFound" });

    const refunds = await pool.query(
      `SELECT id, amount, status, created_at FROM refunds WHERE payment_id = $1 ORDER BY id`,
      [id],
    );
    const refundedTotal = refunds.rows
      .filter((r) => r.status === "succeeded")
      .reduce((sum, r) => sum + Number(r.amount), 0);

    const p = payment.rows[0];
    const amount = Number(p.amount);
    return {
      id: Number(p.id),
      orderId: Number(p.order_id),
      amount,
      currency: p.currency,
      status: p.status,
      refundedTotal,
      remaining: amount - refundedTotal,
      refunds: refunds.rows.map((r) => ({
        id: Number(r.id),
        amount: Number(r.amount),
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  });

  // Independent drift/reconciliation report (handy for the demo + post-load checks).
  app.get("/audit/drift", async () => checkDrift());

  // Derived account balances (from raw entries).
  app.get("/ledger/accounts", async () => {
    const balances = await getAccountBalances();
    return balances.map((b) => ({
      code: b.code,
      name: b.name,
      type: b.type,
      currency: b.currency,
      debit: Number(b.debit),
      credit: Number(b.credit),
      balance: Number(b.balance),
    }));
  });

  // Recent ledger transactions with their legs (paginated).
  app.get("/ledger/transactions", { schema: { querystring: listQuery } }, async (req) => {
    const { limit, offset } = req.query as { limit: number; offset: number };
    const txns = await pool.query(
      `SELECT id, kind, reference, created_at
       FROM ledger_transactions ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const ids = txns.rows.map((t) => Number(t.id));
    const legs = ids.length
      ? await pool.query(
          `SELECT e.transaction_id, a.code AS account_code, e.direction, e.amount
           FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
           WHERE e.transaction_id = ANY($1::bigint[]) ORDER BY e.id`,
          [ids],
        )
      : { rows: [] as Array<{ transaction_id: string; account_code: string; direction: string; amount: string }> };

    const legsByTxn = new Map<number, Array<{ accountCode: string; direction: string; amount: number }>>();
    for (const l of legs.rows) {
      const tid = Number(l.transaction_id);
      const arr = legsByTxn.get(tid) ?? [];
      arr.push({ accountCode: l.account_code, direction: l.direction, amount: Number(l.amount) });
      legsByTxn.set(tid, arr);
    }

    return {
      limit,
      offset,
      transactions: txns.rows.map((t) => ({
        id: Number(t.id),
        kind: t.kind,
        reference: t.reference,
        createdAt: t.created_at,
        legs: legsByTxn.get(Number(t.id)) ?? [],
      })),
    };
  });
}
