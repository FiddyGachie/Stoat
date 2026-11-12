ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agents_owner_user
  ON agents (tenant_id, owner_user_id, created_at DESC);
