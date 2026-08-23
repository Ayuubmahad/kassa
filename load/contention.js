// Scenario A — contention on limited stock.
// 200 buyers race for SKU-LIMITED (stock = 100). Correct behaviour: exactly 100
// succeed (201), 100 get sold-out (422), and inventory never goes negative.
// Run: npm run db:reset && k6 run load/contention.js
// Verify after: available_qty(SKU-LIMITED)=0, orders=100, then npm run audit:drift
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const success = new Counter("checkout_success");
const soldout = new Counter("checkout_soldout");

export const options = {
  scenarios: {
    contention: { executor: "shared-iterations", vus: 50, iterations: 200 },
  },
  thresholds: {
    // No unexpected statuses (a 500 would mean a race we didn't handle).
    checks: ["rate==1.0"],
  },
};

export default function () {
  const key = `${__VU}-${__ITER}-${Math.random().toString(36).slice(2)}`;
  const res = http.post(
    `${BASE}/checkout`,
    JSON.stringify({ customerRef: `vu${__VU}`, items: [{ sku: "SKU-LIMITED", quantity: 1 }] }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": key } },
  );
  check(res, { "201 or 422 (never 500)": (r) => r.status === 201 || r.status === 422 });
  if (res.status === 201) success.add(1);
  else if (res.status === 422) soldout.add(1);
}
