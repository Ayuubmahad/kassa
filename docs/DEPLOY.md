# Deploying Kassa

The app is a stateless container + a Postgres database. It applies the schema on start
(`node dist/db/migrate.js`) and serves on `$PORT` (default 3000). Set **`DB_SSL=true`** against
any managed Postgres.

## Option A — Render (blueprint, simplest)

1. Push this repo to GitHub (done).
2. Render dashboard → **New → Blueprint** → select this repo. It reads [`render.yaml`](../render.yaml)
   and provisions the web service + a Postgres, wiring `DATABASE_URL` automatically.
3. First request may cold-start (~30–60s) on the free plan; upgrade the web service to a paid
   instance (~$7/mo) for always-on during application season. Free Postgres expires after 90 days.

## Option B — Fly.io

```bash
fly launch --no-deploy          # accept the bundled fly.toml
fly postgres create             # provision Postgres
fly postgres attach <db-name>   # sets DATABASE_URL
fly secrets set DB_SSL=true
fly deploy                      # release_command runs the migration first
```

## Verify after deploy

```bash
curl https://<your-url>/health      # {"status":"ok"}
curl https://<your-url>/ready       # {"status":"ready"}  (DB reachable)
open  https://<your-url>/docs        # OpenAPI UI
curl https://<your-url>/audit/drift  # {"ok":true, ...}
```

## Notes

- **Never** wire a real payment provider — the payment step is simulated by design.
- The demo is write-enabled and rate-limited; a nightly job prunes idempotency keys and the
  scheduler re-checks the ledger invariant.
- Headline benchmark numbers come from local docker + k6 (see [LOAD-TESTING.md](LOAD-TESTING.md)),
  not the free-tier host — cold starts and shared CPU make cloud latency meaningless as a metric.
