-- ─────────────────────────────────────────────────────────────────────────────
-- Preserve manual task↔item links across task edits.
--
-- ⚠ PROPOSED — DO NOT APPLY WITHOUT REVIEW. Written alongside the app-side fix
-- to linkTaskToAgreementItem (which now stamps tasks.retainer_item_id); this
-- closes the remaining durability hole described below. Nothing in the app
-- depends on it being applied — without it the stamp works but can be lost on
-- a later task edit.
--
-- WHY: set_task_retainer_coverage (20260728130000) re-detects coverage on
-- every UPDATE OF client_id/service_id/task_date and UNCONDITIONALLY
-- overwrites NEW.retainer_item_id. Detection only matches commitment_type =
-- 'retainer' items, so for a task manually linked to a one_time item (e.g.
-- Brand Identity) any later edit of its date/client/service silently nulls the
-- link — and with it the work value that pays the team.
--
-- FIX: before overwriting, check whether the CURRENT retainer_item_id is
-- backed by a client_agreement_tasks row (the definition of a manual link).
-- A backed link stands unless detection found a real retainer item (auto
-- coverage still outranks manual, unchanged from today's precedence when both
-- exist at insert time). Unlinking still clears coverage: the app deletes the
-- join row first, so the backing check fails and detection runs as before.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.set_task_retainer_coverage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id UUID;
  v_when    DATE := COALESCE(NEW.task_date, CURRENT_DATE);
BEGIN
  IF NEW.client_id IS NOT NULL AND NEW.service_id IS NOT NULL THEN
    SELECT i.id INTO v_item_id
      FROM public.client_agreement_items i
      JOIN public.client_agreements a ON a.id = i.agreement_id
     WHERE a.client_id      = NEW.client_id
       AND a.status         = 'active'
       AND a.deleted_at     IS NULL
       AND i.commitment_type = 'retainer'
       AND i.service_id      = NEW.service_id
       AND i.effective_from <= v_when
       AND (i.effective_to IS NULL OR i.effective_to >= v_when)
       AND a.start_date     <= v_when
       AND (a.end_date IS NULL OR a.end_date >= v_when)
     ORDER BY i.effective_from DESC
     LIMIT 1;
  END IF;

  -- Detection found nothing, but the existing link is manual (join-backed):
  -- keep it. Deleting the join row (the unlink action) removes the backing,
  -- after which this branch no longer protects it.
  IF v_item_id IS NULL
     AND NEW.retainer_item_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.client_agreement_tasks
        WHERE task_id = NEW.id AND item_id = NEW.retainer_item_id
     )
  THEN
    RETURN NEW;
  END IF;

  NEW.retainer_item_id := v_item_id;  -- NULL when nothing covers it
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_task_retainer_coverage() IS
  'Auto-detects retainer coverage on task writes. Since 20260811120000 a manual link (backed by client_agreement_tasks) survives edits that detection would otherwise null.';

COMMIT;
