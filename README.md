# Kassa

> Transaction-safe payments core for a marketplace: a **double-entry ledger** where debits always equal credits, **idempotent APIs** where retrying a checkout charges you once, and **provable correctness under concurrent load**.

The product surface is deliberately small. The engineering underneath is the point.

---

## What it does

- Records every money movement in an **append-only double-entry ledger** (`sum(debits) = sum(credits)`, always).
- Makes every mutating request **idempotent** via `Idempotency-Key` — replay the same checkout, get charged once.
- Handles concurrency (last-item races, double refunds) with DB transactions and row-level locking — *proven with load tests, not promises*.

## Architecture

_(diagram — Week 6)_

Core building blocks shipped so far:

| Piece | File |
| --- | --- |
| Double-entry schema (8 tables, constraints do the work) | [`db/schema.sql`](db/schema.sql) |
| The one balanced-posting function all money flows through | [`src/ledger/postEntries.ts`](src/ledger/postEntries.ts) |
| Single-client transaction helper (the node-postgres way) | [`src/db/pool.ts`](src/db/pool.ts) |
| The ledger-invariant test (project's first test) | [`test/ledger-invariant.test.ts`](test/ledger-invariant.test.ts) |

## Headline metrics (to be filled with real numbers)

1. **0 balance drift** across 10,000 concurrent transactions — _pending Week 4_
2. **p95 API latency < 150ms** under that load — _pending Week 4_
3. **100% refund-to-payment matching** in audit replay — _pending Week 5_
4. **Idempotency proven:** same checkout ×100 → exactly 1 charge — _pending Week 3_

## Technical decisions & trade-offs

- **Money is integer minor units (öre), never floats.** Floats silently lose cents; a payments core can't. Stored as `BIGINT`.
- **Balances are derived, not stored.** A mutable balance you can't recompute is drift you can't detect. A nightly invariant job (Week 5) re-sums everything.
- **Transactions use one checked-out client**, not `pool.query`, because node-postgres routes each `pool.query` to a possibly-different client — which would corrupt a multi-statement transaction. See `withTransaction`.
- _(isolation level + locking choice — documented in Week 4.)_

## Where it failed and what I learned

_(written the same day each bug happens — Weeks 4–6.)_

---

## Run it

### One command (Docker)

```bash
docker compose up --build
```

Brings up Postgres + the app, applies the schema, and serves on `http://localhost:3000`.
Health check: `GET /health` · Readiness (checks DB): `GET /ready`.

### Local dev

```bash
cp .env.example .env      # then edit if needed
npm install
docker compose up -d db   # just Postgres
npm run db:migrate        # apply db/schema.sql
npm run dev               # hot-reload server
npm test                  # run the test suite (needs the DB up)
```

## Tech stack

TypeScript · Node 22 · Fastify 5 · PostgreSQL 16 · Vitest · k6 (load tests, Week 4) · GitHub Actions CI

## Status

Week 1 — setup, schema, and the ledger invariant. See [`../projects roadmaps/kassa-roadmap.md`](../projects%20roadmaps/kassa-roadmap.md) for the full plan.
