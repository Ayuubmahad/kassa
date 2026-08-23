// Seeds the chart of accounts + demo inventory. Idempotent (ON CONFLICT).
// Usage: npm run db:seed
import { pool, closePool } from "./pool.js";

const ACCOUNTS: Array<{ code: string; name: string; type: string }> = [
  { code: "cash", name: "Cash", type: "asset" },
  { code: "merchant_payable", name: "Merchant Payable", type: "liability" },
  { code: "platform_revenue", name: "Platform Revenue", type: "revenue" },
  { code: "refunds_clearing", name: "Refunds Clearing", type: "liability" },
];

const INVENTORY: Array<{
  sku: string;
  name: string;
  unit_price: number;
  available_qty: number;
}> = [
  { sku: "SKU-COFFEE-1KG", name: "Coffee Beans 1kg", unit_price: 15000, available_qty: 100 },
  { sku: "SKU-MUG", name: "Ceramic Mug", unit_price: 9900, available_qty: 50 },
  { sku: "SKU-ESPRESSO", name: "Espresso Machine", unit_price: 499000, available_qty: 10 },
];

async function seed(): Promise<void> {
  for (const a of ACCOUNTS) {
    await pool.query(
      `INSERT INTO accounts (code, name, type) VALUES ($1, $2, $3::account_type)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [a.code, a.name, a.type],
    );
  }
  for (const i of INVENTORY) {
    await pool.query(
      `INSERT INTO inventory (sku, name, unit_price, available_qty)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sku) DO UPDATE
         SET name = EXCLUDED.name, unit_price = EXCLUDED.unit_price`,
      [i.sku, i.name, i.unit_price, i.available_qty],
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] ${ACCOUNTS.length} accounts, ${INVENTORY.length} inventory items`);
}

seed()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("[seed] failed:", err);
    await closePool();
    process.exit(1);
  });
