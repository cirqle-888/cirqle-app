-- Rollback for 20260808110000_derived_billing_rules.sql
--
-- Derived tasks KEEP their last computed billing_amount — the money already on
-- draft invoices and in contributor earnings stays put. They simply stop
-- recomputing and revert to 'fixed' mode, i.e. an ordinary manually-priced
-- task. That is the safe direction: nothing is re-billed, nothing is zeroed.

BEGIN;

-- Templates are pure config; drop the table.
DROP TABLE IF EXISTS public.billing_rule_templates;

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_derived_has_rule;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_derived_not_variant;
DROP INDEX IF EXISTS public.idx_tasks_derived_source_services;

-- Demote derived tasks BEFORE narrowing the CHECK, or the constraint fails.
UPDATE public.tasks SET billing_mode = 'fixed'
 WHERE billing_mode = 'percent_of_services';

ALTER TABLE public.tasks DROP COLUMN IF EXISTS billing_rule;

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_billing_mode_check;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_billing_mode_check
  CHECK (billing_mode IN ('fixed', 'percent_of_parent', 'parameter_driven'));

COMMIT;
