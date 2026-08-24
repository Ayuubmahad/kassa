import type { FastifyInstance } from "fastify";
import { checkout, type CheckoutInput } from "./checkout.js";
import { CheckoutError } from "./errors.js";
import {
  runIdempotent,
  IdempotencyKeyReuseError,
  IdempotencyInProgressError,
} from "../idempotency/idempotency.js";
import { isSerializationError } from "../db/pool.js";

// Fastify v5 requires a full JSON schema (with `type`) for body/params/query.
// This both validates+sanitises input (security) and documents the endpoint.
const checkoutBodySchema = {
  type: "object",
  required: ["customerRef", "items"],
  additionalProperties: false,
  properties: {
    customerRef: { type: "string", minLength: 1, maxLength: 200 },
    currency: { type: "string", minLength: 3, maxLength: 3, default: "SEK" },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        required: ["sku", "quantity"],
        additionalProperties: false,
        properties: {
          sku: { type: "string", minLength: 1, maxLength: 100 },
          quantity: { type: "integer", minimum: 1, maximum: 10000 },
        },
      },
    },
  },
} as const;

const ENDPOINT = "POST /checkout";

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/checkout",
    { schema: { body: checkoutBodySchema } },
    async (req, reply) => {
      const body = req.body as CheckoutInput;

      // Checkout moves money, so an Idempotency-Key is mandatory: it's what makes
      // a retried request safe to send. Same key + same body ⇒ charged once.
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length === 0) {
        return reply
          .code(400)
          .send({ error: "MissingIdempotencyKey", message: "Idempotency-Key header is required." });
      }

      try {
        const outcome = await runIdempotent({ key, endpoint: ENDPOINT, body }, async (tx) => {
          const result = await checkout(tx, body);
          return { status: 201, body: result };
        });

        if (outcome.replayed) reply.header("idempotent-replayed", "true");
        return reply.code(outcome.status).send(outcome.body);
      } catch (err) {
        if (err instanceof CheckoutError) {
          req.log.info({ err: err.message }, "checkout rejected");
          return reply.code(422).send({ error: err.name, message: err.message });
        }
        if (err instanceof IdempotencyKeyReuseError) {
          return reply.code(422).send({ error: err.name, message: err.message });
        }
        if (err instanceof IdempotencyInProgressError) {
          return reply.code(409).send({ error: err.name, message: err.message });
        }
        if (isSerializationError(err)) {
          // Retries were exhausted under heavy contention — ask the client to retry.
          reply.header("retry-after", "1");
          return reply.code(503).send({ error: "TooMuchContention", message: "Please retry." });
        }
        throw err; // real failure → Fastify's 500 handler, logged with the req id
      }
    },
  );
}
