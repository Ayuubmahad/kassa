import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { getAccountBalances } from "../ledger/balances.js";

type Queryable = Pick<PoolClient, "query"> | typeof pool;

export interface DriftReport {
  ok: boolean;
  global: { debit: string; credit: string; balanced: boolean };
  unbalancedTransactions: Array<{ transactionId: number; debit: string; credit: string }>;
  reconciliation: {
    capturedMinusRefunded: string;
    cashBalance: string;
    merchantPayableBalance: string;
    cashMatches: boolean;
    merchantPayableMatches: boolean;
  };
}

/**
 * Re-derives correctness from RAW ledger entries — deliberately independent of
 * the write path, so it can catch a bug in the poster instead of rubber-stamping
 * it. Three checks:
 *   1. global:  Σdebits == Σcredits across the whole ledger
 *   2. per-txn: every transaction_id balances on its own
 *   3. reconcile: the money model ties out to the business tables
 *      (cash held == captured − refunded; merchant_payable mirrors it)
 */
export async function checkDrift(db: Queryable = pool): Promise<DriftReport> {
  // 1. Global totals.
  const totals = await db.query<{ direction: string; total: string }>(
    `SELECT direction, COALESCE(SUM(amount), 0)::text AS total
     FROM ledger_entries GROUP BY direction`,
  );
  let gDebit = 0n;
  let gCredit = 0n;
  for (const r of totals.rows) {
    if (r.direction === "debit") gDebit = BigInt(r.total);
    if (r.direction === "credit") gCredit = BigInt(r.total);
  }

  // 2. Per-transaction imbalances.
  const perTxn = await db.query<{ transaction_id: string; debit: string; credit: string }>(
    `SELECT transaction_id,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::text  AS debit,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::text AS credit
     FROM ledger_entries
     GROUP BY transaction_id
     HAVING COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)
          <> COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)`,
  );
  const unbalancedTransactions = perTxn.rows.map((r) => ({
    transactionId: Number(r.transaction_id),
    debit: r.debit,
    credit: r.credit,
  }));

  // 3. Reconcile ledger balances against the business tables.
  const captured = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM payments
     WHERE status IN ('succeeded', 'partially_refunded', 'refunded')`,
  );
  const refunded = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM refunds WHERE status = 'succeeded'`,
  );
  const capturedMinusRefunded = BigInt(captured.rows[0]!.total) - BigInt(refunded.rows[0]!.total);

  const balances = await getAccountBalances(db);
  const cash = balances.find((b) => b.code === "cash")?.balance ?? 0n;
  const merchantPayable = balances.find((b) => b.code === "merchant_payable")?.balance ?? 0n;

  const cashMatches = cash === capturedMinusRefunded;
  const merchantPayableMatches = merchantPayable === capturedMinusRefunded;
  const globalBalanced = gDebit === gCredit;

  return {
    ok: globalBalanced && unbalancedTransactions.length === 0 && cashMatches && merchantPayableMatches,
    global: { debit: gDebit.toString(), credit: gCredit.toString(), balanced: globalBalanced },
    unbalancedTransactions,
    reconciliation: {
      capturedMinusRefunded: capturedMinusRefunded.toString(),
      cashBalance: cash.toString(),
      merchantPayableBalance: merchantPayable.toString(),
      cashMatches,
      merchantPayableMatches,
    },
  };
}
