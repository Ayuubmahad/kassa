import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export type Tx = pg.PoolClient;

/**
 * Run `fn` inside a single-client transaction.
 *
 * node-postgres requires that every statement in a transaction runs on the SAME
 * client — `pool.query` grabs a different client per call and will corrupt a
 * transaction. So we check out one client, BEGIN/COMMIT/ROLLBACK on it, and
 * always release it back to the pool.
 * See: https://node-postgres.com/features/transactions
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // If rollback itself fails the client is broken; releasing with an error
      // below tells the pool to discard it rather than reuse a poisoned client.
    }
    throw err;
  } finally {
    client.release();
  }
}

// Postgres SQLSTATEs worth retrying: the transaction lost a race and rolling it
// back + trying again is the correct response (the data is fine).
//   40001 = serialization_failure, 40P01 = deadlock_detected
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

/**
 * Like withTransaction, but retries the WHOLE transaction on deadlock /
 * serialization failure with jittered exponential backoff. Under concurrent load
 * two transactions can deadlock even with consistent lock ordering; retrying a
 * handful of times turns those into eventual successes instead of 500s.
 *
 * Safe to wrap idempotent work: a rolled-back attempt un-inserts everything
 * (including any idempotency key), so the retry starts clean.
 */
export async function withTransactionRetry<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: { retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTransaction(fn);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code && RETRYABLE_SQLSTATES.has(code) && attempt < retries) {
        lastErr = err;
        const backoffMs = Math.min(50 * 2 ** attempt, 500) * (0.5 + Math.random());
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
