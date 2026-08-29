-- Rollback for 20260830100000_rls_close_remaining_tables.
--
-- Restores the pre-migration state: RLS switched off on all 18 tables and the
-- group-A policies removed. This REOPENS the exposure the migration closed —
-- every one of these becomes readable again by any logged-in employee — so it
-- exists for emergency use, not as a routine step.
--
-- If a group-A table is misbehaving, prefer editing that one policy over running
-- this file.

BEGIN;

DO $$
DECLARE
  t text;
  group_a text[] := ARRAY[
    'cashbook_categories','cashbook_payroll_allocations','contribution_groups',
    'invoice_change_logs','quotation_items','task_tools','tool_services'
  ];
  group_b text[] := ARRAY[
    'ad_accounts','ad_ai_cache','ad_ai_insights','ad_ai_usage','ad_benchmarks',
    'ad_businesses','ad_forecast_accuracy','ad_sync_logs','ai_prompts',
    'deductions','parameter_services'
  ];
BEGIN
  FOREACH t IN ARRAY group_a LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated', t);
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY group_b LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
