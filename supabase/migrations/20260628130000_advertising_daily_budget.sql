-- ============================================================================
-- Advertising — optional daily-budget settings on ad_projects
-- ============================================================================
-- Adds the metadata for "daily budget × duration" entry so a campaign remembers
-- it was briefed as e.g. ₹3,000/day for 7 days. ad_projects.ad_budget_amount
-- still holds the resolved total (the value everything bills on); these columns
-- only let the budget editor reconstruct + recompute it.
--
-- Additive + idempotent. Requires 20260628120000_advertising_module.sql (which
-- creates ad_projects) to have run first — timestamp ordering guarantees that.
-- Server code persists these on a best-effort basis, so the app is unaffected
-- if this file hasn't been applied yet.
-- ============================================================================

BEGIN;

ALTER TABLE public.ad_projects
  ADD COLUMN IF NOT EXISTS budget_input_mode TEXT NOT NULL DEFAULT 'total'
    CHECK (budget_input_mode IN ('total','daily')),
  ADD COLUMN IF NOT EXISTS daily_budget NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS budget_days  INTEGER;

COMMIT;
