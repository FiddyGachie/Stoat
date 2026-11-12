CREATE TABLE IF NOT EXISTS mandates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  per_agreement_max NUMERIC(20,6) NOT NULL CHECK (per_agreement_max >= 0.01),
  daily_cap NUMERIC(20,6) NOT NULL CHECK (daily_cap >= 0.01),
  total_cap NUMERIC(20,6) NOT NULL CHECK (total_cap >= 0.01),
  allowed_categories TEXT[] NOT NULL CHECK (cardinality(allowed_categories) BETWEEN 1 AND 20),
  mission_scope UUID[] CHECK (mission_scope IS NULL OR cardinality(mission_scope) BETWEEN 1 AND 50),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','revoked','exhausted','suspended')),
  terms_hash TEXT NOT NULL,
  signed_by UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revoked_by UUID REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  suspended_by_alert_id UUID,
  suspension_lifted_by UUID REFERENCES users(id),
  suspension_lifted_at TIMESTAMPTZ,
  suspension_lift_reason TEXT
    CHECK (suspension_lift_reason IS NULL OR char_length(suspension_lift_reason) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, tenant_id) REFERENCES wallets (id, tenant_id),
  UNIQUE (tenant_id, owner_user_id, idempotency_key),
  CHECK (per_agreement_max <= daily_cap AND daily_cap <= total_cap)
);
CREATE INDEX IF NOT EXISTS idx_mandates_owner ON mandates (tenant_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_mandates_expiry ON mandates (expires_at)
  WHERE status IN ('active','exhausted','suspended');

ALTER TABLE wallet_reservations ADD COLUMN IF NOT EXISTS mandate_id UUID REFERENCES mandates(id);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS mandate_id UUID REFERENCES mandates(id);
CREATE INDEX IF NOT EXISTS idx_wallet_reservations_mandate
  ON wallet_reservations (mandate_id, status, created_at) WHERE mandate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mandate_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mandate_id UUID NOT NULL REFERENCES mandates(id),
  quote_id UUID NOT NULL REFERENCES quotes(id),
  agreement_id UUID NOT NULL UNIQUE REFERENCES agreements(id),
  reservation_id UUID NOT NULL UNIQUE REFERENCES wallet_reservations(id),
  agent_run_id UUID,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mandate_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_mandate_acceptances_quote
  ON mandate_acceptances (tenant_id, quote_id);

CREATE OR REPLACE FUNCTION stoat_mandates_guard_fn() RETURNS trigger AS $$
DECLARE
  wallet_owner UUID;
  wallet_tenant UUID;
  wallet_currency TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Mandates cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT owner_user_id, tenant_id, currency
      INTO wallet_owner, wallet_tenant, wallet_currency
      FROM wallets WHERE id = NEW.wallet_id;
    IF wallet_owner IS DISTINCT FROM NEW.owner_user_id
       OR wallet_tenant IS DISTINCT FROM NEW.tenant_id
       OR upper(wallet_currency) IS DISTINCT FROM upper(NEW.currency) THEN
      RAISE EXCEPTION 'Mandate wallet owner, tenant, or currency mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.tenant_id, NEW.owner_user_id, NEW.wallet_id, NEW.currency,
         NEW.per_agreement_max, NEW.daily_cap, NEW.total_cap, NEW.allowed_categories,
         NEW.mission_scope, NEW.expires_at, NEW.terms_hash, NEW.signed_by,
         NEW.idempotency_key, NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.owner_user_id, OLD.wallet_id, OLD.currency,
         OLD.per_agreement_max, OLD.daily_cap, OLD.total_cap, OLD.allowed_categories,
         OLD.mission_scope, OLD.expires_at, OLD.terms_hash, OLD.signed_by,
         OLD.idempotency_key, OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'Mandate terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status IN ('exhausted','suspended','revoked','expired'))
    OR (OLD.status = 'exhausted' AND NEW.status IN ('active','suspended','revoked','expired'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('active','exhausted','revoked','expired'))
  ) THEN
    RAISE EXCEPTION 'Invalid Mandate status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stoat_mandates_guard ON mandates;
CREATE TRIGGER stoat_mandates_guard
  BEFORE INSERT OR UPDATE OR DELETE ON mandates
  FOR EACH ROW EXECUTE FUNCTION stoat_mandates_guard_fn();

CREATE OR REPLACE FUNCTION stoat_wallet_reservations_mandate_guard_fn() RETURNS trigger AS $$
DECLARE
  m mandates%ROWTYPE;
  agreement_mandate UUID;
  used_total NUMERIC(20,6);
  used_today NUMERIC(20,6);
BEGIN
  IF NEW.mandate_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO m FROM mandates WHERE id = NEW.mandate_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'active' OR m.expires_at <= now()
     OR m.wallet_id <> NEW.wallet_id OR upper(m.currency) <> upper(NEW.currency)
     OR NEW.amount > m.per_agreement_max THEN
    RAISE EXCEPTION 'Reservation is outside Mandate terms' USING ERRCODE = '23514';
  END IF;
  SELECT mandate_id INTO agreement_mandate FROM agreements
    WHERE id = NEW.agreement_id AND tenant_id = NEW.tenant_id;
  IF agreement_mandate IS DISTINCT FROM NEW.mandate_id THEN
    RAISE EXCEPTION 'Agreement Mandate mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO used_total FROM wallet_reservations
    WHERE mandate_id = NEW.mandate_id AND status IN ('active','charged');
  SELECT COALESCE(SUM(amount), 0) INTO used_today FROM wallet_reservations
    WHERE mandate_id = NEW.mandate_id AND status IN ('active','charged')
      AND created_at >= ((date_trunc('day', now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC');
  IF used_total + NEW.amount > m.total_cap OR used_today + NEW.amount > m.daily_cap THEN
    RAISE EXCEPTION 'Reservation exceeds Mandate cap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_wallet_reservations_mandate_guard ON wallet_reservations;
CREATE TRIGGER trg_wallet_reservations_mandate_guard
  BEFORE INSERT ON wallet_reservations
  FOR EACH ROW EXECUTE FUNCTION stoat_wallet_reservations_mandate_guard_fn();

CREATE OR REPLACE FUNCTION stoat_wallet_reservations_mandate_immutable_fn() RETURNS trigger AS $$
BEGIN
  IF NEW.mandate_id IS DISTINCT FROM OLD.mandate_id THEN
    RAISE EXCEPTION 'Reservation Mandate is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_wallet_reservations_mandate_immutable ON wallet_reservations;
CREATE TRIGGER trg_wallet_reservations_mandate_immutable
  BEFORE UPDATE OF mandate_id ON wallet_reservations
  FOR EACH ROW EXECUTE FUNCTION stoat_wallet_reservations_mandate_immutable_fn();
