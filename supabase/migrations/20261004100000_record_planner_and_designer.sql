-- Record who planned and who designed a piece of work
--
-- The Contributions page now suggests contributions from how work moved
-- through Cirqle: who PLANNED it (created the request, added the calendar
-- item) and who DESIGNED it (the assignee who moved its My Work card on).
-- Two of those facts were never stored:
--
--   1. task_requests had no creator — a staff-created request did not say
--      who planned it.
--   2. social_calendar_items had no creator — only the month's plan
--      (social_calendars.created_by) did, so every item on a plan was
--      credited to whoever made the plan.
--
-- Both columns are nullable and set by the app from now on
-- (createManualRequest, addCalendarItem). Existing rows stay NULL — there is
-- no record of who created them, and guessing would put a planner's share of
-- the commission pool on the wrong person. The suggestion falls back to the
-- plan's owner, and says so.
--
-- 3. Tasks made from My Work carried no assignee. The app now records the
--    designer on every move; this backfills existing work from the request or
--    calendar item it came from, using who that was ASSIGNED to — a recorded
--    fact, not a guess. Up to 19 rows at time of writing (deleted tasks are skipped).
--
-- Safe in either order with the code: the app drops created_by when the
-- column is missing, and assignments are only ever added.

BEGIN;

ALTER TABLE public.task_requests
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.employees(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.task_requests.created_by IS
  'Staff member who created the request (planner). NULL for client/portal/intake requests and for rows created before 2026-10-04.';

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.employees(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.social_calendar_items.created_by IS
  'Staff member who added the item to the plan (planner). NULL for items created before 2026-10-04.';

-- Backfill task assignees from the request / calendar item each task came from.
INSERT INTO public.task_assignments (task_id, employee_id)
SELECT DISTINCT src.task_id, src.employee_id
  FROM (
    SELECT r.promoted_task_id AS task_id, r.assigned_employee_id AS employee_id
      FROM public.task_requests r
     WHERE r.promoted_task_id IS NOT NULL AND r.assigned_employee_id IS NOT NULL
    UNION
    SELECT i.task_id, i.assigned_employee_id
      FROM public.social_calendar_items i
     WHERE i.task_id IS NOT NULL AND i.assigned_employee_id IS NOT NULL
  ) src
  JOIN public.tasks t ON t.id = src.task_id AND t.deleted_at IS NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM public.task_assignments a
    WHERE a.task_id = src.task_id AND a.employee_id = src.employee_id
 );

COMMIT;
