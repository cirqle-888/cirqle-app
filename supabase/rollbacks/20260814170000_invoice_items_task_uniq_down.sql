-- Undo 20260814170000_invoice_items_task_uniq.sql
--
-- WARNING — this re-breaks task completion. auto_attach_task_to_invoice() upserts
-- with ON CONFLICT (invoice_id, task_id); without this index, plan-time arbiter
-- inference fails and every attempt to save a client task as Done aborts with
-- 42P10, taking the task row with it. Only run this if the trigger's ON CONFLICT
-- clause is being removed or re-specified in the same change.
--
-- Dropping the index does not touch invoice lines. Duplicates it was preventing
-- can appear from that point on.

BEGIN;

DROP INDEX IF EXISTS public.invoice_items_invoice_task_uniq;

COMMIT;
