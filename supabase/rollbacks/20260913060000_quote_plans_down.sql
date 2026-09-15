-- Rollback for 20260913060000_quote_plans.
--
-- Safe to run wholesale: these tables are a planning sandbox. Nothing else
-- references them, no money path reads them, and dropping them cannot affect
-- a task, a contribution, an invoice or a payroll row. The only loss is the
-- saved plans themselves.
--
-- `quotations.id` is referenced BY quote_plans, not the other way round, so
-- dropping these leaves quotations untouched.

BEGIN;

DROP TABLE IF EXISTS public.quote_plan_costs;
DROP TABLE IF EXISTS public.quote_plan_ratings;
DROP TABLE IF EXISTS public.quote_plan_shares;
DROP TABLE IF EXISTS public.quote_plan_lines;
DROP TABLE IF EXISTS public.quote_plans;

DELETE FROM public.permissions WHERE key IN ('quote_planner.view', 'quote_planner.manage');

COMMIT;
