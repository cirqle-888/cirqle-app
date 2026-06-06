-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: convert billing_amount_inr for foreign-currency tasks
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Problem: the task billing flow historically stored billing_amount_inr equal
-- to the raw foreign billing_amount (e.g. AED 44 → billing_amount_inr = 44)
-- instead of converting to INR. This corrupted the Contribution Analysis pool,
-- employee earnings, expected profit, and FX gain/loss for every non-INR task.
--
-- Fix (one-time): recompute billing_amount_inr = billing_amount × current
-- exchange_rates.rate_to_inr for non-INR, ORIGINAL tasks. Variant tasks
-- (parent_task_id IS NOT NULL) are excluded — their billing_amount_inr is a
-- frozen, parent-derived figure and must not be recomputed here.
--
-- NOTE: run ONCE. It is not idempotent — re-running would multiply by the rate
-- again. Tasks whose currency has no row in exchange_rates are left unchanged.
-- Going forward, serverSaveTask / serverFillTaskBilling convert at write time.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE tasks t
SET    billing_amount_inr = round((t.billing_amount * r.rate_to_inr)::numeric, 2)
FROM   exchange_rates r
WHERE  t.currency = r.currency
  AND  t.currency IS DISTINCT FROM 'INR'
  AND  t.parent_task_id IS NULL
  AND  t.billing_amount IS NOT NULL
  AND  t.billing_amount > 0;
