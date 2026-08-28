-- ═══════════════════════════════════════════════════════════════════════════
-- Waived work: free to the client, still worth its full internal value
--
-- WHY
--   Work given away — a cover image inside a retainer, a goodwill highlight
--   icon, a rework of our own mistake — had exactly one way to be expressed:
--   price it at ₹0. That pays the designer ₹0 too, because commission is a
--   share of the task's amount, and it erases any record of what the agency
--   gave away.
--
--   So a waived task now keeps its Pricing-Matrix amount and carries
--   `is_billable = false` instead. That flag means ONE thing: the client is not
--   charged for this task. Commission, package progress, productivity and task
--   value all keep reading billing_amount_inr exactly as before.
--
-- WHAT THIS DOES
--   1. tasks.no_charge_reason  — why it was waived (package/goodwill/rework/
--      internal). Nullable: a billable task has no reason.
--   2. services.default_billable — a service that is free by default, so
--      Instagram highlight icons come up as waived without anyone remembering.
--   3. trg_strip_waived_task_lines — keeps a waived task off draft invoices.
--
-- WHY A SECOND TRIGGER RATHER THAN EDITING auto_attach_task_to_invoice()
--   The live body of that function has been hotfixed ahead of this repo more
--   than once (see 20260814150000, 20260814170000). CREATE OR REPLACE needs the
--   WHOLE body, so re-declaring it from the newest text checked in here would
--   silently revert whatever the live version has learned since. This trigger is
--   purely additive: auto-attach adds the line exactly as it does today, and
--   this one removes it again for waived tasks. Postgres fires same-timing
--   triggers in NAME order, and 'trg_auto_attach_task' < 'trg_strip_waived_
--   task_lines', so the strip always runs second.
--
-- SAFE TO RE-RUN. No existing row is waived (0 tasks had is_billable = false
-- when this was written), so nothing is reclassified by applying it.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Why a task was waived ───────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS no_charge_reason TEXT;

DO $$
BEGIN
  ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_no_charge_reason_check
    CHECK (no_charge_reason IS NULL
           OR no_charge_reason IN ('package', 'goodwill', 'rework', 'internal'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.tasks.no_charge_reason IS
  'Why this task is not billed. Only meaningful while is_billable = false.';

-- ── 2. Services that are free by default ───────────────────────────────────
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS default_billable BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.services.default_billable IS
  'FALSE = new tasks on this service start waived (still priced, just not billed).';

-- Instagram highlight icons are given away with the social retainer. Matched by
-- name because there is no stable id across environments; a no-op where the
-- service does not exist.
UPDATE public.services
   SET default_billable = FALSE
 WHERE name ILIKE '%highlight icon%'
   AND default_billable IS DISTINCT FROM FALSE;

-- ── 3. Keep waived tasks off client invoices ───────────────────────────────
CREATE OR REPLACE FUNCTION public.strip_waived_task_invoice_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id UUID;
BEGIN
  -- Draft and reviewed only. A SENT invoice is a document the client has
  -- already been given; waiving a task afterwards is a credit note, decided by
  -- a human, never by a trigger.
  SELECT i.id INTO v_invoice_id
    FROM invoices i
    JOIN invoice_items ii ON ii.invoice_id = i.id
   WHERE ii.task_id = NEW.id
     AND i.status IN ('draft', 'reviewed')
   LIMIT 1;

  IF v_invoice_id IS NOT NULL THEN
    DELETE FROM invoice_items WHERE invoice_id = v_invoice_id AND task_id = NEW.id;
    PERFORM recalc_invoice_totals(v_invoice_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_strip_waived_task_lines ON public.tasks;
CREATE TRIGGER trg_strip_waived_task_lines
  AFTER INSERT OR UPDATE OF status, billing_amount_inr, package_id, is_billable
  ON public.tasks
  FOR EACH ROW
  WHEN (NEW.is_billable IS FALSE)
  EXECUTE FUNCTION public.strip_waived_task_invoice_lines();

COMMIT;
