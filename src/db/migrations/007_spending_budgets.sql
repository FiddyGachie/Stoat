-- Migration 007: Spending budgets — pre-approved fund holds with micro-debit against allocation.
--
-- Flow:
--   1. User creates a spending_budget (pre-approval): amount, currency, mission scope.
--   2. User approves → a real PayPal order is created and the funds are authorized/captured
--      (PayPal hold). Status: awaiting_approval → approved → held → active.
--   3. Agents debit budget_debits (micro-payments) against the held allocation.
--      No new PayPal calls occur for each micro-payment; they run against the held balance.
--   4. A job monitors: if balance reaches 0 the budget is stopped and the mission pauses.
--   5. On mission completion (without depletion) a prompt is posted asking for refund or retain.
--   6. User responds → refund (PayPal refund of remainder) or retain (kept on account for reuse).

-- ── Spending Budgets ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spending_budgets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- who owns this budget (a user or a buyer agent)
  owner_id               UUID NOT NULL,
  owner_type             TEXT NOT NULL CHECK (owner_type IN ('user', 'agent')),
  -- what this budget is scoped to
  mission_id             UUID REFERENCES missions(id),
  -- pre-approved amount (what the user committed to spend)
  amount                 NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  currency               TEXT NOT NULL DEFAULT 'USD',
  -- the PayPal order created to hold the funds
  paypal_order_id        TEXT,
  paypal_capture_id      TEXT,
  paypal_environment     TEXT,
  approve_url            TEXT,
  -- running balance (starts at amount, decremented by debits)
  balance                NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  -- how much has been debited by micro-payments so far
  total_debited          NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (total_debited >= 0),
  -- status lifecycle
  status                 TEXT NOT NULL DEFAULT 'pending_approval'
                           CHECK (status IN (
                             'pending_approval',   -- waiting for user to approve in PayPal
                             'approved',           -- user approved; capture pending
                             'active',             -- funds held; agents may debit
                             'depleted',           -- balance reached 0; mission stopped
                             'completed',          -- mission finished with remaining balance
                             'awaiting_decision',  -- user prompted to refund or retain remainder
                             'refunded',           -- remainder returned to buyer via PayPal
                             'retained',           -- buyer chose to keep remainder on account
                             'cancelled',          -- pre-approval cancelled before activation
                             'failed'              -- PayPal capture or hold failed
                           )),
  -- where to send the user after PayPal approval
  return_origin          TEXT,
  -- when the budget was activated (funds on hold)
  activated_at           TIMESTAMPTZ,
  -- when the mission completed or depleted
  closed_at              TIMESTAMPTZ,
  -- idempotency for the PayPal order creation
  paypal_request_id      TEXT UNIQUE,
  failure_reason         TEXT,
  metadata               JSONB NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_spending_budgets_tenant  ON spending_budgets (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spending_budgets_mission ON spending_budgets (tenant_id, mission_id) WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spending_budgets_owner   ON spending_budgets (tenant_id, owner_id, owner_type);

-- ── Budget Debits (micro-payments counter against the allocation) ─────────────
-- Each row is one atomic debit: written by the agent or the platform when work is consumed.
-- No real PayPal call for each debit; they run against the pre-authorized balance.
CREATE TABLE IF NOT EXISTS budget_debits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  budget_id         UUID NOT NULL REFERENCES spending_budgets(id) ON DELETE CASCADE,
  -- who/what caused this debit
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('agent', 'system', 'user')),
  actor_id          UUID NOT NULL,
  -- what operation triggered the debit
  reason            TEXT NOT NULL,
  reference_type    TEXT,          -- e.g. 'agreement', 'mission_step'
  reference_id      UUID,
  -- amounts
  amount            NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  currency          TEXT NOT NULL DEFAULT 'USD',
  -- balance snapshot after this debit
  balance_after     NUMERIC(20, 6) NOT NULL CHECK (balance_after >= 0),
  -- agent run that caused this debit (for audit trail)
  agent_run_id      UUID REFERENCES agent_runs(id),
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_budget_debits_budget  ON budget_debits (budget_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_debits_actor   ON budget_debits (tenant_id, actor_id);

-- ── Budget Decision: what the user chose when prompted post-mission ───────────
CREATE TABLE IF NOT EXISTS budget_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  budget_id       UUID NOT NULL REFERENCES spending_budgets(id) ON DELETE CASCADE UNIQUE,
  decision        TEXT NOT NULL CHECK (decision IN ('refund', 'retain')),
  decided_by      UUID NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paypal_refund_id TEXT,
  refund_status   TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_decisions_budget ON budget_decisions (budget_id);
