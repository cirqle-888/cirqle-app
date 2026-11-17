-- ============================================================================
-- notifications — each person reads only their own; the browser writes nothing
-- ============================================================================
--
-- THE PROBLEM (two holes, both reachable from the browser console)
--
--   1. Read: the SELECT policy let anyone holding `employees.view` read EVERY
--      employee's notifications. The admins' notifications carry money —
--      overdue invoice amounts, unsent invoices, payroll drafts, the weekly
--      summary — so a role with that one HR permission could read them all.
--
--   2. Write: the INSERT policy was `WITH CHECK (auth.uid() IS NOT NULL)`, so
--      any signed-in employee could create a notification for anyone, with any
--      title and any link — a fake "Payroll ready, sign in here" alert that the
--      bell, the desktop app and phone push would all deliver as genuine.
--
-- THE FIX
--   * One SELECT policy: rows addressed to the signed-in employee. Nothing
--     else. The bell, the chat widget and the desktop notifier read their own
--     rows over Realtime with `employee_id=eq.<me>`, which this still allows.
--   * No INSERT / UPDATE / DELETE for `authenticated` at all. Every write in
--     the app already goes through the service role (lib/notifications/create,
--     app/api/notifications/actions), which bypasses grants and RLS.
--
-- Every policy on the table is dropped first, by name from the catalogue, so a
-- broad policy someone added by hand in the SQL editor cannot survive and OR
-- itself back in.
--
-- Idempotent. Transactional.
-- Rollback: supabase/rollbacks/20261116100000_notifications_own_rows_down.sql
--
-- Verify after applying:
--   SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'notifications';
--     → exactly one row: notifications_own_select, SELECT
--   SELECT has_table_privilege('authenticated', 'public.notifications', 'SELECT'),  -- true
--          has_table_privilege('authenticated', 'public.notifications', 'INSERT'),  -- false
--          has_table_privilege('authenticated', 'public.notifications', 'UPDATE'),  -- false
--          has_table_privilege('authenticated', 'public.notifications', 'DELETE');  -- false
-- ============================================================================

BEGIN;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.notifications', p.policyname);
  END LOOP;
END $$;

CREATE POLICY notifications_own_select
  ON public.notifications FOR SELECT TO authenticated
  USING (
    employee_id IN (SELECT e.id FROM public.employees e WHERE e.auth_id = (SELECT auth.uid()))
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.notifications FROM authenticated;
REVOKE ALL ON public.notifications FROM anon;
GRANT SELECT ON public.notifications TO authenticated;

COMMIT;
