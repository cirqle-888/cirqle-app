-- ============================================================================
-- 029 — Performance Scorecards: auto-metrics snapshot
--
-- Adds two columns to perf_assessments so the Auto Performance Score computed
-- at finalize time is frozen with the scorecard (live values keep moving as
-- new tasks land; the snapshot preserves what the number was on review day).
-- Nothing here touches pay: employee_performance_history is only ever written
-- by the explicit "Apply to pay" action, unchanged from migration 028.
-- ============================================================================

ALTER TABLE perf_assessments ADD COLUMN IF NOT EXISTS auto_score   numeric(5,2);
ALTER TABLE perf_assessments ADD COLUMN IF NOT EXISTS auto_metrics jsonb;
