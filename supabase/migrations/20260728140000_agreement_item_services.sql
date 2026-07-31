-- ═══════════════════════════════════════════════════════════════════════════
-- AGREEMENT ITEM SERVICES — one retainer covers many services (Phase 2b)
--
-- Phase 2a matched coverage on a single service (item.service_id = task.service_id),
-- which is too narrow: one "Social Media Management" retainer really covers
-- Poster + Carousel + Reel + Story + Banner. This adds a many-to-many mapping so
-- a retainer item can cover ANY set of services.
--
-- Reuse: FKs point at the existing client_agreement_items and services tables —
-- no data is duplicated; this is purely the join that didn't exist.
--
-- Backward-compatible:
--   • Existing retainer items are BACKFILLED with their own service_id, so today's
--     coverage keeps working unchanged.
--   • The detection trigger matches EITHER a mapped service OR the item's own
--     service_id, so items with no mapping row still behave exactly as in 2a.
--
-- Rollback: supabase/rollbacks/20260728140000_agreement_item_services_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Mapping table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agreement_item_services (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_item_id UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  service_id        UUID NOT NULL REFERENCES public.services(id)               ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agreement_item_id, service_id)
);
CREATE INDEX IF NOT EXISTS agreement_item_services_item_idx    ON public.agreement_item_services (agreement_item_id);
CREATE INDEX IF NOT EXISTS agreement_item_services_service_idx ON public.agreement_item_services (service_id);

-- RLS: house pattern (permissive; real authz is app-level permission guards).
ALTER TABLE public.agreement_item_services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agreement_item_services_authenticated_all ON public.agreement_item_services;
CREATE POLICY agreement_item_services_authenticated_all
  ON public.agreement_item_services FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 2. Backfill existing retainer items with their own service_id ────────────
INSERT INTO public.agreement_item_services (agreement_item_id, service_id)
SELECT i.id, i.service_id
  FROM public.client_agreement_items i
 WHERE i.commitment_type = 'retainer'
   AND i.service_id IS NOT NULL
ON CONFLICT (agreement_item_id, service_id) DO NOTHING;

-- ── 3. Coverage detection now consults the mapping table (or item.service_id) ─
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
       AND i.commitment_type = 'retainer'
       AND i.effective_from <= v_when
       AND (i.effective_to IS NULL OR i.effective_to >= v_when)
       AND a.start_date     <= v_when
       AND (a.end_date IS NULL OR a.end_date >= v_when)
       AND (
             i.service_id = NEW.service_id
          OR EXISTS (
               SELECT 1 FROM public.agreement_item_services ais
                WHERE ais.agreement_item_id = i.id
                  AND ais.service_id = NEW.service_id
             )
           )
     ORDER BY i.effective_from DESC
     LIMIT 1;
  END IF;

  NEW.retainer_item_id := v_item_id;  -- NULL when nothing covers it
  RETURN NEW;
END;
$$;

COMMIT;
