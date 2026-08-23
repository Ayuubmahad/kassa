// Scenario C — concurrent refunds on one payment must never over-refund.
// setup() creates a payment of 100 x 1000 = 100000. Then 200 refunds of 1000
// each race: exactly 100 should succeed, the rest 422 (exceeds remaining).
// Run: npm run db:reset && k6 run load/refunds.js
// Verify after: sum(succeeded refunds) <= payment amount; npm run audit:drift ok.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const refunded = new Counter("refund_success");
const rejected = new Counter("refund_rejected");

export const options = {
  scenarios: {
    refundstorm: { executor: "shared-iterations", vus: 40, iterations: 200 },
  },
  thresholds: { checks: ["rate==1.0"] },
};

export function setup() {
  const key = `setup-${Math.random().toString(36).slice(2)}`;
  const res = http.post(
    `${BASE}/checkout`,
    JSON.stringify({ customerRef: "refund-setup", items: [{ sku: "SKU-BULK", quantity: 100 }] }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": key } },
  );
  const body = JSON.parse(res.body);
  return { paymentId: body.paymentId, amount: body.totalAmount };
}

export default function (data) {
  const key = `${__VU}-${__ITER}-${Math.random().toString(36).slice(2)}`;
  const res = http.post(
    `${BASE}/payments/${data.paymentId}/refunds`,
    JSON.stringify({ amount: 1000 }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": key } },
  );
  check(res, { "201 or 422 (never 500)": (r) => r.status === 201 || r.status === 422 });
  if (res.status === 201) refunded.add(1);
  else if (res.status === 422) rejected.add(1);
}
