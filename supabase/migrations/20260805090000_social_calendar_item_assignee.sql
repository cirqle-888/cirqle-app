-- Optional designer on a social calendar item.
--
-- WHY: planners already know who should draw a piece while laying out the
-- month, but the answer had nowhere to live until the item reached the
-- Requests inbox. `task_requests.assigned_employee_id` already exists — this
-- column is simply the same answer, recorded one step earlier, and
-- pushItemsToRequests carries it across.
--
-- NULLABLE BY DESIGN: "decide later" is the common, valid case. Planning must
-- never block on staffing.
--
-- ON DELETE SET NULL: archiving/removing an employee must never cascade into
-- deleting planned work — the item survives, unassigned.
--
-- Safe to run more than once; the app also degrades gracefully WITHOUT this
-- column (PATCH_COLUMNS in the social-calendar actions strips it and warns),
-- so applying it is what switches the feature on rather than what stops a
-- crash.

BEGIN;

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS assigned_employee_id UUID
  REFERENCES public.employees(id) ON DELETE SET NULL;

-- Partial index: only assigned rows are ever looked up by designer, and the
-- overwhelming majority stay NULL.
CREATE INDEX IF NOT EXISTS social_calendar_items_assigned_employee_idx
  ON public.social_calendar_items (assigned_employee_id)
  WHERE assigned_employee_id IS NOT NULL;

COMMENT ON COLUMN public.social_calendar_items.assigned_employee_id IS
  'Optional designer earmarked at planning time; copied into the pushed request''s assigned_employee_id. NULL = decide in the Requests inbox.';

COMMIT;
