// Seeds the chart of accounts + demo/load inventory. Idempotent (ON CONFLICT).
// Usage: npm run db:seed
import { pool, closePool } from "./pool.js";
import { ACCOUNTS, INVENTORY, seedFixtures } from "./fixtures.js";

seedFixtures(pool)
  .then(async () => {
    // eslint-disable-next-line no-console
    console.log(`[seed] ${ACCOUNTS.length} accounts, ${INVENTORY.length} inventory items`);
    await closePool();
  })
  .catch(async (err) => {
    console.error("[seed] failed:", err);
    await closePool();
    process.exit(1);
  });
