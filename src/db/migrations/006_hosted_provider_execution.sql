-- Who performs the work for a service.
--   hosted:   Stoat runs the provider's model review itself once the deal is ready.
--   external: the provider agent does the work and delivers through the API.
ALTER TABLE services ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'external';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_services_execution_mode') THEN
    ALTER TABLE services ADD CONSTRAINT chk_services_execution_mode CHECK (execution_mode IN ('hosted', 'external'));
  END IF;
END $$;

-- At most one provider-review job per agreement, however many times it is requested.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_provider_review_agreement
  ON jobs ((payload->>'agreement_id'))
  WHERE type = 'provider_review';
