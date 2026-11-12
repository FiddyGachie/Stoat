-- Provider payouts through the PayPal Payouts API.

-- Where each provider agent is paid. Set by the agent's owner, never by the agent itself.
CREATE TABLE IF NOT EXISTS provider_payout_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  paypal_email TEXT NOT NULL,
  set_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id)
);

-- One payout per provider per settlement batch.
CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES settlement_batches(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  paypal_email TEXT NOT NULL,
  amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  -- requested | processing | paid | failed | returned
  sender_batch_id TEXT NOT NULL UNIQUE,
  provider_batch_id TEXT,
  provider_item_id TEXT,
  provider_item_status TEXT,
  failure_reason TEXT,
  requested_by UUID,
  last_checked_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A provider is paid at most once per batch unless the earlier attempt failed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_live
  ON payouts (batch_id, agent_id)
  WHERE status IN ('requested', 'processing', 'paid');
