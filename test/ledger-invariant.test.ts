// THE first test of the whole project (roadmap Week 1):
// the ledger invariant — sum(debits) = sum(credits), always.
//
// It exercises the real postEntries() against a real Postgres, because the
// invariant is a property of what actually lands in the tables, not of a mock.
import { beforeAll, afterEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool, withTransaction, closePool } from "../src/db/pool.js";
import {
  postEntries,
  UnbalancedLedgerError,
  InvalidLegError,
} from "../src/ledger/postEntries.js";

// Two accounts to move money between.
let cashId: number;
let revenueId: number;

async function migrate(): Promise<void> {
  const sql = await readFile(resolve(process.cwd(), "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

beforeAll(async () => {
  await migrate();
  // Start from a clean slate — the Docker volume persists rows between runs.
  await pool.query(
    "TRUNCATE ledger_entries, ledger_transactions, payments, refunds, orders RESTART IDENTITY CASCADE",
  );
  const cash = await pool.query<{ id: string }>(
    `INSERT INTO accounts (code, name, type) VALUES ('cash', 'Cash', 'asset')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const revenue = await pool.query<{ id: string }>(
    `INSERT INTO accounts (code, name, type) VALUES ('revenue', 'Revenue', 'revenue')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  cashId = Number(cash.rows[0]!.id);
  revenueId = Number(revenue.rows[0]!.id);
});

afterEach(async () => {
  // Ledger is append-only in production; tests reset it between cases.
  // CASCADE because payments/refunds carry FKs to ledger_transactions;
  // Postgres refuses to TRUNCATE an FK-referenced table without it.
  await pool.query(
    "TRUNCATE ledger_entries, ledger_transactions, payments, refunds, orders RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await closePool();
});

/** Global invariant: across ALL entries, total debits equal total credits. */
async function totalsByDirection(): Promise<{ debit: bigint; credit: bigint }> {
  const res = await pool.query<{ direction: string; total: string }>(
    `SELECT direction, COALESCE(SUM(amount), 0)::text AS total
     FROM ledger_entries GROUP BY direction`,
  );
  let debit = 0n;
  let credit = 0n;
  for (const row of res.rows) {
    if (row.direction === "debit") debit = BigInt(row.total);
    if (row.direction === "credit") credit = BigInt(row.total);
  }
  return { debit, credit };
}

describe("ledger invariant", () => {
  it("holds after a single balanced posting", async () => {
    await withTransaction((tx) =>
      postEntries(tx, {
        kind: "checkout",
        reference: "order-1",
        legs: [
          { accountId: cashId, direction: "debit", amount: 15000 },
          { accountId: revenueId, direction: "credit", amount: 15000 },
        ],
      }),
    );

    const { debit, credit } = await totalsByDirection();
    expect(debit).toBe(15000n);
    expect(credit).toBe(15000n);
    expect(debit).toBe(credit);
  });

  it("holds across many postings with split legs", async () => {
    for (let i = 0; i < 50; i++) {
      await withTransaction((tx) =>
        postEntries(tx, {
          kind: "checkout",
          legs: [
            { accountId: cashId, direction: "debit", amount: 1000 },
            { accountId: revenueId, direction: "credit", amount: 700 },
            { accountId: revenueId, direction: "credit", amount: 300 },
          ],
        }),
      );
    }
    const { debit, credit } = await totalsByDirection();
    expect(debit).toBe(50_000n);
    expect(credit).toBe(50_000n);
  });

  it("rejects an unbalanced posting and writes nothing (atomic)", async () => {
    await expect(
      withTransaction((tx) =>
        postEntries(tx, {
          kind: "checkout",
          legs: [
            { accountId: cashId, direction: "debit", amount: 15000 },
            { accountId: revenueId, direction: "credit", amount: 14900 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(UnbalancedLedgerError);

    const { debit, credit } = await totalsByDirection();
    expect(debit).toBe(0n);
    expect(credit).toBe(0n);
  });

  it("rejects non-integer / non-positive amounts (no floats)", async () => {
    await expect(
      withTransaction((tx) =>
        postEntries(tx, {
          kind: "checkout",
          legs: [
            { accountId: cashId, direction: "debit", amount: 100.5 },
            { accountId: revenueId, direction: "credit", amount: 100.5 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidLegError);
  });

  it("rejects mixed currencies in one transaction", async () => {
    await expect(
      withTransaction((tx) =>
        postEntries(tx, {
          kind: "checkout",
          legs: [
            { accountId: cashId, direction: "debit", amount: 1000, currency: "SEK" },
            { accountId: revenueId, direction: "credit", amount: 1000, currency: "USD" },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidLegError);
  });
});
