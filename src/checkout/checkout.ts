import type { Tx } from "../db/pool.js";
import { config } from "../config.js";
import { postEntries } from "../ledger/postEntries.js";
import {
  InsufficientInventoryError,
  UnknownSkuError,
  UnsupportedCurrencyError,
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
  const currency = input.currency ?? config.BASE_CURRENCY;
  // Single-currency by design: reject anything else so no foreign-currency leg
  // can ever be posted against the base-currency accounts.
  if (currency !== config.BASE_CURRENCY) {
    throw new UnsupportedCurrencyError(currency, config.BASE_CURRENCY);
  }

  // 0. Aggregate requested quantity per SKU BEFORE any validation or decrement.
  //    A SKU can legitimately appear in multiple line items; if we validated and
  //    decremented per-line, each line's stock check could pass on its own while
  //    the *summed* demand exceeds stock, and the two decrements would then drive
  //    available_qty negative (CHECK available_qty >= 0 → 23514 → 500). Summing
  //    up front makes the check see true demand and lets us decrement exactly once
  //    per distinct SKU. Sorted for a deterministic order that matches the lock.
  const qtyBySku = new Map<string, number>();
  for (const item of input.items) {
    qtyBySku.set(item.sku, (qtyBySku.get(item.sku) ?? 0) + item.quantity);
  }
  const orderedSkus = [...qtyBySku.keys()].sort();

  // 1. Lock inventory rows in a deterministic order (by sku) to avoid deadlocks.
  const invRes = await tx.query<InventoryRow>(
    `SELECT sku, unit_price, available_qty
     FROM inventory
     WHERE sku = ANY($1::text[])
     ORDER BY sku
     FOR UPDATE`,
    [orderedSkus],
  );
  const bySku = new Map(invRes.rows.map((r) => [r.sku, r]));

  // 2. Validate every DISTINCT sku against its SUMMED quantity + compute total.
  let totalAmount = 0n;
  for (const sku of orderedSkus) {
    const quantity = qtyBySku.get(sku)!;
    const row = bySku.get(sku);
    if (!row) throw new UnknownSkuError(sku);
    if (row.available_qty < quantity) {
      throw new InsufficientInventoryError(sku, quantity, row.available_qty);
    }
    totalAmount += BigInt(row.unit_price) * BigInt(quantity);
  }

  // 3. Create the order.
  const orderRes = await tx.query<{ id: string }>(
    `INSERT INTO orders (customer_ref, status, currency, total_amount)
     VALUES ($1, 'confirmed', $2, $3)
     RETURNING id`,
    [input.customerRef, currency, totalAmount.toString()],
  );
  const orderId = Number(orderRes.rows[0]!.id);

  // 3b + 4. One order_item per DISTINCT sku + a single decrement per sku
  //         (using the summed quantity), so duplicate lines can't double-decrement.
  for (const sku of orderedSkus) {
    const quantity = qtyBySku.get(sku)!;
    const row = bySku.get(sku)!;
    await tx.query(
      `INSERT INTO order_items (order_id, sku, quantity, unit_price)
       VALUES ($1, $2, $3, $4)`,
      [orderId, sku, quantity, row.unit_price],
    );
    await tx.query(
      `UPDATE inventory SET available_qty = available_qty - $1, updated_at = now()
       WHERE sku = $2`,
      [quantity, sku],
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
