import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

type Queryable = Pick<PoolClient, "query"> | typeof pool;

export interface RefundMatchReport {
  total: number;
  matched: number;
  orphanCount: number;
  allMatched: boolean;
  orphans: Array<{ refundId: number; reason: string }>;
}

/**
 * Refund-to-payment matching (roadmap Week 5 "100% refund-to-payment matching").
 *
 * Every refund must (a) point at a real payment and (b) carry a ledger
 * transaction id (its reversal posting). The payment FK makes (a) structurally
 * hard to violate, but the job checks it anyway — an audit that trusts the schema
 * isn't an audit. Anything failing either check is an orphan.
 */
export async function matchRefunds(db: Queryable = pool): Promise<RefundMatchReport> {
  const res = await db.query<{
    refund_id: string;
    payment_ok: boolean;
    has_ledger: boolean;
  }>(
    `SELECT r.id AS refund_id,
            (p.id IS NOT NULL)                  AS payment_ok,
            (r.ledger_transaction_id IS NOT NULL) AS has_ledger
     FROM refunds r
     LEFT JOIN payments p ON p.id = r.payment_id
     ORDER BY r.id`,
  );

  const orphans: Array<{ refundId: number; reason: string }> = [];
  for (const row of res.rows) {
    if (!row.payment_ok) orphans.push({ refundId: Number(row.refund_id), reason: "no matching payment" });
    else if (!row.has_ledger) orphans.push({ refundId: Number(row.refund_id), reason: "no ledger transaction" });
  }

  const total = res.rows.length;
  return {
    total,
    matched: total - orphans.length,
    orphanCount: orphans.length,
    allMatched: orphans.length === 0,
    orphans,
  };
}
