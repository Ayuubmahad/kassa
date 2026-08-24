// The ledger is append-only. These tests prove the DB trigger actually forbids
// UPDATE/DELETE on ledger rows (defense in depth), while TRUNCATE (used by the
// test resets) is unaffected because row-level DELETE triggers don't fire on it.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool, withTransaction, closePool } from "../src/db/pool.js";
import { postEntries } from "../src/ledger/postEntries.js";

let cashId: number;
let revenueId: number;
let txnId: number;

async function migrate(): Promise<void> {
  const sql = await readFile(resolve(process.cwd(), "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

beforeAll(async () => {
  await migrate();
  await pool.query(
    "TRUNCATE ledger_entries, ledger_transactions, payments, refunds, orders, accounts RESTART IDENTITY CASCADE",
  );
  const cash = await pool.query<{ id: string }>(
    `INSERT INTO accounts (code, name, type) VALUES ('cash','Cash','asset') RETURNING id`,
  );
  const revenue = await pool.query<{ id: string }>(
    `INSERT INTO accounts (code, name, type) VALUES ('revenue','Revenue','revenue') RETURNING id`,
  );
  cashId = Number(cash.rows[0]!.id);
  revenueId = Number(revenue.rows[0]!.id);
  txnId = await withTransaction((tx) =>
    postEntries(tx, {
      kind: "checkout",
      legs: [
        { accountId: cashId, direction: "debit", amount: 1000 },
        { accountId: revenueId, direction: "credit", amount: 1000 },
      ],
    }),
  );
});

afterAll(async () => {
  await closePool();
});

describe("append-only ledger", () => {
  it("forbids UPDATE on ledger_entries", async () => {
    await expect(
      pool.query(`UPDATE ledger_entries SET amount = 1 WHERE transaction_id = $1`, [txnId]),
    ).rejects.toThrow(/append-only/);
  });

  it("forbids DELETE on ledger_entries", async () => {
    await expect(
      pool.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [txnId]),
    ).rejects.toThrow(/append-only/);
  });

  it("forbids UPDATE/DELETE on ledger_transactions", async () => {
    await expect(
      pool.query(`UPDATE ledger_transactions SET kind = 'x' WHERE id = $1`, [txnId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM ledger_transactions WHERE id = $1`, [txnId]),
    ).rejects.toThrow(/append-only/);
  });

  it("still allows TRUNCATE (row DELETE triggers don't fire on it)", async () => {
    await expect(
      pool.query("TRUNCATE ledger_entries, ledger_transactions RESTART IDENTITY CASCADE"),
    ).resolves.toBeDefined();
  });
});
