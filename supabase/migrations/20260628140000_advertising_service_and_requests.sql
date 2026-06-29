-- ============================================================================
-- Advertising — service link + request integration
-- ============================================================================
-- Two additive, idempotent changes that connect advertising into the existing
-- request → task → contribution spine:
--
--  1. ad_projects.service_id — each campaign maps to ONE advertising service
--     (from the existing Services catalog), so its single task carries that
--     service's pricing + contribution parameters. No more 7-task checklist.
--
--  2. task_requests.ad_meta — marks a request as an advertising request and
--     carries the captured hints (platform / campaign type / budget). Presence
--     of this jsonb = "show an advertising badge + Start-as-campaign action".
--     Advertising requests therefore appear in the normal Requests inbox.
--
-- Requires 20260628120000_advertising_module.sql (ad_projects) first — timestamp
-- ordering guarantees it. Server code reads/writes both columns defensively.
-- ============================================================================

BEGIN;

ALTER TABLE public.ad_projects
  ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES public.services(id) ON DELETE SET NULL;

ALTER TABLE public.task_requests
  ADD COLUMN IF NOT EXISTS ad_meta JSONB;

CREATE INDEX IF NOT EXISTS ad_projects_service_idx ON public.ad_projects (service_id);
CREATE INDEX IF NOT EXISTS task_requests_ad_meta_idx ON public.task_requests ((ad_meta IS NOT NULL)) WHERE ad_meta IS NOT NULL;

COMMIT;
