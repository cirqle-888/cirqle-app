-- ────────────────────────────────────────────────────────────────────────────
-- Migration 003: Billing snapshot for historical stability
-- ────────────────────────────────────────────────────────────────────────────
-- Adds a JSONB column that captures the billing math at save time so future
-- changes to parameter weights / pricing matrix don't silently shift the
-- billing of already-saved variant tasks (and the commissions derived from them).
--
-- Snapshot shape (set on insert of a parameter_driven or percent_of_parent variant):
-- {
--   "formula":         "parameter_driven" | "percent_of_parent" | "fixed",
--   "parent_billing":  500,                                -- parent task's billing at this moment
--   "parameter_ids":   ["<uuid>", "<uuid>"],               -- if parameter_driven
--   "weights":         { "<uuid>": 0.04, "<uuid>": 0.02 }, -- weight values at save time
--   "percent":         6,                                  -- final % applied to parent_billing
--   "computed_amount": 30,                                 -- the resulting billing_amount_inr
--   "computed_at":     "2026-05-18T12:34:56Z"
-- }
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS billing_snapshot JSONB;

-- Force PostgREST to refresh its schema cache so the API sees the new column
NOTIFY pgrst, 'reload schema';
