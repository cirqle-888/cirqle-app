-- Direct calendar → task link, skipping the Requests inbox.
--
-- WHY: the planner had exactly one way out — push to Requests, then promote
-- from the inbox. That is the right route for client-visible work (it leaves a
-- REQ trail and a portal timeline the client can follow), but it is pure
-- overhead for internal pieces nobody outside the office tracks. This column
-- is the second exit: item → task, no request in between.
--
-- The trade-off is deliberate and one-way: a directly-tasked item has NO
-- task_request, so it never appears on the client's request portal and carries
-- no REQ number. Items that need that trail must still go through Requests.
--
-- ON DELETE SET NULL: deleting or trashing a task must never cascade into
-- deleting planned work — the item survives and falls back to 'planned' via
-- the app's revert path.
--
-- Safe to run more than once. The app degrades gracefully WITHOUT this column
-- (the social-calendar reads strip unknown columns and retry), so applying
-- this is what switches the feature on rather than what stops a crash.

BEGIN;

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS task_id UUID
  REFERENCES public.tasks(id) ON DELETE SET NULL;

-- 'tasked' — pushed straight to a task, no request. Kept distinct from
-- 'requested' so the two exits stay tellable apart in queries and in the
-- planner's own status chip.
ALTER TABLE public.social_calendar_items
  DROP CONSTRAINT IF EXISTS social_calendar_items_status_check;
ALTER TABLE public.social_calendar_items
  ADD CONSTRAINT social_calendar_items_status_check
  CHECK (status IN ('planned', 'requested', 'tasked', 'cancelled'));

-- Partial index: only directly-tasked rows are ever looked up by task, and the
-- overwhelming majority stay NULL.
CREATE INDEX IF NOT EXISTS social_calendar_items_task_idx
  ON public.social_calendar_items (task_id)
  WHERE task_id IS NOT NULL;

-- One task belongs to at most one calendar item. The app claims the link with
-- a conditional UPDATE, but two concurrent pushes that both created their own
-- task must not be able to converge on the same row afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS social_calendar_items_task_unique_idx
  ON public.social_calendar_items (task_id)
  WHERE task_id IS NOT NULL;

COMMENT ON COLUMN public.social_calendar_items.task_id IS
  'Task created directly from this item, bypassing the Requests inbox. Mutually exclusive with request_id: an item takes one exit or the other, never both. NULL = not yet tasked directly.';

COMMIT;
