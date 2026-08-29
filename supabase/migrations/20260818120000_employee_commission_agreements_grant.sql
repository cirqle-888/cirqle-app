BEGIN;

-- Allow logged-in employees to read and manage commission agreements from the browser
-- (they are still guarded by RLS or the browser client UI).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_commission_agreements TO authenticated;

COMMIT;
