import type { Tx } from "../db/pool.js";

export type Direction = "debit" | "credit";

export interface LedgerLeg {
  accountId: number;
  direction: Direction;
  /** Minor units (öre/cents). Must be a positive integer. */
  amount: number;
  currency?: string;
}

export interface PostEntriesInput {
  kind: string;
  reference?: string;
  legs: LedgerLeg[];
}

export class UnbalancedLedgerError extends Error {
  constructor(debits: bigint, credits: bigint) {
    super(
      `Ledger transaction does not balance: debits=${debits} credits=${credits}`,
    );
    this.name = "UnbalancedLedgerError";
  }
}

export class InvalidLegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLegError";
  }
}

/**
 * The one function every money movement flows through.
 *
 * Writes a balanced set of double-entry legs atomically: either the header and
 * every leg are inserted, or nothing is. The caller supplies a transaction
 * client (`Tx`) so this can compose with inventory reservation, payment rows,
 * etc. inside one DB transaction — see `withTransaction`.
 *
 * Invariants enforced BEFORE any write:
 *   - at least two legs
 *   - every amount is a positive integer (minor units)
 *   - a single currency across the transaction
 *   - sum(debits) === sum(credits)
 *
 * Returns the new ledger_transactions.id.
 */
export async function postEntries(
  tx: Tx,
  input: PostEntriesInput,
): Promise<number> {
  const { kind, reference, legs } = input;

  if (!Array.isArray(legs) || legs.length < 2) {
    throw new InvalidLegError("A ledger transaction needs at least two legs.");
  }

  const currencies = new Set<string>();
  let debits = 0n;
  let credits = 0n;

  for (const leg of legs) {
    if (!Number.isInteger(leg.amount) || leg.amount <= 0) {
      throw new InvalidLegError(
        `Leg amount must be a positive integer (minor units); got ${leg.amount}.`,
      );
    }
    if (!Number.isInteger(leg.accountId) || leg.accountId <= 0) {
      throw new InvalidLegError(`Leg accountId is invalid: ${leg.accountId}.`);
    }
    currencies.add(leg.currency ?? "SEK");
    if (leg.direction === "debit") debits += BigInt(leg.amount);
    else if (leg.direction === "credit") credits += BigInt(leg.amount);
    else throw new InvalidLegError(`Unknown direction: ${String(leg.direction)}`);
  }

  if (currencies.size > 1) {
    throw new InvalidLegError(
      `All legs must share one currency; got ${[...currencies].join(", ")}.`,
    );
  }
  if (debits !== credits) {
    throw new UnbalancedLedgerError(debits, credits);
  }

  const currency = [...currencies][0] ?? "SEK";

  const header = await tx.query<{ id: string }>(
    `INSERT INTO ledger_transactions (kind, reference)
     VALUES ($1, $2)
     RETURNING id`,
    [kind, reference ?? null],
  );
  const transactionId = Number(header.rows[0]!.id);

  for (const leg of legs) {
    await tx.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [transactionId, leg.accountId, leg.direction, leg.amount, leg.currency ?? currency],
    );
  }

  return transactionId;
}
