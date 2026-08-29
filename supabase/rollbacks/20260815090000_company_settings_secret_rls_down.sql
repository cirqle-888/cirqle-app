-- ============================================================================
-- ROLLBACK for 20260815090000_company_settings_secret_rls.sql
-- ============================================================================
-- Restores the previous state: the blanket authenticated policy created by
-- 20260801100000_rls_remaining_tables.sql.
--
-- NOTE this deliberately re-opens the hole that migration closed — every
-- logged-in employee can read offer_sheet_secret and the rest of the settings
-- table again. Only run it if the narrowed policy is actively breaking a read
-- path, and treat that as a bug to fix forward rather than a state to stay in.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "company_settings_select_public_keys" ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_insert_perm" ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_update_perm" ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_delete_perm" ON public.company_settings;

DROP POLICY IF EXISTS "company_settings_authenticated" ON public.company_settings;
CREATE POLICY "company_settings_authenticated"
  ON public.company_settings FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

COMMIT;
