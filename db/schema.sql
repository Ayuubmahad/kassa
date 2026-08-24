-- KASSA schema — payments core with an append-only double-entry ledger.
--
-- Design rules baked into this schema:
--   * Money is ALWAYS integer minor units (öre/cents) stored as BIGINT. Never floats.
--   * The ledger is append-only: entries are inserted, never updated or deleted.
--   * Every money movement is a "ledger transaction" made of >= 2 balanced entries
--     (sum of debits = sum of credits), written atomically or not at all.
--   * Balances are DERIVED from entries, never stored as mutable truth.
--   * Idempotency keys make every mutating request safe to retry.
--
-- Idempotent to run: uses IF NOT EXISTS / enum guards so `db:migrate` can re-apply.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE account_type AS ENUM ('asset', 'liability', 'revenue', 'expense', 'equity');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE entry_direction AS ENUM ('debit', 'credit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'cancelled', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'declined', 'refunded', 'partially_refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE refund_status AS ENUM ('pending', 'succeeded', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,           -- e.g. 'cash', 'merchant_payable'
  name        TEXT        NOT NULL,
  type        account_type NOT NULL,
  currency    CHAR(3)     NOT NULL DEFAULT 'SEK',    -- ISO 4217
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ledger: transactions (header) + entries (legs). APPEND-ONLY.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_transactions (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT        NOT NULL,                  -- 'checkout', 'refund', 'payout', ...
  reference   TEXT,                                  -- free-form link to a business event
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  BIGINT          NOT NULL REFERENCES ledger_transactions(id),
  account_id      BIGINT          NOT NULL REFERENCES accounts(id),
  direction       entry_direction NOT NULL,
  amount          BIGINT          NOT NULL CHECK (amount > 0),  -- minor units, always positive
  currency        CHAR(3)         NOT NULL DEFAULT 'SEK',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_txn     ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);

-- ---------------------------------------------------------------------------
-- Commerce: orders / items / inventory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id            BIGSERIAL PRIMARY KEY,
  customer_ref  TEXT         NOT NULL,
  status        order_status NOT NULL DEFAULT 'pending',
  currency      CHAR(3)      NOT NULL DEFAULT 'SEK',
  total_amount  BIGINT       NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory (
  sku           TEXT PRIMARY KEY,
  name          TEXT   NOT NULL,
  unit_price    BIGINT NOT NULL CHECK (unit_price >= 0),  -- minor units
  available_qty INTEGER NOT NULL CHECK (available_qty >= 0),
  reserved_qty  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT  NOT NULL REFERENCES orders(id),
  sku         TEXT    NOT NULL REFERENCES inventory(sku),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  BIGINT  NOT NULL CHECK (unit_price >= 0),   -- snapshot at order time
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ---------------------------------------------------------------------------
-- Payments + refunds. Refund links back to its payment (the audit requirement).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                    BIGSERIAL PRIMARY KEY,
  order_id              BIGINT         NOT NULL REFERENCES orders(id),
  amount                BIGINT         NOT NULL CHECK (amount > 0),
  currency              CHAR(3)        NOT NULL DEFAULT 'SEK',
  status                payment_status NOT NULL DEFAULT 'pending',
  ledger_transaction_id BIGINT         REFERENCES ledger_transactions(id),
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS refunds (
  id                    BIGSERIAL PRIMARY KEY,
  payment_id            BIGINT        NOT NULL REFERENCES payments(id),
  amount                BIGINT        NOT NULL CHECK (amount > 0),
  currency              CHAR(3)       NOT NULL DEFAULT 'SEK',
  status                refund_status NOT NULL DEFAULT 'pending',
  ledger_transaction_id BIGINT        REFERENCES ledger_transactions(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);

-- ---------------------------------------------------------------------------
-- Idempotency: one stored response per (key, endpoint). Replay returns it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT        NOT NULL,
  endpoint        TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,              -- guards against key reuse w/ different body
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (defense in depth). Application code only ever INSERTs
-- into the ledger, but nothing structural stopped a future code path from
-- UPDATE/DELETE-ing it. These triggers make mutation impossible at the DB level.
-- Note: row-level DELETE triggers do NOT fire on TRUNCATE, so test resets still work.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kassa_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION kassa_forbid_mutation();

CREATE OR REPLACE TRIGGER trg_ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION kassa_forbid_mutation();
