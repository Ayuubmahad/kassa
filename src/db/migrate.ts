// Applies db/schema.sql against DATABASE_URL. Idempotent: safe to run repeatedly.
// Usage: npm run db:migrate
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pool, closePool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate(): Promise<void> {
  // schema.sql lives at <repo>/db/schema.sql; this file compiles to <repo>/dist/db/migrate.js
  // and runs from <repo>/src/db/migrate.ts in dev, so resolve relative to cwd for both.
  const schemaPath = resolve(process.cwd(), "db", "schema.sql");
  const sql = await readFile(schemaPath, "utf8");
  await pool.query(sql);
  // eslint-disable-next-line no-console
  console.log(`[migrate] applied ${schemaPath}`);
}

migrate()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("[migrate] failed:", err);
    await closePool();
    process.exit(1);
  });
