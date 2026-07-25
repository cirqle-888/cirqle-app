-- Rollback for 20260722120000_client_agreements.sql
-- Drops the six agreement tables (reverse dependency order), the permission
-- rows and their designation grants, and the tasks composite index.
-- Safe to run repeatedly (IF EXISTS everywhere).

BEGIN;

DELETE FROM public.designation_permissions WHERE permission_id IN
  (SELECT id FROM public.permissions
    WHERE key IN ('agreements.view','agreements.manage','agreements.view_pricing'));
DELETE FROM public.permissions
  WHERE key IN ('agreements.view','agreements.manage','agreements.view_pricing');

DROP TABLE IF EXISTS public.client_agreement_events;
DROP TABLE IF EXISTS public.client_agreement_tasks;
DROP TABLE IF EXISTS public.client_agreement_milestones;
DROP TABLE IF EXISTS public.client_agreement_deliverables;
DROP TABLE IF EXISTS public.client_agreement_items;
DROP TABLE IF EXISTS public.client_agreements;

DROP INDEX IF EXISTS public.idx_tasks_client_service_date;

COMMIT;
