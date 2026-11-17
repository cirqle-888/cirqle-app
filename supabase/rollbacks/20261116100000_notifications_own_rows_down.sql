-- Restores the notifications policies as they were before 20261116100000
-- (migration 006's three policies and the table-level write grants).
-- This reopens both holes that migration closed; use it only to back out.
BEGIN;
DROP POLICY IF EXISTS notifications_own_select ON public.notifications;

CREATE POLICY "notifications_select" ON public.notifications FOR SELECT
  USING (
    auth.uid() IS NOT NULL AND (
      EXISTS (SELECT 1 FROM employees WHERE auth_id = auth.uid() AND id = notifications.employee_id)
      OR has_permission(auth.uid(), 'employees.view')
    )
  );
CREATE POLICY "notifications_insert" ON public.notifications FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "notifications_update" ON public.notifications FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM employees WHERE auth_id = auth.uid() AND id = notifications.employee_id)
    OR has_permission(auth.uid(), 'employees.edit')
  );

GRANT INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
COMMIT;
