import type { Tx } from "../db/pool.js";
import { postEntries } from "../ledger/postEntries.js";
import {
  InvalidRefundAmountError,
  PaymentNotFoundError,
  PaymentNotRefundableError,
  RefundExceedsRemainingError,
} from "./errors.js";

export interface RefundInput {
  paymentId: number;
  /** Minor units. Omit for a full refund of the remaining amount. */
  amount?: number;
}

export interface RefundResult {
  refundId: number;
  paymentId: number;
  amount: number;
  remainingAfter: number;
  paymentStatus: "refunded" | "partially_refunded";
  ledgerTransactionId: number;
  currency: string;
}

interface PaymentRow {
  id: string;
  order_id: string;
  amount: string; // BIGINT -> string
  currency: string;
  status: string;
}

const REFUNDABLE = new Set(["succeeded", "partially_refunded"]);

/**
 * Refund a payment, fully or partially, inside one transaction.
 *
 *   1. Lock the payment row (FOR UPDATE) so concurrent refunds can't both read
 *      the same "remaining" and over-refund.
 *   2. Sum prior succeeded refunds; a new refund must fit in what's left.
 *   3. Post REVERSAL ledger entries — the mirror of checkout: debit
 *      merchant_payable, credit cash. Money owed shrinks, cash held shrinks.
 *   4. Insert the refund linked to its payment + ledger transaction (this link
 *      is what makes 100% refund-to-payment matching possible in audit).
 *   5. Move the payment to 'partially_refunded' or 'refunded'.
 */
export async function refund(tx: Tx, input: RefundInput): Promise<RefundResult> {
  const paymentRes = await tx.query<PaymentRow>(
    `SELECT id, order_id, amount, currency, status FROM payments WHERE id = $1 FOR UPDATE`,
    [input.paymentId],
  );
  const payment = paymentRes.rows[0];
  if (!payment) throw new PaymentNotFoundError(input.paymentId);
  if (!REFUNDABLE.has(payment.status)) {
    throw new PaymentNotRefundableError(input.paymentId, payment.status);
  }

  const paidAmount = BigInt(payment.amount);
  const refundedRes = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
     FROM refunds WHERE payment_id = $1 AND status = 'succeeded'`,
    [input.paymentId],
  );
  const alreadyRefunded = BigInt(refundedRes.rows[0]!.total);
  const remaining = paidAmount - alreadyRefunded;

  // Default (no amount) = refund everything still refundable.
  const requested = input.amount ?? Number(remaining);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new InvalidRefundAmountError(requested);
  }
  if (BigInt(requested) > remaining) {
    throw new RefundExceedsRemainingError(requested, Number(remaining));
  }

  // Reversal legs — the exact mirror of the checkout posting.
  const accounts = await tx.query<{ code: string; id: string }>(
    `SELECT code, id FROM accounts WHERE code IN ('cash', 'merchant_payable')`,
  );
  const accountId = new Map(accounts.rows.map((r) => [r.code, Number(r.id)]));
  const ledgerTransactionId = await postEntries(tx, {
    kind: "refund",
    reference: `payment:${input.paymentId}`,
    legs: [
      { accountId: accountId.get("merchant_payable")!, direction: "debit", amount: requested, currency: payment.currency },
      { accountId: accountId.get("cash")!, direction: "credit", amount: requested, currency: payment.currency },
    ],
  });

  const refundRes = await tx.query<{ id: string }>(
    `INSERT INTO refunds (payment_id, amount, currency, status, ledger_transaction_id)
     VALUES ($1, $2, $3, 'succeeded', $4)
     RETURNING id`,
    [input.paymentId, requested, payment.currency, ledgerTransactionId],
  );
  const refundId = Number(refundRes.rows[0]!.id);

  const remainingAfter = remaining - BigInt(requested);
  const paymentStatus = remainingAfter === 0n ? "refunded" : "partially_refunded";
  await tx.query(`UPDATE payments SET status = $1::payment_status WHERE id = $2`, [
    paymentStatus,
    input.paymentId,
  ]);
  // Keep the order in sync: a fully-refunded payment marks its order refunded.
  if (paymentStatus === "refunded") {
    await tx.query(
      `UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1`,
      [payment.order_id],
    );
  }

  return {
    refundId,
    paymentId: input.paymentId,
    amount: requested,
    remainingAfter: Number(remainingAfter),
    paymentStatus,
    ledgerTransactionId,
    currency: payment.currency,
  };
}
