import type { Tx } from "../db/pool.js";
import { postEntries } from "../ledger/postEntries.js";
import {
  InsufficientInventoryError,
  UnknownSkuError,
} from "./errors.js";

export interface CheckoutItem {
  sku: string;
  quantity: number;
}

export interface CheckoutInput {
  customerRef: string;
  currency?: string;
  items: CheckoutItem[];
}

export interface CheckoutResult {
  orderId: number;
  paymentId: number;
  ledgerTransactionId: number;
  totalAmount: number; // minor units
  currency: string;
}

interface InventoryRow {
  sku: string;
  unit_price: string; // BIGINT arrives as string from node-postgres
  available_qty: number;
}

/**
 * Checkout happy path — everything inside ONE database transaction, so it either
 * fully succeeds or leaves no trace:
 *
 *   1. Lock the needed inventory rows (SELECT ... FOR UPDATE), ordered by sku to
 *      avoid deadlocks when two checkouts touch overlapping items.
 *   2. Validate every requested item exists and has enough stock.
 *   3. Create the order + order_items (price snapshotted at order time).
 *   4. Decrement inventory (the CHECK available_qty >= 0 is a hard backstop).
 *   5. Post balanced ledger entries: debit cash, credit merchant_payable.
 *   6. Record the payment, linked to the ledger transaction.
 *
 * The caller wraps this in withTransaction(); on any throw the whole thing rolls
 * back — no half-charged orders, no phantom stock decrements.
 */
export async function checkout(
  tx: Tx,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const currency = input.currency ?? "SEK";
  const skus = input.items.map((i) => i.sku);

  // 1. Lock inventory rows in a deterministic order.
  const invRes = await tx.query<InventoryRow>(
    `SELECT sku, unit_price, available_qty
     FROM inventory
     WHERE sku = ANY($1::text[])
     ORDER BY sku
     FOR UPDATE`,
    [skus],
  );
  const bySku = new Map(invRes.rows.map((r) => [r.sku, r]));

  // 2. Validate + 4a. compute total.
  let totalAmount = 0n;
  for (const item of input.items) {
    const row = bySku.get(item.sku);
    if (!row) throw new UnknownSkuError(item.sku);
    if (row.available_qty < item.quantity) {
      throw new InsufficientInventoryError(
        item.sku,
        item.quantity,
        row.available_qty,
      );
    }
    totalAmount += BigInt(row.unit_price) * BigInt(item.quantity);
  }

  // 3. Create the order.
  const orderRes = await tx.query<{ id: string }>(
    `INSERT INTO orders (customer_ref, status, currency, total_amount)
     VALUES ($1, 'confirmed', $2, $3)
     RETURNING id`,
    [input.customerRef, currency, totalAmount.toString()],
  );
  const orderId = Number(orderRes.rows[0]!.id);

  // 3b + 4. Order items + inventory decrement.
  for (const item of input.items) {
    const row = bySku.get(item.sku)!;
    await tx.query(
      `INSERT INTO order_items (order_id, sku, quantity, unit_price)
       VALUES ($1, $2, $3, $4)`,
      [orderId, item.sku, item.quantity, row.unit_price],
    );
    await tx.query(
      `UPDATE inventory SET available_qty = available_qty - $1, updated_at = now()
       WHERE sku = $2`,
      [item.quantity, item.sku],
    );
  }

  // 5. Balanced ledger posting: money in (cash) = money owed (merchant_payable).
  const accounts = await tx.query<{ code: string; id: string }>(
    `SELECT code, id FROM accounts WHERE code IN ('cash', 'merchant_payable')`,
  );
  const accountId = new Map(accounts.rows.map((r) => [r.code, Number(r.id)]));
  const cashId = accountId.get("cash")!;
  const merchantPayableId = accountId.get("merchant_payable")!;
  const total = Number(totalAmount);

  const ledgerTransactionId = await postEntries(tx, {
    kind: "checkout",
    reference: `order:${orderId}`,
    legs: [
      { accountId: cashId, direction: "debit", amount: total, currency },
      { accountId: merchantPayableId, direction: "credit", amount: total, currency },
    ],
  });

  // 6. Record the payment.
  const paymentRes = await tx.query<{ id: string }>(
    `INSERT INTO payments (order_id, amount, currency, status, ledger_transaction_id)
     VALUES ($1, $2, $3, 'succeeded', $4)
     RETURNING id`,
    [orderId, total, currency, ledgerTransactionId],
  );
  const paymentId = Number(paymentRes.rows[0]!.id);

  return { orderId, paymentId, ledgerTransactionId, totalAmount: total, currency };
}
