import type { FastifyInstance } from "fastify";
import { refund } from "./refund.js";
import {
  PaymentNotFoundError,
  RefundError,
} from "./errors.js";
import {
  runIdempotent,
  IdempotencyKeyReuseError,
  IdempotencyInProgressError,
} from "../idempotency/idempotency.js";
import { isSerializationError } from "../db/pool.js";

const paramsSchema = {
  type: "object",
  required: ["paymentId"],
  additionalProperties: false,
  properties: { paymentId: { type: "integer", minimum: 1 } },
} as const;

const bodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { amount: { type: "integer", minimum: 1 } },
} as const;

const ENDPOINT = "POST /payments/:paymentId/refunds";

export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/payments/:paymentId/refunds",
    { schema: { params: paramsSchema, body: bodySchema } },
    async (req, reply) => {
      const { paymentId } = req.params as { paymentId: number };
      const body = (req.body as { amount?: number }) ?? {};

      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length === 0) {
        return reply
          .code(400)
          .send({ error: "MissingIdempotencyKey", message: "Idempotency-Key header is required." });
      }

      try {
        // Fold paymentId into the idempotency body so the same key can't be
        // reused across different payments and replay the wrong response.
        const outcome = await runIdempotent(
          { key, endpoint: ENDPOINT, body: { paymentId, ...body } },
          async (tx) => {
            const result = await refund(tx, { paymentId, amount: body.amount });
            return { status: 201, body: result };
          },
        );

        if (outcome.replayed) reply.header("idempotent-replayed", "true");
        return reply.code(outcome.status).send(outcome.body);
      } catch (err) {
        if (err instanceof PaymentNotFoundError) {
          return reply.code(404).send({ error: err.name, message: err.message });
        }
        if (err instanceof RefundError) {
          req.log.info({ err: err.message }, "refund rejected");
          return reply.code(422).send({ error: err.name, message: err.message });
        }
        if (err instanceof IdempotencyKeyReuseError) {
          return reply.code(422).send({ error: err.name, message: err.message });
        }
        if (err instanceof IdempotencyInProgressError) {
          return reply.code(409).send({ error: err.name, message: err.message });
        }
        if (isSerializationError(err)) {
          reply.header("retry-after", "1");
          return reply.code(503).send({ error: "TooMuchContention", message: "Please retry." });
        }
        throw err;
      }
    },
  );
}
