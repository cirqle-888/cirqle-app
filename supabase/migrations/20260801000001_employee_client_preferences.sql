-- ============================================================================
-- employee_client_preferences — per-employee greeting names for clients
-- ============================================================================
--
-- The mirror of 20260801000000_employee_partner_preferences for clients, and
-- deliberately identical to it in shape. The Follow-ups screen reads both in
-- one Promise.all and merges them into the same greeting map, so any structural
-- difference between the two is a bug waiting to happen.
--
-- ── Why this file was rewritten (2026-08-30) ────────────────────────────────
--
-- The original version could never have applied. It ended with:
--
--     CREATE TRIGGER set_employee_client_preferences_updated_at
--       BEFORE UPDATE ON public.employee_client_preferences
--       FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
--
-- `public.handle_updated_at()` does not exist in this database — the trigger
-- functions here are named set_updated_at, update_updated_at and
-- update_allocations_updated_at_column. CREATE TRIGGER against a missing
-- function aborts, and since the whole file is one implicit transaction,
-- nothing in it committed. That is why the table was still missing on
-- 2026-08-29 while the code that reads it had been shipped for weeks.
--
-- The trigger is dropped rather than repointed: the partner table has no
-- updated-at trigger either, and `updated_at` is written explicitly by the
-- server action on every upsert.
--
-- Two other corrections, both to match the reader:
--
--   * employee_id references employees(id), NOT auth.users(id). The original
--     pointed at auth.users while follow-ups/page.tsx filters on
--     `me.employeeId` — the employees-table id — so every read would have
--     matched nothing even once the table existed.
--   * No RLS policies. Every access path (page.tsx, actions.ts, and the partner
--     equivalent) goes through the service role, which bypasses RLS. RLS is
--     enabled with no policy so that a future browser query is denied by
--     default rather than silently allowed.
--
-- Idempotent. Rollback: supabase/rollbacks/20260801000001_employee_client_preferences_down.sql
-- ============================================================================

create table if not exists employee_client_preferences (
  employee_id uuid references employees(id) on delete cascade,
  client_id uuid references clients(id) on delete cascade,
  greeting_name text,
  updated_at timestamptz default now(),
  primary key (employee_id, client_id)
);

alter table employee_client_preferences enable row level security;
