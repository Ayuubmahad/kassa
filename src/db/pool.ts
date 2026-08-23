import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
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

export async function closePool(): Promise<void> {
  await pool.end();
}
