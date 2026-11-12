-- Migration 008: Mission Budget Wallet — tables and column changes.
--
-- Re-runnable: every statement uses IF NOT EXISTS or a guarded DO block.
-- All amounts are NUMERIC(20,6) with CHECK constraints.
-- Only PayPal is a supported provider (CHECK provider = 'paypal').
-- No agent-writable payee, recipient or payment-state columns are introduced:
-- payment facts come from PayPal-confirmed data written by deterministic services.

-- ── Wallets ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id      UUID NOT NULL REFERENCES users(id),
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  paypal_environment TEXT NOT NULL CHECK (paypal_environment IN ('sandbox', 'live')),
  -- block marker: a blocked wallet refuses new reservations and deposits
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  blocked_reason     TEXT,
  -- drift detector only; the balance is derived from journal lines on account 2103
  balance_cache      NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (balance_cache >= 0),
  last_activity_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_user_id, currency, paypal_environment),
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_wallets_owner ON wallets (tenant_id, owner_user_id);

-- ── Wallet deposits ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_deposits (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet_id               UUID NOT NULL,
  owner_user_id           UUID NOT NULL REFERENCES users(id),
  mission_id              UUID REFERENCES missions(id),
  is_top_up               BOOLEAN NOT NULL DEFAULT FALSE,
  provider                TEXT NOT NULL DEFAULT 'paypal' CHECK (provider = 'paypal'),
  amount                  NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  currency                TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN (
                            'creating', 'awaiting_approval', 'awaiting_capture', 'captured',
                            'mismatch', 'failed', 'cancelled', 'expired', 'creation_failed')),
  idempotency_key         TEXT NOT NULL,
  request_hash            TEXT NOT NULL,
  paypal_request_id       TEXT NOT NULL UNIQUE,
  paypal_order_id         TEXT UNIQUE,
  approve_url             TEXT,
  paypal_capture_id       TEXT UNIQUE,
  captured_amount         NUMERIC(20, 6) CHECK (captured_amount IS NULL OR captured_amount >= 0),
  captured_currency       TEXT,
  credited_amount         NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (credited_amount >= 0),
  paypal_fee              NUMERIC(20, 6) CHECK (paypal_fee IS NULL OR paypal_fee >= 0),
  captured_at             TIMESTAMPTZ,
  paypal_environment      TEXT NOT NULL CHECK (paypal_environment IN ('sandbox', 'live')),
  capture_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (capture_attempts >= 0),
  last_checked_at         TIMESTAMPTZ,
  failure_reason          TEXT,
  return_origin           TEXT,
  migrated_from_budget_id UUID UNIQUE,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id),
  UNIQUE (tenant_id, owner_user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_wallet_deposits_wallet  ON wallet_deposits (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_deposits_mission ON wallet_deposits (tenant_id, mission_id) WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_deposits_pending ON wallet_deposits (status, created_at)
  WHERE status IN ('creating', 'awaiting_approval', 'awaiting_capture');

-- ── Wallet reservations (exactly one per agreement) ───────────────────────────
CREATE TABLE IF NOT EXISTS wallet_reservations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet_id      UUID NOT NULL,
  mission_id     UUID NOT NULL REFERENCES missions(id),
  agreement_id   UUID NOT NULL UNIQUE REFERENCES agreements(id),
  amount         NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  currency       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'charged', 'released')),
  release_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_reservations_wallet  ON wallet_reservations (wallet_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_reservations_mission ON wallet_reservations (tenant_id, mission_id, status);

-- ── Wallet charges (idempotent by obligation) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_charges (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet_id              UUID NOT NULL,
  reservation_id         UUID NOT NULL UNIQUE REFERENCES wallet_reservations(id),
  obligation_id          UUID NOT NULL UNIQUE REFERENCES obligations(id),
  agreement_id           UUID NOT NULL UNIQUE REFERENCES agreements(id),
  mission_id             UUID NOT NULL REFERENCES missions(id),
  amount                 NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  released_difference    NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (released_difference >= 0),
  currency               TEXT NOT NULL,
  reason_code            TEXT NOT NULL,
  journal_transaction_id UUID REFERENCES journal_transactions(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_charges_wallet  ON wallet_charges (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_charges_mission ON wallet_charges (tenant_id, mission_id);

-- ── Remainder decisions (one per mission) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS remainder_decisions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mission_id       UUID NOT NULL UNIQUE REFERENCES missions(id),
  wallet_id        UUID NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('refund', 'keep')),
  remainder_amount NUMERIC(20, 6) NOT NULL CHECK (remainder_amount >= 0),
  refund_amount    NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  decided_by       UUID NOT NULL REFERENCES users(id),
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id)
);

-- ── Wallet refunds ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_refunds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet_id          UUID NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('remainder', 'unlinked', 'admin')),
  decision_id        UUID REFERENCES remainder_decisions(id),
  mission_id         UUID REFERENCES missions(id),
  amount             NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned', 'processing', 'completed', 'partially_completed', 'failed')),
  actor_user_id      UUID NOT NULL REFERENCES users(id),
  actor_role         TEXT NOT NULL,
  reason             TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  idempotency_key    TEXT NOT NULL,
  paypal_environment TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id),
  UNIQUE (tenant_id, wallet_id, idempotency_key),
  CHECK (kind <> 'admin' OR reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_wallet_refunds_wallet ON wallet_refunds (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_refund_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  refund_id              UUID NOT NULL REFERENCES wallet_refunds(id) ON DELETE CASCADE,
  deposit_id             UUID NOT NULL REFERENCES wallet_deposits(id),
  paypal_capture_id      TEXT NOT NULL,
  amount                 NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  status                 TEXT NOT NULL DEFAULT 'planned'
                           CHECK (status IN ('planned', 'submitted', 'pending', 'completed', 'failed')),
  paypal_request_id      TEXT NOT NULL UNIQUE,   -- sha256(groupId:captureId), deterministic
  paypal_refund_id       TEXT UNIQUE,
  paypal_status          TEXT,
  failure_reason         TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  journal_transaction_id UUID REFERENCES journal_transactions(id),
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (refund_id, deposit_id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_refund_items_deposit ON wallet_refund_items (deposit_id);
CREATE INDEX IF NOT EXISTS idx_wallet_refund_items_open ON wallet_refund_items (status, updated_at)
  WHERE status IN ('submitted', 'pending');

-- ── Mission funding state ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_funding (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mission_id    UUID NOT NULL UNIQUE REFERENCES missions(id),
  wallet_id     UUID NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  state         TEXT NOT NULL DEFAULT 'active'
                  CHECK (state IN ('active', 'depleted', 'awaiting_decision', 'closed')),
  shortfall     NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (shortfall >= 0),
  completed_at  TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_mission_funding_wallet ON mission_funding (wallet_id, state);

-- ── Notifications ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id),
  kind              TEXT NOT NULL CHECK (kind IN (
                      'deposit_captured', 'deposit_failed', 'deposit_mismatch', 'deposit_stuck',
                      'low_balance', 'depleted', 'topped_up', 'topup_incomplete',
                      'mission_completed', 'refund_completed', 'refund_failed',
                      'reconciliation_exception', 'trial_balance_mismatch', 'wallet_balance_mismatch')),
  title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body              TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  entity_type       TEXT,
  entity_id         UUID,
  event_id          TEXT NOT NULL,
  mission_id        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at           TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,   -- nullable: null until a shortfall update
  resolved_at       TIMESTAMPTZ,
  email_status      TEXT NOT NULL DEFAULT 'none' CHECK (email_status IN ('none', 'pending', 'sent', 'failed')),
  email_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (email_attempts >= 0 AND email_attempts <= 3),
  UNIQUE (recipient_user_id, event_id)
);
-- at most one unresolved low_balance notification per recipient and mission
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_open_low_balance
  ON notifications (recipient_user_id, mission_id) WHERE kind = 'low_balance' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_inbox ON notifications (recipient_user_id, created_at DESC);

-- ── Reconciliation ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trigger            TEXT NOT NULL CHECK (trigger IN ('schedule', 'admin')),
  requested_by       UUID REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'clean', 'differences', 'incomplete', 'failed')),
  paypal_environment TEXT NOT NULL,
  counts             JSONB NOT NULL DEFAULT '{}',
  trial_balance      JSONB NOT NULL DEFAULT '[]',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);
-- only one running reconciliation per tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_one_running
  ON reconciliation_runs (tenant_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_run_id    UUID NOT NULL REFERENCES reconciliation_runs(id),
  last_run_id     UUID NOT NULL REFERENCES reconciliation_runs(id),
  item_type       TEXT NOT NULL CHECK (item_type IN ('deposit', 'capture', 'refund', 'payout')),
  paypal_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('mismatch', 'unverifiable', 'stale')),
  currency        TEXT,
  stoat_amount    NUMERIC(20, 6),
  paypal_amount   NUMERIC(20, 6),
  difference      NUMERIC(20, 6),   -- signed: stoat - paypal
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at     TIMESTAMPTZ,
  resolved_run_id UUID REFERENCES reconciliation_runs(id),
  detail          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one open exception per item and kind
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_open_item
  ON reconciliation_exceptions (tenant_id, item_type, paypal_id, kind) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_tenant
  ON reconciliation_exceptions (tenant_id, status, created_at DESC);

-- ── Migration report for legacy spending budgets ──────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_migration_report (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id  UUID NOT NULL UNIQUE,
  outcome    TEXT NOT NULL CHECK (outcome IN ('migrated', 'skipped')),
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Changes to existing tables ────────────────────────────────────────────────
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS wallet_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_lines_wallet'
  ) THEN
    ALTER TABLE journal_lines
      ADD CONSTRAINT fk_journal_lines_wallet
      FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_journal_lines_wallet ON journal_lines (wallet_id) WHERE wallet_id IS NOT NULL;

-- ledger entry sequence
ALTER TABLE journal_transactions
  ADD COLUMN IF NOT EXISTS posting_seq BIGINT GENERATED BY DEFAULT AS IDENTITY;

-- wallet postings are idempotent by reference and by source event
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_wallet_reference
  ON journal_transactions (tenant_id, reference) WHERE reference LIKE 'wallet:%';
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_wallet_event
  ON journal_transactions (source_event_id) WHERE reference LIKE 'wallet:%';

-- migration link only; no behavior change for existing budgets
ALTER TABLE spending_budgets ADD COLUMN IF NOT EXISTS wallet_deposit_id UUID;

-- ══════════════════════════════════════════════════════════════════════════════
-- Database-enforced invariants (task 1.3)
-- Functions use CREATE OR REPLACE; triggers are dropped then recreated, so this
-- section is re-runnable. TRUNCATE is not row-level and is not intercepted.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Append-only tables: journal_lines, economic_events, audit_logs ───────────
CREATE OR REPLACE FUNCTION stoat_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION stoat_reject_mutation();

DROP TRIGGER IF EXISTS trg_economic_events_immutable ON economic_events;
CREATE TRIGGER trg_economic_events_immutable
  BEFORE UPDATE OR DELETE ON economic_events
  FOR EACH ROW EXECUTE FUNCTION stoat_reject_mutation();

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION stoat_reject_mutation();

-- ── journal_transactions: only posted -> reversed, never deleted ─────────────
CREATE OR REPLACE FUNCTION stoat_journal_transactions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on journal_transactions is not permitted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
    RAISE EXCEPTION 'journal_transactions may only change status from posted to reversed (% -> %)',
      OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'journal_transactions columns other than status are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_transactions_guard ON journal_transactions;
CREATE TRIGGER trg_journal_transactions_guard
  BEFORE UPDATE OR DELETE ON journal_transactions
  FOR EACH ROW EXECUTE FUNCTION stoat_journal_transactions_guard();

-- ── Deferred balance check on journal_lines (evaluated at COMMIT) ────────────
-- >= 2 lines, one currency, debits = credits, and every 2103 line carries one
-- wallet of the same tenant and currency.
CREATE OR REPLACE FUNCTION stoat_journal_lines_check() RETURNS trigger AS $$
DECLARE
  v_count      INTEGER;
  v_currencies INTEGER;
  v_debit      NUMERIC;
  v_credit     NUMERIC;
  v_code       TEXT;
  v_w_tenant   UUID;
  v_w_currency TEXT;
BEGIN
  SELECT count(*), count(DISTINCT currency), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_count, v_currencies, v_debit, v_credit
    FROM journal_lines WHERE transaction_id = NEW.transaction_id;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'journal transaction % has % line(s); at least 2 required', NEW.transaction_id, v_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_currencies <> 1 THEN
    RAISE EXCEPTION 'journal transaction % mixes currencies', NEW.transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'journal transaction % is unbalanced (debits % <> credits %)',
      NEW.transaction_id, v_debit, v_credit USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT account_code INTO v_code FROM accounts WHERE id = NEW.account_id;
  IF v_code = '2103' THEN
    IF NEW.wallet_id IS NULL THEN
      RAISE EXCEPTION 'journal line % on account 2103 must carry a wallet', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT tenant_id, currency INTO v_w_tenant, v_w_currency FROM wallets WHERE id = NEW.wallet_id;
    IF v_w_tenant IS DISTINCT FROM NEW.tenant_id OR v_w_currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'journal line % wallet must match line tenant and currency', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_lines_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stoat_journal_lines_check();

-- ── wallet_reservations: owner, currency, transitions ────────────────────────
CREATE OR REPLACE FUNCTION stoat_wallet_reservations_guard() RETURNS trigger AS $$
DECLARE
  v_wallet_owner    UUID;
  v_wallet_currency TEXT;
  v_wallet_tenant   UUID;
  v_mission_owner   UUID;
  v_agr_currency    TEXT;
  v_agr_mission     UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on wallet_reservations is not permitted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('charged', 'released')) THEN
      RAISE EXCEPTION 'wallet reservation transition % -> % is not permitted', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status <> 'active' AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'closed wallet reservation % is immutable', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.wallet_id <> OLD.wallet_id OR NEW.mission_id <> OLD.mission_id
       OR NEW.agreement_id <> OLD.agreement_id OR NEW.amount <> OLD.amount
       OR NEW.currency <> OLD.currency OR NEW.tenant_id <> OLD.tenant_id THEN
      RAISE EXCEPTION 'wallet reservation % identity and amount are immutable', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'wallet reservation must be created active'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT owner_user_id, currency, tenant_id INTO v_wallet_owner, v_wallet_currency, v_wallet_tenant
    FROM wallets WHERE id = NEW.wallet_id;
  SELECT a.owner_user_id INTO v_mission_owner
    FROM missions m JOIN agents a ON a.id = m.buyer_id
   WHERE m.id = NEW.mission_id AND m.tenant_id = NEW.tenant_id;
  SELECT currency, mission_id INTO v_agr_currency, v_agr_mission FROM agreements WHERE id = NEW.agreement_id;

  IF v_wallet_owner IS NULL OR v_mission_owner IS NULL OR v_wallet_owner <> v_mission_owner THEN
    RAISE EXCEPTION 'wallet owner must equal the mission owner'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_wallet_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'wallet tenant mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_agr_mission IS DISTINCT FROM NEW.mission_id THEN
    RAISE EXCEPTION 'agreement does not belong to the reservation mission'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_wallet_currency <> NEW.currency OR v_agr_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'wallet, reservation and agreement currencies must match'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_reservations_guard ON wallet_reservations;
CREATE TRIGGER trg_wallet_reservations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON wallet_reservations
  FOR EACH ROW EXECUTE FUNCTION stoat_wallet_reservations_guard();

-- ── wallet_charges: owner, currency, charge <= reservation ───────────────────
CREATE OR REPLACE FUNCTION stoat_wallet_charges_guard() RETURNS trigger AS $$
DECLARE
  v_wallet_owner    UUID;
  v_wallet_currency TEXT;
  v_mission_owner   UUID;
  v_agr_currency    TEXT;
  r                 wallet_reservations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on wallet_charges is not permitted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- the only permitted change links the journal transaction once
    IF OLD.journal_transaction_id IS NULL
       AND (to_jsonb(NEW) - 'journal_transaction_id') = (to_jsonb(OLD) - 'journal_transaction_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'wallet_charges are immutable except linking the journal transaction'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO r FROM wallet_reservations WHERE id = NEW.reservation_id;
  IF NOT FOUND OR r.wallet_id <> NEW.wallet_id OR r.mission_id <> NEW.mission_id
     OR r.agreement_id <> NEW.agreement_id OR r.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'wallet charge does not match its reservation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.amount > r.amount THEN
    RAISE EXCEPTION 'wallet charge % exceeds reservation %', NEW.amount, r.amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT owner_user_id, currency INTO v_wallet_owner, v_wallet_currency FROM wallets WHERE id = NEW.wallet_id;
  SELECT a.owner_user_id INTO v_mission_owner
    FROM missions m JOIN agents a ON a.id = m.buyer_id
   WHERE m.id = NEW.mission_id AND m.tenant_id = NEW.tenant_id;
  SELECT currency INTO v_agr_currency FROM agreements WHERE id = NEW.agreement_id;

  IF v_wallet_owner IS NULL OR v_mission_owner IS NULL OR v_wallet_owner <> v_mission_owner THEN
    RAISE EXCEPTION 'wallet owner must equal the mission owner'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_wallet_currency <> NEW.currency OR v_agr_currency IS DISTINCT FROM NEW.currency
     OR r.currency <> NEW.currency THEN
    RAISE EXCEPTION 'wallet, charge and agreement currencies must match'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_charges_guard ON wallet_charges;
CREATE TRIGGER trg_wallet_charges_guard
  BEFORE INSERT OR UPDATE OR DELETE ON wallet_charges
  FOR EACH ROW EXECUTE FUNCTION stoat_wallet_charges_guard();

-- ── wallet_deposits: terminal states ─────────────────────────────────────────
-- Terminal: captured, mismatch, failed, cancelled, expired, creation_failed.
-- After capture, credited_amount and the captured facts never change.
CREATE OR REPLACE FUNCTION stoat_wallet_deposits_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('captured', 'mismatch', 'failed', 'cancelled', 'expired', 'creation_failed')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'wallet deposit % is in terminal state % and cannot become %',
      OLD.id, OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'captured' AND (
       NEW.credited_amount  IS DISTINCT FROM OLD.credited_amount
    OR NEW.captured_amount  IS DISTINCT FROM OLD.captured_amount
    OR NEW.captured_currency IS DISTINCT FROM OLD.captured_currency
    OR NEW.paypal_capture_id IS DISTINCT FROM OLD.paypal_capture_id
    OR NEW.amount           IS DISTINCT FROM OLD.amount
    OR NEW.wallet_id        IS DISTINCT FROM OLD.wallet_id) THEN
    RAISE EXCEPTION 'captured wallet deposit % is immutable for amounts', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('mismatch', 'failed', 'cancelled', 'expired', 'creation_failed')
     AND NEW.credited_amount IS DISTINCT FROM OLD.credited_amount THEN
    RAISE EXCEPTION 'wallet deposit % in state % must never be credited', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_deposits_guard ON wallet_deposits;
CREATE TRIGGER trg_wallet_deposits_guard
  BEFORE UPDATE ON wallet_deposits
  FOR EACH ROW EXECUTE FUNCTION stoat_wallet_deposits_guard();

-- ── notifications: only mark-read, resolve, depletion shortfall update ───────
CREATE OR REPLACE FUNCTION stoat_notifications_guard() RETURNS trigger AS $$
DECLARE
  changed TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on notifications is not permitted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT COALESCE(array_agg(n.key), ARRAY[]::TEXT[]) INTO changed
    FROM jsonb_each(to_jsonb(NEW)) n
    JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
   WHERE n.value IS DISTINCT FROM o.value;

  -- 1. mark read (once)
  IF changed = ARRAY['read_at'] AND OLD.read_at IS NULL AND NEW.read_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 2. resolved marker (low balance, once)
  IF changed = ARRAY['resolved_at'] AND OLD.kind = 'low_balance'
     AND OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 3. depletion shortfall update: title/body change, read_at reset, updated_at set;
  --    email_status/email_attempts may be reset so a fresh email is sent (design R7.20).
  IF OLD.kind = 'depleted'
     AND changed <@ ARRAY['title', 'body', 'read_at', 'updated_at', 'email_status', 'email_attempts']
     AND (changed && ARRAY['title', 'body'])
     AND 'updated_at' = ANY (changed)
     AND NEW.updated_at IS NOT NULL
     AND NEW.read_at IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'notifications may only be marked read, resolved, or given a depletion shortfall update'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notifications_guard ON notifications;
CREATE TRIGGER trg_notifications_guard
  BEFORE UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION stoat_notifications_guard();

-- ══════════════════════════════════════════════════════════════════════════════
-- Legacy budget data mapping (task 1.4; R17.5 - R17.8)
-- Each statement is guarded (NOT EXISTS / ON CONFLICT DO NOTHING), so re-running
-- this file adds nothing. No PayPal call is made, no payout recipient is read or
-- set, and no journal line or journal transaction is updated or deleted: the
-- opening entries are new, balanced rows (Dr 2101 / Cr 2103). The deferred
-- balance trigger is satisfied because both lines of an entry are inserted by
-- one statement and the wallet is on every 2103 line.
-- ══════════════════════════════════════════════════════════════════════════════

-- Classify every legacy budget once. skip_reason IS NULL means "migrate".
DROP TABLE IF EXISTS _wm_budget;
CREATE TEMP TABLE _wm_budget AS
SELECT b.id, b.tenant_id, b.mission_id, b.status, b.amount, b.currency,
       b.balance, b.total_debited, b.paypal_capture_id, b.paypal_order_id,
       b.paypal_environment, b.activated_at, b.created_at, b.closed_at, b.updated_at,
       o.owner_user_id,
       CASE
         WHEN b.status NOT IN ('active', 'depleted', 'awaiting_decision', 'refunded', 'retained')
           THEN 'status_not_migratable:' || b.status
         WHEN b.paypal_capture_id IS NULL OR b.amount IS NULL OR b.amount <= 0
           THEN 'missing_captured_amount'
         WHEN o.owner_user_id IS NULL
           THEN 'owner_not_resolvable'
         WHEN b.currency IS NULL OR b.currency !~ '^[A-Z]{3}$'
           THEN 'currency_not_resolvable'
         WHEN b.paypal_environment IS NULL OR b.paypal_environment NOT IN ('sandbox', 'live')
           THEN 'paypal_environment_not_resolvable'
         ELSE NULL
       END AS skip_reason
  FROM spending_budgets b
  LEFT JOIN LATERAL (
    SELECT CASE b.owner_type
             WHEN 'user'  THEN (SELECT u.id FROM users u
                                 WHERE u.id = b.owner_id AND u.tenant_id = b.tenant_id)
             WHEN 'agent' THEN (SELECT u.id FROM agents a JOIN users u ON u.id = a.owner_user_id
                                 WHERE a.id = b.owner_id AND a.tenant_id = b.tenant_id
                                   AND u.tenant_id = b.tenant_id)
           END AS owner_user_id
  ) o ON TRUE;

-- Skipped rows: report the row ID and the reason, then carry on.
INSERT INTO wallet_migration_report (budget_id, outcome, reason)
SELECT m.id, 'skipped', m.skip_reason
  FROM _wm_budget m
 WHERE m.skip_reason IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM wallet_migration_report r WHERE r.budget_id = m.id)
ON CONFLICT (budget_id) DO NOTHING;

-- One wallet per tenant, Owner, currency and environment.
INSERT INTO wallets (tenant_id, owner_user_id, currency, paypal_environment)
SELECT DISTINCT m.tenant_id, m.owner_user_id, m.currency, m.paypal_environment
  FROM _wm_budget m
 WHERE m.skip_reason IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM wallets w
      WHERE w.tenant_id = m.tenant_id AND w.owner_user_id = m.owner_user_id
        AND w.currency = m.currency AND w.paypal_environment = m.paypal_environment)
ON CONFLICT (tenant_id, owner_user_id, currency, paypal_environment) DO NOTHING;

-- One captured deposit per migrated budget. captured_amount is the original
-- amount; credited_amount is the remaining balance (0 for refunded).
INSERT INTO wallet_deposits
  (tenant_id, wallet_id, owner_user_id, mission_id, is_top_up, provider, amount, currency, status,
   idempotency_key, request_hash, paypal_request_id, paypal_order_id, paypal_capture_id,
   captured_amount, captured_currency, credited_amount, captured_at, paypal_environment,
   migrated_from_budget_id, metadata)
SELECT m.tenant_id, w.id, m.owner_user_id, m.mission_id, FALSE, 'paypal', m.amount, m.currency, 'captured',
       'migrated-budget:' || m.id, 'migrated-budget:' || m.id, 'migrated-budget:' || m.id,
       m.paypal_order_id, m.paypal_capture_id,
       m.amount, m.currency,
       CASE WHEN m.status = 'refunded' THEN 0 ELSE m.balance END,
       COALESCE(m.activated_at, m.created_at), m.paypal_environment,
       m.id, jsonb_build_object('migrated_from', 'spending_budgets', 'legacy_status', m.status)
  FROM _wm_budget m
  JOIN wallets w ON w.tenant_id = m.tenant_id AND w.owner_user_id = m.owner_user_id
               AND w.currency = m.currency AND w.paypal_environment = m.paypal_environment
 WHERE m.skip_reason IS NULL
   AND NOT EXISTS (SELECT 1 FROM wallet_deposits d WHERE d.migrated_from_budget_id = m.id)
ON CONFLICT DO NOTHING;

-- Link the legacy budget to its deposit (migration link only).
UPDATE spending_budgets b
   SET wallet_deposit_id = d.id
  FROM wallet_deposits d
 WHERE d.migrated_from_budget_id = b.id AND b.wallet_deposit_id IS NULL;

-- Mission funding state: refunded and retained close; the rest keep their state.
INSERT INTO mission_funding
  (tenant_id, mission_id, wallet_id, owner_user_id, state, completed_at, closed_at)
SELECT DISTINCT ON (m.mission_id)
       m.tenant_id, m.mission_id, d.wallet_id, m.owner_user_id,
       CASE WHEN m.status IN ('refunded', 'retained') THEN 'closed' ELSE m.status END,
       CASE WHEN m.status IN ('refunded', 'retained', 'awaiting_decision')
            THEN COALESCE(m.closed_at, m.updated_at) END,
       CASE WHEN m.status IN ('refunded', 'retained')
            THEN COALESCE(m.closed_at, m.updated_at) END
  FROM _wm_budget m
  JOIN wallet_deposits d ON d.migrated_from_budget_id = m.id
 WHERE m.skip_reason IS NULL AND m.mission_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM mission_funding f WHERE f.mission_id = m.mission_id)
 ORDER BY m.mission_id, m.created_at, m.id
ON CONFLICT (mission_id) DO NOTHING;

-- Legacy PayPal refund: a completed refund item. The legacy refund amount was
-- amount - total_debited (the balance at decision time, since zeroed).
INSERT INTO wallet_refunds
  (tenant_id, wallet_id, kind, mission_id, amount, currency, status, actor_user_id, actor_role,
   reason, idempotency_key, paypal_environment, created_at, updated_at)
SELECT m.tenant_id, d.wallet_id, 'remainder', m.mission_id, m.amount - m.total_debited, m.currency,
       'completed', m.owner_user_id, 'migration', 'Migrated legacy budget refund',
       'migrated-budget-refund:' || m.id, m.paypal_environment, bd.decided_at, bd.decided_at
  FROM _wm_budget m
  JOIN wallet_deposits d ON d.migrated_from_budget_id = m.id
  JOIN budget_decisions bd ON bd.budget_id = m.id
 WHERE m.skip_reason IS NULL AND m.status = 'refunded'
   AND bd.decision = 'refund' AND bd.paypal_refund_id IS NOT NULL
   AND m.amount - m.total_debited > 0
   AND NOT EXISTS (SELECT 1 FROM wallet_refunds r
                    WHERE r.tenant_id = m.tenant_id AND r.wallet_id = d.wallet_id
                      AND r.idempotency_key = 'migrated-budget-refund:' || m.id)
ON CONFLICT DO NOTHING;

INSERT INTO wallet_refund_items
  (tenant_id, refund_id, deposit_id, paypal_capture_id, amount, status, paypal_request_id,
   paypal_refund_id, paypal_status, journal_transaction_id, completed_at)
SELECT m.tenant_id, r.id, d.id, m.paypal_capture_id, r.amount, 'completed',
       'budget-refund-' || m.id, bd.paypal_refund_id, bd.refund_status,
       (SELECT jt.id FROM journal_transactions jt
         WHERE jt.tenant_id = m.tenant_id AND jt.reference = 'budget-refund:' || m.id LIMIT 1),
       bd.decided_at
  FROM _wm_budget m
  JOIN wallet_deposits d ON d.migrated_from_budget_id = m.id
  JOIN wallet_refunds r ON r.tenant_id = m.tenant_id AND r.wallet_id = d.wallet_id
                       AND r.idempotency_key = 'migrated-budget-refund:' || m.id
  JOIN budget_decisions bd ON bd.budget_id = m.id
 WHERE m.skip_reason IS NULL
   AND NOT EXISTS (SELECT 1 FROM wallet_refund_items i WHERE i.refund_id = r.id AND i.deposit_id = d.id)
ON CONFLICT DO NOTHING;

-- Ledger accounts for the opening entries (created only where missing).
INSERT INTO accounts (tenant_id, account_code, name, normal_balance, currency)
SELECT DISTINCT d.tenant_id, c.code, c.name, c.normal_balance, d.currency
  FROM wallet_deposits d
 CROSS JOIN (VALUES ('2101', 'Customer funds held for agreements', 'credit'),
                    ('2103', 'Customer wallet funds held',         'credit')) AS c(code, name, normal_balance)
 WHERE d.migrated_from_budget_id IS NOT NULL AND d.credited_amount > 0
   AND NOT EXISTS (SELECT 1 FROM accounts a
                    WHERE a.tenant_id = d.tenant_id AND a.currency = d.currency AND a.account_code = c.code)
ON CONFLICT (tenant_id, currency, account_code) DO NOTHING;

-- Opening entry: one new transaction per migrated row with a remaining balance.
INSERT INTO journal_transactions (tenant_id, reference, status)
SELECT d.tenant_id, 'wallet:migration-opening:' || d.migrated_from_budget_id, 'posted'
  FROM wallet_deposits d
 WHERE d.migrated_from_budget_id IS NOT NULL AND d.credited_amount > 0
   AND NOT EXISTS (SELECT 1 FROM journal_transactions t
                    WHERE t.tenant_id = d.tenant_id
                      AND t.reference = 'wallet:migration-opening:' || d.migrated_from_budget_id)
ON CONFLICT DO NOTHING;

-- Dr 2101 / Cr 2103, both lines tagged with the wallet, in a single statement.
INSERT INTO journal_lines (tenant_id, transaction_id, account_id, debit, credit, currency, sequence, wallet_id)
SELECT d.tenant_id, t.id, a.id,
       CASE WHEN l.seq = 1 THEN d.credited_amount ELSE 0 END,
       CASE WHEN l.seq = 2 THEN d.credited_amount ELSE 0 END,
       d.currency, l.seq, d.wallet_id
  FROM wallet_deposits d
  JOIN journal_transactions t
    ON t.tenant_id = d.tenant_id AND t.reference = 'wallet:migration-opening:' || d.migrated_from_budget_id
 CROSS JOIN (VALUES (1, '2101'), (2, '2103')) AS l(seq, code)
  JOIN accounts a ON a.tenant_id = d.tenant_id AND a.currency = d.currency AND a.account_code = l.code
 WHERE d.migrated_from_budget_id IS NOT NULL AND d.credited_amount > 0
   AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id);

-- Wallet balance cache (drift detector) = 2103 credits - debits per wallet.
UPDATE wallets w
   SET balance_cache = x.bal, updated_at = now()
  FROM (SELECT jl.wallet_id, SUM(jl.credit - jl.debit) AS bal
          FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id AND a.account_code = '2103'
         WHERE jl.wallet_id IS NOT NULL
         GROUP BY jl.wallet_id) x
 WHERE x.wallet_id = w.id AND w.balance_cache IS DISTINCT FROM x.bal AND x.bal >= 0
   AND EXISTS (SELECT 1 FROM wallet_deposits d WHERE d.wallet_id = w.id AND d.migrated_from_budget_id IS NOT NULL);

-- Report: migrated rows, and eligible rows whose deposit could not be inserted.
INSERT INTO wallet_migration_report (budget_id, outcome, reason)
SELECT m.id,
       CASE WHEN d.id IS NOT NULL THEN 'migrated' ELSE 'skipped' END,
       CASE WHEN d.id IS NULL THEN 'deposit_conflict' END
  FROM _wm_budget m
  LEFT JOIN wallet_deposits d ON d.migrated_from_budget_id = m.id
 WHERE m.skip_reason IS NULL
   AND NOT EXISTS (SELECT 1 FROM wallet_migration_report r WHERE r.budget_id = m.id)
ON CONFLICT (budget_id) DO NOTHING;

DROP TABLE IF EXISTS _wm_budget;
