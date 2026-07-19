-- Rollback for 20260720110000_scope_audit_updated_action.sql
--
-- Narrowing the CHECK fails if any 'updated' row already exists — the table is
-- append-only by trigger, so such rows cannot be edited away. The guard below
-- reports that clearly instead of failing on a constraint violation.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_scope_audit WHERE action = 'updated') THEN
    RAISE EXCEPTION 'Cannot narrow the CHECK: % audit row(s) use action=''updated''.',
      (SELECT count(*) FROM public.service_scope_audit WHERE action = 'updated');
  END IF;
END $$;

ALTER TABLE public.service_scope_audit
  DROP CONSTRAINT IF EXISTS service_scope_audit_action_check;

ALTER TABLE public.service_scope_audit
  ADD CONSTRAINT service_scope_audit_action_check
  CHECK (action IN ('added', 'removed', 'activated', 'deactivated'));
