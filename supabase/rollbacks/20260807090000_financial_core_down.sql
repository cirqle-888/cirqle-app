-- Rollback for 20260807090000_financial_core.sql
--
-- The migration is purely additive (five new tables + one defaulted column),
-- so dropping them restores the prior schema exactly. Contribution data is
-- untouched by both directions.
--
-- WARNING: dropping period_locks and profit_snapshots discards closed-period
-- history. Months previously locked WITHOUT a paid payroll row become open
-- and recomputable again. Export both tables first if that history matters.
BEGIN;

ALTER TABLE public.payroll DROP COLUMN IF EXISTS adjustment_earned;

DROP TABLE IF EXISTS public.payroll_adjustments;
DROP TABLE IF EXISTS public.recurring_expenses;
DROP TABLE IF EXISTS public.overhead_allocation_policy;
DROP TABLE IF EXISTS public.profit_snapshots;
DROP TABLE IF EXISTS public.period_locks;

COMMIT;
