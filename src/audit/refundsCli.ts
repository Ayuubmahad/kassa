// Refund-to-payment matching report. Exits non-zero if any orphan is found.
// Usage: npm run audit:refunds
import { matchRefunds } from "./refundMatching.js";
import { closePool } from "../db/pool.js";

async function main(): Promise<void> {
  const report = await matchRefunds();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  await closePool();
  if (!report.allMatched) {
    console.error(`[audit:refunds] ${report.orphanCount} ORPHAN refund(s) found`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[audit:refunds] OK — ${report.matched}/${report.total} refunds matched to payments.`);
}

main().catch(async (err) => {
  console.error("[audit:refunds] failed:", err);
  await closePool();
  process.exit(1);
});
