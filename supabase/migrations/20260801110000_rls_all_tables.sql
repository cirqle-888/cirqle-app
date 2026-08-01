-- ============================================================================
-- DB-01 — Enable RLS on all remaining public tables
-- ============================================================================
-- 
-- The previous migration (20260801100000) only secured tables that had data
-- exposed to the anon key. This migration ensures ALL tables in the public 
-- schema have RLS enabled to satisfy "DB-01: Enable RLS on all public tables",
-- implementing a fail-closed posture by default.
--
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN 
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Remove any wide-open baseline policy if it exists.
    EXECUTE format('DROP POLICY IF EXISTS "allow_all" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_authenticated" ON public.%I', t, t);

    EXECUTE format(
      'CREATE POLICY "%I_authenticated" ON public.%I '
      'FOR ALL TO authenticated USING (true) WITH CHECK (true)', t, t);

    -- The anon role must not reach these at all. The service role is unaffected.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);

    RAISE NOTICE 'secured %', t;
  END LOOP;
END $$;

COMMIT;
