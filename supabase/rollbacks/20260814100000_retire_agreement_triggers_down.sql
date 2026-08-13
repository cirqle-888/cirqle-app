-- Rollback for 20260814100000_retire_agreement_triggers.sql
--
-- Re-arms the client-agreement engine in the database. Only needed if the
-- package system has to be abandoned and the old behaviour brought back.
--
-- Safe because the forward migration only dropped trigger BINDINGS and left
-- both functions defined. Nothing was deleted.
--
-- NOTE: it does NOT re-add the coverage guard to auto_attach_task_to_invoice().
-- If you truly need the old invoicing behaviour, re-apply
-- 20260728130000_retainer_coverage.sql (which contains that version of the
-- function) AFTER running this file.

BEGIN;

-- 1. Re-arm coverage detection. Name order matters: trg_task_retainer_coverage
--    must sort before trg_task_work_value so the work-value stamp sees the
--    freshly detected retainer_item_id (see 20260807110000).
CREATE TRIGGER trg_task_retainer_coverage
  BEFORE INSERT OR UPDATE OF client_id, service_id, task_date
  ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_retainer_coverage();

CREATE TRIGGER trg_task_work_value
  BEFORE INSERT OR UPDATE OF client_id, service_id, task_date, quantity, bill_as_extra, retainer_item_id
  ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_work_value();

-- 2. Re-open the agreement.
--    Scoped to the one agreement the forward migration closed. If more than one
--    was active when it ran, widen this by agreement_number as needed.
UPDATE public.client_agreements
   SET status = 'active', updated_at = NOW()
 WHERE agreement_number = 'AGR-2607-062'
   AND status = 'completed'
   AND deleted_at IS NULL;

COMMIT;
