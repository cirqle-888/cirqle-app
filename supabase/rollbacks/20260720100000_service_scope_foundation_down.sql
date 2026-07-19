-- Rollback for 20260720100000_service_scope_foundation.sql
--
-- Commitment DATA (which client buys which service) is deliberately preserved:
-- the rows are ordinary client_service_pricing rows and deleting them would
-- destroy pricing. Only the scoping scaffolding is removed.
--
-- is_active stays NOT NULL: reverting that would let nulls back in and every
-- reader now treats "row exists" as committed. Harmless to leave.

DROP TRIGGER IF EXISTS service_scope_audit_no_mutate ON public.service_scope_audit;
DROP FUNCTION IF EXISTS public.service_scope_audit_append_only();
DROP TABLE IF EXISTS public.service_scope_audit;

DROP INDEX IF EXISTS csp_commitment_idx;
DROP INDEX IF EXISTS csp_service_commitment_idx;

ALTER TABLE public.client_service_pricing
  DROP COLUMN IF EXISTS deactivated_at,
  DROP COLUMN IF EXISTS deactivated_by;

DELETE FROM public.designation_permissions
 WHERE permission_id IN (SELECT id FROM public.permissions
                          WHERE key IN ('scope.by_service','scope.view_all'));
DELETE FROM public.permissions WHERE key IN ('scope.by_service','scope.view_all');

DELETE FROM public.company_settings WHERE key = 'scope_client_services';

-- employee_services RLS is deliberately NOT reverted — the old policy exposed
-- the table to the anon browser key. Restoring that would reintroduce the leak.
