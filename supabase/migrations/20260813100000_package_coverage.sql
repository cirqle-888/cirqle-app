-- ═══════════════════════════════════════════════════════════════════════════
-- PACKAGE COVERAGE — one-time packages cover tasks until delivered (Phase 1)
--
-- Adds completed_at to client_agreement_items. This acts as the cutoff that
-- stops the trigger from covering unrelated later tasks on the same service
-- after a package is delivered.
--
-- Supersedes 20260811120000_preserve_manual_retainer_links.sql (SUPERSEDED, never apply).
--
-- Rollback: supabase/rollbacks/20260813100000_package_coverage_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.client_agreement_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

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
     WHERE a.client_id       = NEW.client_id
       AND a.status          = 'active'
       AND a.deleted_at      IS NULL
       AND i.effective_from <= v_when
       AND (i.effective_to IS NULL OR i.effective_to >= v_when)
       AND a.start_date     <= v_when
       AND (a.end_date IS NULL OR a.end_date >= v_when)
       AND (
             i.commitment_type = 'retainer'
          OR (i.commitment_type = 'one_time' AND i.completed_at IS NULL)
       )
       AND (
             i.service_id = NEW.service_id
          OR EXISTS (
               SELECT 1 FROM public.agreement_item_services ais
                WHERE ais.agreement_item_id = i.id
                  AND ais.service_id = NEW.service_id
             )
           )
     ORDER BY
       (CASE WHEN i.commitment_type = 'retainer' THEN 1 ELSE 2 END) ASC,
       i.effective_from DESC
     LIMIT 1;
  END IF;

  -- Sticky rule: if detection found nothing, but the existing link is manual
  -- (join-backed) OR is a still-valid one_time item, keep it.
  IF v_item_id IS NULL AND NEW.retainer_item_id IS NOT NULL THEN
    IF EXISTS (
         SELECT 1 FROM public.client_agreement_tasks
          WHERE task_id = NEW.id AND item_id = NEW.retainer_item_id
       )
       OR EXISTS (
         SELECT 1 FROM public.client_agreement_items
          WHERE id = NEW.retainer_item_id
            AND commitment_type = 'one_time'
            AND completed_at IS NULL
       )
    THEN
      RETURN NEW;
    END IF;
  END IF;

  NEW.retainer_item_id := v_item_id;  -- NULL when nothing covers it
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_task_retainer_coverage() IS
  'Auto-detects coverage (retainer or undelivered one_time packages) on task writes. Existing manual links or valid one_time links survive edits.';

COMMIT;
