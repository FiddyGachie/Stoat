ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tool_set TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS correlation_id UUID;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS principal_hash TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS principal_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_agent_runs_cost_day ON agent_runs (tenant_id, role, created_at);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'deposit_captured','deposit_failed','deposit_mismatch','deposit_stuck','low_balance','depleted',
  'topped_up','topup_incomplete','mission_completed','refund_completed','refund_failed',
  'reconciliation_exception','trial_balance_mismatch','wallet_balance_mismatch',
  'mandate_exhausted','watchdog_alert','detector_error','proposal_execution_failed',
  'agent_integrity_violation','model_budget_reached','held_accrual_stuck'
));

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_time
  ON audit_logs (tenant_id, actor_id, created_at DESC);

ALTER TABLE commercial_proposals DROP CONSTRAINT IF EXISTS commercial_proposals_proposal_type_check;
ALTER TABLE commercial_proposals ADD CONSTRAINT commercial_proposals_proposal_type_check
  CHECK (proposal_type IN ('OFFER_COMPARISON','COUNTEROFFER','SELECTION','MANDATE_SELECTION'));
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS mandate_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_alert_explanation
  ON llm_proposals (decision_reference) WHERE proposal_type = 'alert_explanation';
