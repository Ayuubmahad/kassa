// Truncates every table and re-seeds fixtures — a clean slate before a load run.
// Usage: npm run db:reset
import { pool, closePool } from "./pool.js";
import { truncateAll, seedFixtures } from "./fixtures.js";

async function main(): Promise<void> {
  await truncateAll(pool);
  await seedFixtures(pool);
  // eslint-disable-next-line no-console
  console.log("[reset] truncated + reseeded");
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("[reset] failed:", err);
    await closePool();
    process.exit(1);
  });
