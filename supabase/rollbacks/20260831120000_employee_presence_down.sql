-- Rollback for 20260831120000_employee_presence.
--
-- Drops the table outright — it holds only ephemeral status, nothing anyone
-- needs to keep. The app degrades cleanly without it: every presence read is
-- wrapped, so dots and the status menu simply stop rendering.

BEGIN;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.employee_presence;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DROP TABLE IF EXISTS public.employee_presence;

COMMIT;
