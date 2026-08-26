-- ============================================================================
-- "My Work" — a designer's own queue, and the narrow permission behind it
-- ============================================================================
-- Additive, idempotent, INSERT-only. Safe to re-run.
--
-- THE PROBLEM
-- A designer needs two things: see what is pending FOR THEM, and say when it
-- is done. Today the only way to move a request to in_progress / delivered /
-- completed is requests.manage (see STATUS_PERM in requests/actions.ts), which
-- also grants the entire inbox: every client's requests, bulk status changes,
-- reassignment, cancellation, intake links. Handing that to a designer to let
-- them tick their own work off is wildly disproportionate.
--
-- requests.work_own is the narrow key. It answers exactly one question — "may
-- this person advance a request that is ALREADY ASSIGNED TO THEM?" — and the
-- server action enforces the assignment check and a safe subset of statuses on
-- top of it (no cancel, no reject, no archive, no reassignment).
--
-- WHY A NEW DESIGNATION RATHER THAN EDITING "Employee"
-- An employee holds exactly ONE designation (employees.designation_id is a
-- single FK; no join table — see 20260823160000). Adding the key to "Employee"
-- would hand it to everyone on that designation, most of whom are never
-- assigned requests. "Designer" is the union of what "Employee" already has
-- plus this one key.
--
-- DELIBERATELY ABSENT
--   requests.view ...... would open the full inbox; My Work reads only the
--                        caller's own assigned rows and gates on work_own
--   requests.manage/review/start, tasks.view_all, tasks.view_pricing,
--   clients.view, billing.*, payroll.*, reports.*, settings.*
--
-- NOTE: this grants the ABILITY to work an assigned queue. It does not assign
-- anything. Requests reach a designer only when someone sets
-- task_requests.assigned_employee_id — as of this migration exactly 4 requests
-- in the whole database carry an assignee, and all 4 are already completed.
-- ============================================================================

BEGIN;

-- ── 1. The permission ────────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('requests', 'work_own', 'requests.work_own',
   'Work Own Assigned Requests',
   'See a personal board of requests assigned to you and move them between To Do / Working / Delivered / Done. Grants no access to anyone else''s requests, and cannot cancel, reject or reassign.',
   47)
ON CONFLICT (key) DO NOTHING;

-- Admins get every key, same as every other module's migration.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key = 'requests.work_own'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- ── 2. The designation ───────────────────────────────────────────────────────
INSERT INTO public.designations (name, description, is_admin, is_system, display_order)
SELECT v.name, v.description, v.is_admin, v.is_system, v.display_order
  FROM (VALUES
    ('Designer',
     'Creative staff who deliver assigned work. Sees a personal My Work board of requests assigned to them and marks them done; scores their own contributions. No access to the Requests inbox, other people''s work, client lists, pricing or payroll.',
     false, false, 37)
  ) AS v(name, description, is_admin, is_system, display_order)
 WHERE NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.name = v.name);

WITH wanted(role_name, perm_key) AS (
  VALUES
    -- everything "Employee" already carries …
    ('Designer', 'dashboard.view'),
    ('Designer', 'tasks.view_own'),
    ('Designer', 'tasks.create'),
    ('Designer', 'contributions.view_own'),
    ('Designer', 'contributions.edit'),
    ('Designer', 'chat.access'),
    ('Designer', 'chat.client_conversations'),
    -- … plus the one key this designation exists for
    ('Designer', 'requests.work_own')
)
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, true
  FROM wanted w
  JOIN public.designations d ON d.name = w.role_name
  JOIN public.permissions  p ON p.key  = w.perm_key
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = true;

-- ── 3. Index for the one query My Work runs ──────────────────────────────────
-- "my open requests, soonest due first". Partial: only assigned rows are ever
-- read this way and today the overwhelming majority are NULL.
CREATE INDEX IF NOT EXISTS task_requests_assignee_status_idx
  ON public.task_requests (assigned_employee_id, status)
  WHERE assigned_employee_id IS NOT NULL;

COMMIT;
