import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closePool } from "./db/pool.js";
import { startAuditScheduler, stopAuditScheduler } from "./audit/scheduler.js";

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    // Periodic invariant checker; logs an error if the ledger ever drifts.
    startAuditScheduler(config.AUDIT_INTERVAL_MS, (r) =>
      app.log.error({ audit: r }, "AUDIT DRIFT DETECTED"),
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown: stop accepting requests, then drain the DB pool.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    stopAuditScheduler();
    await app.close();
    await closePool();
    process.exit(0);
  });
}

void start();
