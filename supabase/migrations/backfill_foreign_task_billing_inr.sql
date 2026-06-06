-- ─────────────────────────────────────────────────────────────────────────────
-- Lock-at-creation INR for foreign-currency tasks
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Model (intended logic):
--   billing_amount        = amount in the task's OWN currency (what the customer
--                           is invoiced — AED/USD/…). Source of truth for invoices.
--   billing_exchange_rate = the rate_to_inr LOCKED at task creation / first
--                           billing. Never changes with later FX movements.
--   billing_amount_inr    = billing_amount × billing_exchange_rate. The locked
--                           INR base used ONLY for contributions, commissions,
--                           payroll and internal reporting.
--
-- Guarantees:
--   • INR is locked at creation and is NOT re-pegged by later edits or FX moves,
--     so historical payroll / earnings / task profitability never change because
--     the exchange rate moved (intent points 1 & 6).
--   • Invoices/payments are completely separate: invoices bill in billing_amount
--     (foreign); payments record their own payment-time rate; FX gain/loss is a
--     collection-side report figure and never writes back here.
--
-- Variant tasks (parent_task_id IS NOT NULL) are EXCLUDED — their INR is a frozen
-- parent-derived figure. Tasks whose currency has no exchange_rates row are left
-- unchanged (1:1). This file is idempotent — safe to run once or again.
--
-- NOTE: the one-time INR backfill of existing rows was already applied
-- programmatically via the service-role client on 2026-06-06 (billing_amount_inr
-- = billing_amount × current rate). This migration only ADDS the locked-rate
-- column, installs the lock-aware trigger, and pins the locked rate onto those
-- already-converted rows. It does NOT re-touch billing_amount_inr.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Locked-rate column ───────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS billing_exchange_rate numeric;

-- 2. Lock-aware conversion trigger ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_task_billing_inr()
RETURNS trigger AS $$
DECLARE
  v_rate numeric;
BEGIN
  IF NEW.parent_task_id IS NULL
     AND NEW.currency IS DISTINCT FROM 'INR'
     AND NEW.billing_amount IS NOT NULL THEN
    -- Lock the rate ONCE (at creation / first billing). Never overwrite it, so
    -- later edits and FX movements cannot change the INR basis.
    IF NEW.billing_exchange_rate IS NULL THEN
      SELECT rate_to_inr INTO v_rate FROM exchange_rates WHERE currency = NEW.currency;
      IF v_rate IS NOT NULL THEN
        NEW.billing_exchange_rate := v_rate;
      END IF;
    END IF;
    -- Recompute INR from the LOCKED rate. Changing the foreign amount keeps the
    -- original rate; a title-only edit never reaches this trigger at all.
    IF NEW.billing_exchange_rate IS NOT NULL THEN
      NEW.billing_amount_inr := round((NEW.billing_amount * NEW.billing_exchange_rate)::numeric, 2);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires only when the foreign amount or currency is written, so direct
-- billing_amount_inr / billing_exchange_rate updates do not re-trigger it.
DROP TRIGGER IF EXISTS trg_task_billing_inr ON tasks;
CREATE TRIGGER trg_task_billing_inr
  BEFORE INSERT OR UPDATE OF billing_amount, currency ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION set_task_billing_inr();

-- 3. Pin the locked rate onto the already-converted existing rows ──────────────
-- DERIVE the rate from the values already stored (billing_amount_inr ÷
-- billing_amount) rather than re-reading the current exchange_rates row. This
-- guarantees billing_amount_inr = billing_amount × billing_exchange_rate exactly,
-- so the lock stays self-consistent even if market rates have moved since the
-- programmatic backfill. Does NOT modify billing_amount_inr.
UPDATE tasks t
SET    billing_exchange_rate = round((t.billing_amount_inr / t.billing_amount)::numeric, 6)
WHERE  t.currency IS DISTINCT FROM 'INR'
  AND  t.parent_task_id IS NULL
  AND  t.billing_amount IS NOT NULL
  AND  t.billing_amount > 0
  AND  t.billing_amount_inr IS NOT NULL
  AND  t.billing_exchange_rate IS NULL;
