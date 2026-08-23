// Scenario B — idempotency under a concurrent retry storm.
// 100 requests, all with the SAME Idempotency-Key, fired by 30 VUs. Correct
// behaviour: every response is 201 and exactly ONE order/charge is created.
// Run: npm run db:reset && k6 run load/idempotency.js
// Verify after: orders=1, payments=1 in the DB.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const SHARED_KEY = "burst-fixed-key";

export const options = {
  scenarios: {
    storm: { executor: "shared-iterations", vus: 30, iterations: 100 },
  },
  thresholds: { checks: ["rate==1.0"] },
};

export default function () {
  const res = http.post(
    `${BASE}/checkout`,
    JSON.stringify({ customerRef: "same-buyer", items: [{ sku: "SKU-BULK", quantity: 1 }] }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": SHARED_KEY } },
  );
  check(res, { "201": (r) => r.status === 201 });
}
