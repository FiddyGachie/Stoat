CREATE TABLE IF NOT EXISTS watchdog_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  detector TEXT NOT NULL CHECK (detector IN ('spend_spike','price_outlier','repeated_revision',
    'unusual_provider','wallet_depleting','reconciliation_exception')),
  detector_version TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('wallet','mandate','agreement','reconciliation_exception')),
  subject_id UUID NOT NULL,
  mandate_id UUID,
  owner_user_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  evidence JSONB NOT NULL,
  clear_streak INTEGER NOT NULL DEFAULT 0,
  response TEXT NOT NULL DEFAULT 'none' CHECK (response IN ('none','hold','suspend_mandate')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchdog_open_alert
  ON watchdog_alerts (tenant_id, detector, subject_type, subject_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_watchdog_alerts_list
  ON watchdog_alerts (tenant_id, status, severity, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS watchdog_thresholds (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  detector TEXT NOT NULL,
  params JSONB NOT NULL,
  response TEXT NOT NULL DEFAULT 'none' CHECK (response IN ('none','hold','suspend_mandate')),
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, detector)
);

CREATE TABLE IF NOT EXISTS watchdog_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','timeout')),
  counters JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_watchdog_runs_tenant ON watchdog_runs (tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS watchdog_detector_state (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  detector TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, detector)
);

ALTER TABLE holds ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE holds ADD COLUMN IF NOT EXISTS placed_by_type TEXT NOT NULL DEFAULT 'user'
  CHECK (placed_by_type IN ('user','agent','system'));
ALTER TABLE holds ADD COLUMN IF NOT EXISTS alert_id UUID REFERENCES watchdog_alerts(id);
ALTER TABLE holds ADD COLUMN IF NOT EXISTS agent_run_id UUID REFERENCES agent_runs(id);
ALTER TABLE holds ADD COLUMN IF NOT EXISTS release_reason TEXT
  CHECK (release_reason IS NULL OR char_length(release_reason) BETWEEN 1 AND 500);
CREATE INDEX IF NOT EXISTS idx_holds_active_scope
  ON holds (tenant_id, scope_type, scope_id) WHERE status = 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM holds WHERE status = 'active'
    GROUP BY tenant_id, scope_type, scope_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_holds_one_active_per_subject
      ON holds (tenant_id, scope_type, scope_id) WHERE status = 'active';
  ELSE
    RAISE NOTICE 'Skipping uq_holds_one_active_per_subject because duplicate active Holds exist';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION stoat_holds_guard_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Holds cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'released'
     OR NEW.released_by IS NULL OR NEW.released_at IS NULL
     OR NEW.release_reason IS NULL OR char_length(NEW.release_reason) NOT BETWEEN 1 AND 500
     OR ROW(NEW.tenant_id, NEW.scope_type, NEW.scope_id, NEW.reason, NEW.placed_by,
            NEW.placed_by_type, NEW.alert_id, NEW.agent_run_id, NEW.placed_at)
        IS DISTINCT FROM
        ROW(OLD.tenant_id, OLD.scope_type, OLD.scope_id, OLD.reason, OLD.placed_by,
            OLD.placed_by_type, OLD.alert_id, OLD.agent_run_id, OLD.placed_at) THEN
    RAISE EXCEPTION 'Invalid Hold update' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stoat_holds_guard ON holds;
CREATE TRIGGER stoat_holds_guard
  BEFORE UPDATE OR DELETE ON holds
  FOR EACH ROW EXECUTE FUNCTION stoat_holds_guard_fn();
