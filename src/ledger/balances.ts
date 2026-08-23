import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

// A DB handle that can run queries: either the pool or a transaction client.
type Queryable = Pick<PoolClient, "query"> | typeof pool;

export interface AccountBalance {
  code: string;
  name: string;
  type: string;
  currency: string;
  debit: bigint;
  credit: bigint;
  /** Signed by the account's normal side (asset/expense: debit-normal). */
  balance: bigint;
}

const DEBIT_NORMAL = new Set(["asset", "expense"]);

/**
 * Derive every account's balance from raw ledger entries — the single source of
 * truth for balances (never a stored mutable number). Returns exact BigInts;
 * callers serialize as needed. Reused by the drift checker's reconciliation.
 */
export async function getAccountBalances(
  db: Queryable = pool,
): Promise<AccountBalance[]> {
  const res = await db.query<{
    code: string;
    name: string;
    type: string;
    currency: string;
    debit: string;
    credit: string;
  }>(
    `SELECT a.code, a.name, a.type::text AS type, a.currency,
            COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount END), 0)::text AS debit,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount END), 0)::text AS credit
     FROM accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id, a.code, a.name, a.type, a.currency
     ORDER BY a.code`,
  );

  return res.rows.map((r) => {
    const debit = BigInt(r.debit);
    const credit = BigInt(r.credit);
    const balance = DEBIT_NORMAL.has(r.type) ? debit - credit : credit - debit;
    return { code: r.code, name: r.name, type: r.type, currency: r.currency, debit, credit, balance };
  });
}
