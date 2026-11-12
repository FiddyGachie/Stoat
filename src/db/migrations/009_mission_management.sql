-- 009: mission management (edit / delete / replay) and the permanent results archive.
--
-- * missions.deleted_at, missions.replay_of: a deleted mission keeps its row and history
--   (status 'deleted'); a replay points at the completed mission it repeats.
-- * mission_results: one append-only record per verified agreement, written when its mission
--   completes (and backfilled on first read). It keeps what was delivered for future reference
--   even if the provider, service or mission later changes. Never updated or deleted.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS replay_of UUID REFERENCES missions(id);
CREATE INDEX IF NOT EXISTS idx_missions_replay_of ON missions (replay_of) WHERE replay_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS mission_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mission_id       UUID NOT NULL REFERENCES missions(id),
  agreement_id     UUID NOT NULL UNIQUE REFERENCES agreements(id),
  delivery_id      UUID,
  provider_id      UUID,
  provider_name    TEXT,
  mission_title    TEXT NOT NULL,
  mission_brief    TEXT,
  replay_of        UUID,
  price            NUMERIC(20, 6),
  charged          NUMERIC(20, 6),
  currency         TEXT,
  summary          TEXT,
  findings         JSONB NOT NULL DEFAULT '[]',
  findings_count   INTEGER NOT NULL DEFAULT 0 CHECK (findings_count >= 0),
  severity_counts  JSONB NOT NULL DEFAULT '{}',
  files_reviewed   JSONB,
  artifact_hash    TEXT,
  verified_by      TEXT,
  model            TEXT,
  archived_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mission_results_tenant ON mission_results (tenant_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_results_mission ON mission_results (mission_id);

-- Append-only, like the ledger and economic events (stoat_reject_mutation from migration 008).
DROP TRIGGER IF EXISTS trg_mission_results_append_only ON mission_results;
CREATE TRIGGER trg_mission_results_append_only
  BEFORE UPDATE OR DELETE ON mission_results
  FOR EACH ROW EXECUTE FUNCTION stoat_reject_mutation();
