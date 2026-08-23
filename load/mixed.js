// Scenario D — sustained throughput for the headline latency number.
// Constant 200 req/s of checkouts for 20s, each buying a RANDOM SKU from a
// 500-item catalog so load spreads across rows (like real traffic) instead of
// serializing on one lock. Headline thresholds: p95 < 150ms and <1% failures.
// Run: npm run db:reset && k6 run load/mixed.js
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const CATALOG = 500;

export const options = {
  scenarios: {
    mixed: {
      executor: "constant-arrival-rate",
      rate: 200,
      timeUnit: "1s",
      duration: "20s",
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<150"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate==1.0"],
  },
};

export default function () {
  const key = `${__VU}-${__ITER}-${Math.random().toString(36).slice(2)}`;
  const sku = `SKU-BULK-${Math.floor(Math.random() * CATALOG)}`;
  const res = http.post(
    `${BASE}/checkout`,
    JSON.stringify({ customerRef: `vu${__VU}`, items: [{ sku, quantity: 1 }] }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": key } },
  );
  check(res, { "201": (r) => r.status === 201 });
}
