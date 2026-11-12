CREATE TABLE IF NOT EXISTS insight_narratives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id),
  scope_owner_user_id UUID REFERENCES users(id),
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  digest JSONB NOT NULL,
  digest_hash TEXT NOT NULL,
  narrative JSONB NOT NULL,
  schema_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}',
  llm_mode TEXT NOT NULL,
  replayed BOOLEAN NOT NULL DEFAULT FALSE,
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nl_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  question_text TEXT NOT NULL CHECK (char_length(question_text) BETWEEN 1 AND 500),
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','intent','unsupported','invalid','error')),
  intent_name TEXT,
  intent_version TEXT,
  params JSONB,
  prompt_hash TEXT,
  model_id TEXT,
  llm_mode TEXT,
  replayed BOOLEAN,
  agent_run_id UUID,
  row_count INTEGER,
  truncated BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nl_questions_rate
  ON nl_questions (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_charges_tenant_created
  ON wallet_charges (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_reservations_tenant_created
  ON wallet_reservations (tenant_id, created_at);

CREATE OR REPLACE FUNCTION stoat_nl_questions_guard_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Natural language questions cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome <> 'pending' THEN
    RAISE EXCEPTION 'Only pending questions may be updated' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stoat_nl_questions_guard ON nl_questions;
CREATE TRIGGER stoat_nl_questions_guard
  BEFORE UPDATE OR DELETE ON nl_questions
  FOR EACH ROW EXECUTE FUNCTION stoat_nl_questions_guard_fn();
