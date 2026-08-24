import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
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

  // Public-demo hardening: cap requests per IP. Generous in tests so the suites
  // (which fire many app.inject calls) aren't throttled.
  void app.register(rateLimit, {
    max: config.NODE_ENV === "test" ? 100_000 : config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
  });

  // OpenAPI: @fastify/swagger must load before the routes so its onRoute hook can
  // collect their JSON schemas; swagger-ui then serves the spec at /docs.
  void app.register(swagger, {
    openapi: {
      info: {
        title: "Kassa API",
        description:
          "Transaction-safe payments core: double-entry ledger, idempotent checkout & refunds.",
        version: "0.1.0",
      },
      tags: [
        { name: "checkout" },
        { name: "refunds" },
        { name: "ledger" },
        { name: "audit" },
      ],
    },
  });
  void app.register(swaggerUi, { routePrefix: "/docs" });

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
