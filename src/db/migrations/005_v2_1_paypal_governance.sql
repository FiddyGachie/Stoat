-- Stoat v2.1: PayPal-only invariant, recipient profiles, bound payout approvals, negotiation trace.
-- Forward-only. Existing Orders records are classified as BUYER_COLLECTION; no payout id is backfilled.

-- ── PayPal-only: every real payment row must be PayPal ───────────────────────
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'BUYER_COLLECTION';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_transactions_paypal_only') THEN
    ALTER TABLE payment_transactions ADD CONSTRAINT chk_payment_transactions_paypal_only CHECK (lower(provider) = 'paypal');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_transactions_direction') THEN
    ALTER TABLE payment_transactions ADD CONSTRAINT chk_payment_transactions_direction CHECK (direction IN ('BUYER_COLLECTION', 'PROVIDER_DISBURSEMENT', 'REFUND'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_agreement_payments_paypal_only') THEN
    ALTER TABLE agreement_payments ADD CONSTRAINT chk_agreement_payments_paypal_only CHECK (lower(provider) = 'paypal');
  END IF;
END $$;

-- ── Negotiation trace ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commercial_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mission_id UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  quote_id UUID REFERENCES quotes(id),
  agent_run_id UUID,
  proposal_type TEXT NOT NULL CHECK (proposal_type IN ('OFFER_COMPARISON', 'COUNTEROFFER', 'SELECTION')),
  schema_version TEXT NOT NULL DEFAULT '1.0',
  payload JSONB NOT NULL,
  prompt_hash TEXT,
  model_id TEXT,
  llm_mode TEXT,
  deterministic_validation TEXT NOT NULL DEFAULT 'pending',   -- pending | passed | rejected
  reason_codes JSONB NOT NULL DEFAULT '[]',
  decision_reason TEXT,
  accepted_agreement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commercial_proposals_mission ON commercial_proposals (tenant_id, mission_id, created_at);

ALTER TABLE agreements ADD COLUMN IF NOT EXISTS commercial_proposal_id UUID REFERENCES commercial_proposals(id);

-- A provider says how far a price may be negotiated down. NULL means the listed price is final.
ALTER TABLE services ADD COLUMN IF NOT EXISTS min_price NUMERIC(20, 6);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_services_min_price') THEN
    ALTER TABLE services ADD CONSTRAINT chk_services_min_price CHECK (min_price IS NULL OR (min_price > 0 AND min_price <= unit_price));
  END IF;
END $$;

-- ── Provider PayPal recipient profiles (encrypted, masked, human verified) ───
-- Replaces the earlier plaintext provider_payout_accounts table, which never held production data.
DROP TABLE IF EXISTS provider_payout_accounts;

CREATE TABLE IF NOT EXISTS provider_paypal_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('EMAIL', 'PHONE', 'PAYPAL_ID')),
  recipient_ciphertext TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,            -- keyed hash (HMAC); plaintext is never indexed
  recipient_masked TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verification_source TEXT,
  consent_at TIMESTAMPTZ NOT NULL,
  set_by UUID NOT NULL,
  verified_by UUID,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_paypal_recipient
  ON provider_paypal_profiles (tenant_id, recipient_hash) WHERE verification_status <> 'rejected';

-- ── Payouts: snapshot the recipient at approval, never store it in plaintext ─
ALTER TABLE payouts DROP COLUMN IF EXISTS paypal_email;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'paypal';
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS recipient_profile_id UUID;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS recipient_type TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS recipient_snapshot_ciphertext TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS recipient_snapshot_hash TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS recipient_masked TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS approval_id UUID;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS obligation_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS sender_item_id TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS error_code TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payouts_paypal_only') THEN
    ALTER TABLE payouts ADD CONSTRAINT chk_payouts_paypal_only CHECK (lower(provider) = 'paypal');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_sender_item ON payouts (sender_item_id) WHERE sender_item_id IS NOT NULL;

-- ── Approvals bound to exactly what the human saw ────────────────────────────
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS transaction_direction TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS amount NUMERIC(20, 6);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS recipient_snapshot_hash TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS obligation_ids_hash TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS policy_version TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
