-- ============================================================================
-- SEC-01 — Stop every logged-in employee from reading the workspace secrets
-- ============================================================================
--
-- THE HOLE
-- `company_settings` is the de-facto config store, and 20260801100000 secured
-- it with `FOR ALL TO authenticated USING (true)` — which closed the ANON hole
-- (the live exposure at the time) and deliberately left the authenticated one
-- open, documented there as "a floor, not the final model".
--
-- That floor is too low, because the table holds bearer secrets, not just
-- preferences:
--
--   offer_sheet_secret   the bearer token for EVERY /api/figma/* endpoint
--                        (see src/app/api/figma/_lib/auth.ts). Any employee
--                        could read it from the browser console and then
--                        read/write offer campaigns, the product catalog and
--                        image uploads directly, as the workspace.
--   company_email, bank + payment details, advertising.* provider config, and
--   anything added to this table later — the default for a new key is
--   "readable by everyone with a login".
--
-- The anon key is public by construction (it ships in the client bundle), so
-- "authenticated" here means any employee, on any machine, via the REST API —
-- no UI, no permission check, no audit trail.
--
-- THE FIX
-- This table is key/value, so row-level security is enough for column-level
-- intent: authenticated users may read only the presentation keys the browser
-- genuinely needs, and admins (or holders of settings.access) may read all.
--
-- WHY THIS BREAKS NOTHING — verified by reading every call site:
--   * The ONLY browser-side read of this table is
--     src/components/ui/dynamic-favicon.tsx, which selects exactly one key:
--     `favicon_url`. It is in the allowlist below.
--   * Every other reader — feature-flags.ts, branding-engine.ts,
--     build-payslip.ts, service-scope.ts, notify.ts, google-sheets/sync.ts,
--     advertising/pipeline.ts, the figma auth guard, the cron routes, the
--     settings/intake/portal server actions and pages — takes a service-role
--     admin client, which bypasses RLS entirely and is unaffected.
--   * Settings WRITES already go through server actions on the service role;
--     no browser client writes to this table.
--
-- The allowlist is deliberately branding-only. Adding a key to it is a
-- conscious decision to make that value readable by every employee.
--
-- Idempotent. Transactional: applies completely or not at all.
-- Rollback: supabase/rollbacks/20260815090000_company_settings_secret_rls_down.sql
-- ============================================================================

BEGIN;

-- The blanket policy from 20260801100000 / 20260801110000. Both spellings are
-- dropped because the two migrations named it differently depending on which
-- one reached this table first.
DROP POLICY IF EXISTS "company_settings_authenticated" ON public.company_settings;
DROP POLICY IF EXISTS "allow_all" ON public.company_settings;

-- ── READ ─────────────────────────────────────────────────────────────────────
-- Branding keys for everyone; everything else for settings holders only.
DROP POLICY IF EXISTS "company_settings_select_public_keys" ON public.company_settings;
CREATE POLICY "company_settings_select_public_keys"
  ON public.company_settings FOR SELECT
  TO authenticated
  USING (
    key IN (
      'favicon_url',      -- read directly by DynamicFavicon in the browser
      'logo_url',
      'logo_url_dark',
      'logo_url_light',
      'company_name'
    )
    OR has_permission(auth.uid(), 'settings.access')
  );

-- ── WRITE ────────────────────────────────────────────────────────────────────
-- No browser client writes this table today; these policies keep it that way
-- rather than leaving writes on `USING (true)`. Server actions run as the
-- service role and are unaffected either way.
DROP POLICY IF EXISTS "company_settings_insert_perm" ON public.company_settings;
CREATE POLICY "company_settings_insert_perm"
  ON public.company_settings FOR INSERT
  TO authenticated
  WITH CHECK (has_permission(auth.uid(), 'settings.access'));

DROP POLICY IF EXISTS "company_settings_update_perm" ON public.company_settings;
CREATE POLICY "company_settings_update_perm"
  ON public.company_settings FOR UPDATE
  TO authenticated
  USING (has_permission(auth.uid(), 'settings.access'))
  WITH CHECK (has_permission(auth.uid(), 'settings.access'));

DROP POLICY IF EXISTS "company_settings_delete_perm" ON public.company_settings;
CREATE POLICY "company_settings_delete_perm"
  ON public.company_settings FOR DELETE
  TO authenticated
  USING (has_permission(auth.uid(), 'settings.access'));

-- Belt and braces: 20260801100000 already revoked anon, but this table is the
-- one that must never regress, and the statement is idempotent.
REVOKE ALL ON public.company_settings FROM anon;

COMMIT;
