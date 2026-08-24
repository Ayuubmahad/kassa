import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

// Validate environment at startup — fail fast and loud, never boot half-configured.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // How often the background audit re-sums the ledger. Default 24h ("nightly").
  AUDIT_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  // Kassa is single-currency by design. Requests in any other currency are
  // rejected so foreign-currency legs can never enter the (base-currency) accounts.
  BASE_CURRENCY: z.string().length(3).default("SEK"),
  // Rate limiting for the public demo (per IP).
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Don't leak values — only which keys are wrong.
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;
