CREATE TABLE IF NOT EXISTS proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  proposal_type TEXT NOT NULL CHECK (proposal_type IN
    ('topup_suggestion','remainder_refund','payout_batch','mandate_change','hold_release')),
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','approved','rejected','expired','executed','execution_failed','invalid')),
  subject_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  display_amount_hint NUMERIC(20,6) CHECK
    (display_amount_hint IS NULL OR (display_amount_hint > 0 AND display_amount_hint <= 999999999.99)),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 500),
  source TEXT NOT NULL CHECK (source IN ('model','tool')),
  proposer_agent_id UUID NOT NULL REFERENCES agents(id),
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id),
  prompt_hash TEXT,
  model_id TEXT,
  parameters JSONB NOT NULL DEFAULT '{}',
  validation_decision JSONB NOT NULL,
  decider_scope TEXT NOT NULL CHECK (decider_scope IN ('owner','admin')),
  owner_user_id UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_by UUID REFERENCES users(id),
  decided_role TEXT,
  decided_at TIMESTAMPTZ,
  decision_comment TEXT CHECK (decision_comment IS NULL OR char_length(decision_comment) <= 500),
  rejection_reason TEXT CHECK (rejection_reason IS NULL OR char_length(rejection_reason) BETWEEN 1 AND 500),
  execution_attempts INTEGER NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ,
  execution_result_code TEXT,
  execution_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source = 'tool' OR (prompt_hash IS NOT NULL AND model_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_proposals_pending_subject
  ON proposals (tenant_id, proposal_type, subject_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_proposals_inbox ON proposals (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_owner ON proposals (tenant_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_rate ON proposals (tenant_id, proposer_agent_id, created_at);

CREATE TABLE IF NOT EXISTS proposal_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL REFERENCES proposals(id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','agent','system')),
  principal_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN
    ('submitted','invalid','approved','rejected','expired','executed','execution_failed','refused')),
  reason_codes JSONB NOT NULL DEFAULT '[]',
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposal_decisions_proposal ON proposal_decisions (proposal_id, created_at);
DROP TRIGGER IF EXISTS trg_proposal_decisions_immutable ON proposal_decisions;
CREATE TRIGGER trg_proposal_decisions_immutable
  BEFORE UPDATE OR DELETE ON proposal_decisions
  FOR EACH ROW EXECUTE FUNCTION stoat_reject_mutation();

CREATE OR REPLACE FUNCTION stoat_proposals_guard_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Proposals cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.tenant_id, NEW.proposal_type, NEW.schema_version, NEW.subject_key, NEW.payload,
         NEW.display_amount_hint, NEW.rationale, NEW.source, NEW.proposer_agent_id,
         NEW.agent_run_id, NEW.prompt_hash, NEW.model_id, NEW.parameters,
         NEW.validation_decision, NEW.decider_scope, NEW.owner_user_id, NEW.expires_at,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.proposal_type, OLD.schema_version, OLD.subject_key, OLD.payload,
         OLD.display_amount_hint, OLD.rationale, OLD.source, OLD.proposer_agent_id,
         OLD.agent_run_id, OLD.prompt_hash, OLD.model_id, OLD.parameters,
         OLD.validation_decision, OLD.decider_scope, OLD.owner_user_id, OLD.expires_at,
         OLD.created_at) THEN
    RAISE EXCEPTION 'Proposal payload and provenance are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved','rejected','expired','invalid'))
    OR (OLD.status = 'approved' AND NEW.status IN ('executed','execution_failed'))
  ) THEN
    RAISE EXCEPTION 'Invalid Proposal status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stoat_proposals_guard ON proposals;
CREATE TRIGGER stoat_proposals_guard
  BEFORE UPDATE OR DELETE ON proposals
  FOR EACH ROW EXECUTE FUNCTION stoat_proposals_guard_fn();
