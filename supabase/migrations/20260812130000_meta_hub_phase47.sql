-- ============================================================================
-- Meta Hub — Phases 4–7: agency dashboard, performance alerts, AI insights
-- ============================================================================
--   performance_alert_rules — configurable thresholds (high CPL, lead/reach
--                             drop, spend spike, stale sync). Evaluated daily.
--   meta_insight_cache      — cached AI narratives (facts hashed) so the agency
--                             dashboard and reports don't re-hit the LLM every load.
-- No new permissions: the agency dashboard reuses reports.view (admins bypass);
-- alert-rule management reuses settings.manage_company.
-- ============================================================================

BEGIN;

-- ── Performance alert rules ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.performance_alert_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES public.clients(id) ON DELETE CASCADE,  -- NULL = all clients
  metric        TEXT NOT NULL CHECK (metric IN (
                  'cpl_above', 'leads_drop_pct', 'reach_drop_pct',
                  'spend_increase_pct', 'stale_sync_hours', 'roas_below', 'ctr_below')),
  threshold     NUMERIC NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS perf_alert_rules_active_idx
  ON public.performance_alert_rules (metric) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS update_perf_alert_rules_modtime ON public.performance_alert_rules;
CREATE OR REPLACE TRIGGER update_perf_alert_rules_modtime
  BEFORE UPDATE ON public.performance_alert_rules FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.performance_alert_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS perf_alert_rules_read ON public.performance_alert_rules;
CREATE POLICY perf_alert_rules_read ON public.performance_alert_rules
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- Seed sensible agency-wide defaults (all clients). ON CONFLICT-safe via NOT EXISTS.
INSERT INTO public.performance_alert_rules (client_id, metric, threshold)
SELECT NULL, v.metric, v.threshold
  FROM (VALUES
    ('cpl_above'::text, 500::numeric),      -- alert if cost per lead > ₹500
    ('leads_drop_pct', 30),                 -- alert if leads fall > 30% vs prior period
    ('reach_drop_pct', 40),                 -- alert if reach falls > 40%
    ('spend_increase_pct', 20),             -- alert if spend jumps > 20%
    ('stale_sync_hours', 24)                -- alert if an account hasn't synced in 24h
  ) AS v(metric, threshold)
 WHERE NOT EXISTS (SELECT 1 FROM public.performance_alert_rules WHERE client_id IS NULL AND metric = v.metric);

-- ── AI narrative cache ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meta_insight_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        TEXT NOT NULL,               -- 'client:<id>' | 'agency' | 'account:<id>'
  facts_hash   TEXT NOT NULL,               -- hash of the facts the narrative was built from
  narrative    JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, facts_hash)
);

CREATE INDEX IF NOT EXISTS meta_insight_cache_scope_idx
  ON public.meta_insight_cache (scope, created_at DESC);

ALTER TABLE public.meta_insight_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_insight_cache_read ON public.meta_insight_cache;
CREATE POLICY meta_insight_cache_read ON public.meta_insight_cache
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

COMMIT;
