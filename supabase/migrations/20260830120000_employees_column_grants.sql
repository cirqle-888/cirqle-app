-- ============================================================================
-- employees — column-level grants for `authenticated`   ** NOT YET APPLIED **
-- ============================================================================
--
-- Split out of 20260815110000 on 2026-08-30. That migration's broad revoke is
-- applied; this half is blocked on a code change, and applying it early breaks
-- two features.
--
-- ── WHAT IT FIXES ───────────────────────────────────────────────────────────
--
-- `authenticated` currently holds ALL 29 columns of `employees`, including
-- base_salary, hourly_rate, bank_details, date_of_birth and invite_token. Any
-- logged-in employee can read every colleague's pay and bank details straight
-- from the browser.
--
-- It is not theoretical. /dashboard/import is gated on `tasks.create` — a
-- permission most employees have — and its Export tab runs, in the browser:
--
--     supabase.from('employees').select('*')
--
-- so anyone who can create a task can export the whole salary table to a
-- spreadsheet. This grant closes that.
--
-- ── WHY IT CANNOT BE APPLIED YET ────────────────────────────────────────────
--
-- A column-level GRANT is role-level: no RLS policy can widen it, and
-- `select('*')` fails outright once some columns are ungranted. Two browser
-- paths would break, both in dashboard/import/import-client.tsx:
--
--   * Export (lines ~552, ~557)  `.from('employees').select('*')`
--   * Import (lines ~1208-1218)  `.insert()` / `.upsert()` on employees, plus a
--                                `.select('*')` read-back
--
-- The import screen is a large client component that talks to PostgREST
-- directly. Making this safe means routing the employees mode through a server
-- action on the service role, gated on a real permission — `settings.access` or
-- an employees-specific key, NOT `tasks.create`.
--
-- Note that fixing the permission gate ALONE is not enough: an admin's browser
-- would still be doing `select('*')` and would still fail. The read has to move
-- server-side either way.
--
-- ── ORDER ───────────────────────────────────────────────────────────────────
--   1. Move the employees import/export path to a server action (service role).
--   2. Re-gate /dashboard/import, or gate the employees mode within it.
--   3. Apply this file.
--   4. Verify: Settings employee editor still loads; export still produces a
--      full sheet; a non-admin session cannot read base_salary via PostgREST.
--
-- Rollback: supabase/rollbacks/20260830120000_employees_column_grants_down.sql
-- ============================================================================

BEGIN;

REVOKE ALL ON public.employees FROM authenticated;

GRANT SELECT (
  id, auth_id, cqid, name, email, avatar_url, role,
  is_active, is_archived, designation_id, current_workspace_id
) ON public.employees TO authenticated;

GRANT UPDATE (avatar_url, current_workspace_id) ON public.employees TO authenticated;

COMMIT;
