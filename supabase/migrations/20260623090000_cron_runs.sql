-- Cron run log — lets the Business Health Center show whether each scheduled
-- job actually ran and succeeded. Built directly off the lesson from the
-- /api/cron/* middleware bug (cleanup-product-images was silently
-- redirected to /login for an unknown period and nobody could tell) — this
-- makes that class of failure visible going forward instead of invisible.

CREATE TABLE IF NOT EXISTS cron_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok BOOLEAN NOT NULL,
  summary JSONB,
  error TEXT
);

CREATE INDEX IF NOT EXISTS cron_runs_name_ran_at_idx
  ON cron_runs (cron_name, ran_at DESC);
