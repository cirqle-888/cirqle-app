-- ─────────────────────────────────────────────────────────────────────────────
-- Foreign-currency task billing → INR (internal base)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Model:
--   billing_amount      = amount in the task's OWN currency (what the customer
--                         is invoiced in — AED/USD/etc.). Source of truth.
--   billing_amount_inr  = INR base, used ONLY for contributions, payroll, and
--                         profit/financial analytics. Converted at the task's
--                         moment using the current exchange_rates.rate_to_inr.
--
-- Historically billing_amount_inr was stored equal to the raw foreign amount
-- (e.g. AED 44 → 44) instead of converting, corrupting every non-INR task's
-- pool / earnings / profit / FX figures. Invoices were "accidentally correct"
-- because they read billing_amount_inr as the foreign line amount — the app
-- now reads billing_amount for invoices, so this conversion is safe.
--
-- This migration installs a BEFORE INSERT/UPDATE trigger so EVERY task write
-- path (Add Task, Inline Edit, Recalc Billing modal, server actions, future
-- code) derives billing_amount_inr = billing_amount × current rate for non-INR
-- original tasks — no path can bypass it.
--
-- NOTE: the one-time backfill of EXISTING rows was already applied
-- programmatically via the service-role client on 2026-06-06, so it is NOT
-- repeated here (that would double-convert). This file is safe to re-run —
-- CREATE OR REPLACE + DROP TRIGGER IF EXISTS make it idempotent.
--
-- Variant tasks (parent_task_id IS NOT NULL) are EXCLUDED: their
-- billing_amount_inr is a frozen, parent-derived figure (parent already in
-- INR), so they must not be recomputed here. Tasks whose currency has no
-- exchange_rates row are left unchanged (1:1).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Conversion trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_task_billing_inr()
RETURNS trigger AS $$
DECLARE
  v_rate numeric;
BEGIN
  IF NEW.parent_task_id IS NULL
     AND NEW.currency IS DISTINCT FROM 'INR'
     AND NEW.billing_amount IS NOT NULL THEN
    SELECT rate_to_inr INTO v_rate FROM exchange_rates WHERE currency = NEW.currency;
    -- Only override when we actually have a rate; otherwise leave whatever the
    -- app set (graceful 1:1 fallback, never worse than before).
    IF v_rate IS NOT NULL THEN
      NEW.billing_amount_inr := round((NEW.billing_amount * v_rate)::numeric, 2);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires only when the foreign amount or currency changes, so direct
-- billing_amount_inr writes (e.g. the backfill below, variant freezes) are not
-- disturbed.
DROP TRIGGER IF EXISTS trg_task_billing_inr ON tasks;
CREATE TRIGGER trg_task_billing_inr
  BEFORE INSERT OR UPDATE OF billing_amount, currency ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION set_task_billing_inr();

-- (One-time backfill of existing rows already applied programmatically — see
-- header note. Do NOT add it back here.)
