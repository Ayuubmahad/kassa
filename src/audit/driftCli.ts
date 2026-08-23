// Re-sums the whole ledger and reports drift. Exits non-zero if drift is found,
// so it can gate CI or a cron job. Usage: npm run audit:drift
import { checkDrift } from "./drift.js";
import { closePool } from "../db/pool.js";

async function main(): Promise<void> {
  const report = await checkDrift();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  await closePool();
  if (!report.ok) {
    console.error("[audit:drift] DRIFT DETECTED");
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("[audit:drift] OK — ledger balances, reconciliation ties out.");
}

main().catch(async (err) => {
  console.error("[audit:drift] failed:", err);
  await closePool();
  process.exit(1);
});
