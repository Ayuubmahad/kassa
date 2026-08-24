// Rate limiting is wired globally in buildApp (relaxed under NODE_ENV=test).
// This isolated test proves the plugin actually enforces a limit and returns 429.
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, it, expect } from "vitest";

describe("rate limiting", () => {
  it("returns 429 once the per-window limit is exceeded", async () => {
    const app = Fastify();
    await app.register(rateLimit, { max: 2, timeWindow: 60_000 });
    app.get("/ping", async () => ({ ok: true }));
    await app.ready();

    const r1 = await app.inject({ method: "GET", url: "/ping" });
    const r2 = await app.inject({ method: "GET", url: "/ping" });
    const r3 = await app.inject({ method: "GET", url: "/ping" });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);

    await app.close();
  });
});
