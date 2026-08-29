-- ═══════════════════════════════════════════════════════════════════════════
-- Work we owe a client that is not a task and not a bill
--
-- WHY
--   Two things kept falling through. Complimentary extras promised alongside a
--   package — a set of Instagram highlight icons, a profile picture — and the
--   setup a new brand needs before any work can start: a Facebook page, an
--   Instagram account, Meta Business configuration. Both must be DONE, both
--   must be somebody's job, and neither is a task: there is no price, no
--   invoice line and no commission. Written down anywhere else, they get
--   forgotten.
--
--   They are already shaped like a request — a client, a title, an assignee, a
--   due date — and the Requests page and My Work board already do exactly the
--   right things with that shape. So this is one column, not a new module.
--
-- WHAT THIS DOES
--   task_requests.kind — 'request' (everything that exists today) or
--   'checklist' (complimentary work and onboarding steps).
--
--   A checklist item behaves like a request on the board and in the inbox, and
--   differs in three ways, all enforced in the app:
--     • starting it never creates a task, so it can never reach an invoice
--     • it never appears on the client's portal or track page
--     • it never emails the client
--
-- Every existing row becomes 'request', which is what they all are.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.task_requests
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'request';

DO $$
BEGIN
  ALTER TABLE public.task_requests
    ADD CONSTRAINT task_requests_kind_check
    CHECK (kind IN ('request', 'checklist'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.task_requests.kind IS
  'request = client work that becomes a task. checklist = complimentary or setup work: never a task, never billed, never shown to the client.';

-- Every client-facing read filters on this, and the inbox filters on it too.
-- Partial: checklist items are the rare kind, so this stays small.
CREATE INDEX IF NOT EXISTS idx_task_requests_checklist
  ON public.task_requests (client_id, status)
  WHERE kind = 'checklist';

COMMIT;
