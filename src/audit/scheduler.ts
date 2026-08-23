import { checkDrift, type DriftReport } from "./drift.js";
import { matchRefunds, type RefundMatchReport } from "./refundMatching.js";
import { pool } from "../db/pool.js";

export interface AuditReport {
  at: string;
  ok: boolean;
  drift: DriftReport;
  refunds: RefundMatchReport;
}

let lastReport: AuditReport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Run the full audit once (ledger invariant + refund matching). */
export async function runAudit(): Promise<AuditReport> {
  const drift = await checkDrift(pool);
  const refunds = await matchRefunds(pool);
  const report: AuditReport = {
    at: new Date().toISOString(),
    ok: drift.ok && refunds.allMatched,
    drift,
    refunds,
  };
  lastReport = report;
  return report;
}

export function getLastReport(): AuditReport | null {
  return lastReport;
}

/**
 * Start the periodic invariant checker ("nightly" by default). Runs once at
 * startup, then every intervalMs. `unref()` so this timer never keeps the
 * process alive on its own during shutdown.
 */
export function startAuditScheduler(
  intervalMs: number,
  onDrift?: (report: AuditReport) => void,
): void {
  if (timer) return;
  const tick = (): void => {
    runAudit()
      .then((r) => {
        if (!r.ok && onDrift) onDrift(r);
      })
      .catch(() => {
        /* audit failures shouldn't crash the server; next tick retries */
      });
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

export function stopAuditScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
