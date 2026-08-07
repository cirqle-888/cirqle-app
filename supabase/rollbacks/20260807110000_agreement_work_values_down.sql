-- Rollback for 20260807110000_agreement_work_values.sql
-- Removes work-value columns, the task stamp + triggers, and the retainer
-- invoice-line machinery. Retainer-fee invoice lines already inserted are
-- left in place (they are real billing history); their agreement_item_id
-- column is dropped with the FK.

BEGIN;

DROP FUNCTION IF EXISTS public.ensure_retainer_invoice_lines(DATE);

DROP INDEX IF EXISTS public.invoice_items_agreement_item_uniq;
ALTER TABLE public.invoice_items DROP COLUMN IF EXISTS agreement_item_id;

DROP TRIGGER IF EXISTS trg_task_work_value ON public.tasks;
DROP FUNCTION IF EXISTS public.set_task_work_value();
DROP FUNCTION IF EXISTS public.restamp_agreement_item_work_values(UUID);

ALTER TABLE public.tasks DROP COLUMN IF EXISTS work_value_inr;

ALTER TABLE public.client_agreement_items
  DROP COLUMN IF EXISTS work_unit_value,
  DROP COLUMN IF EXISTS work_commission_pct;

COMMIT;
