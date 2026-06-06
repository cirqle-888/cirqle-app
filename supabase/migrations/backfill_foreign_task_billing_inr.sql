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
-- This migration:
--   1. Installs a BEFORE INSERT/UPDATE trigger so EVERY task write path
--      (Add Task, Inline Edit, Recalc Billing modal, server actions, future
--      code) derives billing_amount_inr = billing_amount × current rate for
--      non-INR original tasks — no path can bypass it.
--   2. Runs a one-time backfill for existing rows.
--
-- Variant tasks (parent_task_id IS NOT NULL) are EXCLUDED: their
-- billing_amount_inr is a frozen, parent-derived figure (and the parent is
-- already in INR after this runs), so they must not be recomputed here.
-- Tasks whose currency has no exchange_rates row are left unchanged (1:1).
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

-- 2. One-time backfill of existing rows ───────────────────────────────────────
-- (Direct billing_amount_inr update → does NOT fire the trigger above.)
UPDATE tasks t
SET    billing_amount_inr = round((t.billing_amount * r.rate_to_inr)::numeric, 2)
FROM   exchange_rates r
WHERE  t.currency = r.currency
  AND  t.currency IS DISTINCT FROM 'INR'
  AND  t.parent_task_id IS NULL
  AND  t.billing_amount IS NOT NULL
  AND  t.billing_amount > 0;
