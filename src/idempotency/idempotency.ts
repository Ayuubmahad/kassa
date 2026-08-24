import { createHash } from "node:crypto";
import { withTransactionRetry, type Tx } from "../db/pool.js";

export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super("Idempotency-Key already used with a different request body.");
    this.name = "IdempotencyKeyReuseError";
  }
}

export class IdempotencyInProgressError extends Error {
  constructor() {
    super("A request with this Idempotency-Key is still in progress.");
    this.name = "IdempotencyInProgressError";
  }
}

export interface IdempotentOutcome {
  status: number;
  body: unknown;
}

/** Stable hash of the request body, so key-reuse with a different body is caught. */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Run `work` exactly once per (key, endpoint), even under concurrent retries.
 *
 * How the concurrency safety works, using only the DB:
 *   - We INSERT the key with `ON CONFLICT DO NOTHING` inside the transaction.
 *   - If we inserted it, WE are the leader: run the work, store the response,
 *     commit. The unique key is now locked for the duration of our transaction.
 *   - A concurrent request with the same key runs the same INSERT and BLOCKS on
 *     that lock until we commit. It then sees 0 rows inserted (conflict), reads
 *     our stored response, and replays it — the work never runs twice.
 *   - Same key + different body ⇒ reuse error. The in-progress guard (an existing
 *     row whose response is still NULL) is defensive: in this single-transaction
 *     design a committed key always carries its response, so that state is
 *     effectively unreachable today — it's kept for a future async/multi-step flow
 *     where the key could be committed before the work finishes.
 *
 * Returns the outcome plus whether it was a replay of a prior response.
 */
export async function runIdempotent(
  params: { key: string; endpoint: string; body: unknown },
  work: (tx: Tx) => Promise<IdempotentOutcome>,
): Promise<IdempotentOutcome & { replayed: boolean }> {
  const requestHash = hashRequest(params.body);

  return withTransactionRetry(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (key, endpoint, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (key, endpoint) DO NOTHING
       RETURNING key`,
      [params.key, params.endpoint, requestHash],
    );

    if (inserted.rowCount === 1) {
      // Leader: do the real work, then persist the response in the same txn.
      const outcome = await work(tx);
      await tx.query(
        `UPDATE idempotency_keys
         SET response_status = $1, response_body = $2
         WHERE key = $3 AND endpoint = $4`,
        [outcome.status, JSON.stringify(outcome.body), params.key, params.endpoint],
      );
      return { ...outcome, replayed: false };
    }

    // Follower: the key already existed. Read what the leader stored.
    const existing = await tx.query<{
      request_hash: string;
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, response_status, response_body
       FROM idempotency_keys
       WHERE key = $1 AND endpoint = $2`,
      [params.key, params.endpoint],
    );
    const row = existing.rows[0]!;

    if (row.request_hash !== requestHash) throw new IdempotencyKeyReuseError();
    if (row.response_status === null) throw new IdempotencyInProgressError();

    return { status: row.response_status, body: row.response_body, replayed: true };
  });
}
