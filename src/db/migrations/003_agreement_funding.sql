-- Agreement funding: the buyer pays through PayPal when a quote is accepted.
-- One row per PayPal order attempt. An agreement has at most one live row.

ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS funding_status TEXT NOT NULL DEFAULT 'unfunded';
-- unfunded | awaiting_payment | funded | refunded

CREATE TABLE IF NOT EXISTS agreement_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agreement_id UUID NOT NULL REFERENCES agreements(id),
  provider TEXT NOT NULL DEFAULT 'paypal',
  provider_order_id TEXT NOT NULL UNIQUE,
  provider_capture_id TEXT,
  provider_refund_id TEXT,
  amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  -- awaiting_payment | captured | mismatch | failed | expired | refunded
  approve_url TEXT,
  environment TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  captured_amount NUMERIC(20, 6),
  captured_currency TEXT,
  last_checked_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  failure_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one order may be waiting for or holding money per agreement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_payments_live
  ON agreement_payments (agreement_id)
  WHERE status IN ('awaiting_payment', 'captured', 'mismatch');

CREATE INDEX IF NOT EXISTS idx_agreement_payments_tenant_status
  ON agreement_payments (tenant_id, status);
