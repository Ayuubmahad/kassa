import type { PoolClient } from "pg";
import { pool } from "./pool.js";

type Queryable = Pick<PoolClient, "query"> | typeof pool;

export const ACCOUNTS: Array<{ code: string; name: string; type: string }> = [
  { code: "cash", name: "Cash", type: "asset" },
  { code: "merchant_payable", name: "Merchant Payable", type: "liability" },
  { code: "platform_revenue", name: "Platform Revenue", type: "revenue" },
  { code: "refunds_clearing", name: "Refunds Clearing", type: "liability" },
];

// A catalog of bulk SKUs so throughput tests spread across many inventory rows
// (like real traffic) instead of all serializing on one FOR UPDATE lock.
export const BULK_CATALOG_SIZE = 500;

export const INVENTORY: Array<{ sku: string; name: string; unit_price: number; available_qty: number }> = [
  // Demo items
  { sku: "SKU-COFFEE-1KG", name: "Coffee Beans 1kg", unit_price: 15000, available_qty: 100 },
  { sku: "SKU-MUG", name: "Ceramic Mug", unit_price: 9900, available_qty: 50 },
  { sku: "SKU-ESPRESSO", name: "Espresso Machine", unit_price: 499000, available_qty: 10 },
  // SKU-LIMITED for contention (exactly 100), SKU-BULK for the refund-setup payment.
  { sku: "SKU-LIMITED", name: "Limited Drop", unit_price: 9900, available_qty: 100 },
  { sku: "SKU-BULK", name: "Bulk Item", unit_price: 1000, available_qty: 1_000_000 },
  // Throughput catalog: SKU-BULK-0 .. SKU-BULK-499
  ...Array.from({ length: BULK_CATALOG_SIZE }, (_, i) => ({
    sku: `SKU-BULK-${i}`,
    name: `Bulk Item ${i}`,
    unit_price: 1000,
    available_qty: 100_000,
  })),
];

const ALL_TABLES = `ledger_entries, ledger_transactions, payments, refunds,
  order_items, orders, inventory, accounts, idempotency_keys`;

export async function truncateAll(db: Queryable = pool): Promise<void> {
  await db.query(`TRUNCATE ${ALL_TABLES} RESTART IDENTITY CASCADE`);
}

export async function seedFixtures(db: Queryable = pool): Promise<void> {
  for (const a of ACCOUNTS) {
    await db.query(
      `INSERT INTO accounts (code, name, type) VALUES ($1, $2, $3::account_type)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [a.code, a.name, a.type],
    );
  }
  for (const i of INVENTORY) {
    await db.query(
      `INSERT INTO inventory (sku, name, unit_price, available_qty)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sku) DO UPDATE
         SET name = EXCLUDED.name, unit_price = EXCLUDED.unit_price,
             available_qty = EXCLUDED.available_qty`,
      [i.sku, i.name, i.unit_price, i.available_qty],
    );
  }
}
