import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { checkoutRoutes } from "./checkout/routes.js";
import { refundRoutes } from "./refunds/routes.js";
import { readRoutes } from "./reads/routes.js";

// Build the app separately from starting it, so tests can import the instance
// without binding a port.
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
    // Every request gets a traceable id (structured logs + request IDs).
    genReqId: (req) =>
      (req.headers["x-request-id"] as string | undefined) ??
      globalThis.crypto.randomUUID(),
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Readiness: also confirms the database is reachable.
  app.get("/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.get("/", async () => ({
    name: "kassa",
    description:
      "Transaction-safe payments core: double-entry ledger, idempotent APIs.",
  }));

  void app.register(checkoutRoutes);
  void app.register(refundRoutes);
  void app.register(readRoutes);

  return app;
}
