-- Contribution checks: "please look through these jobs and tell me if your
-- credit is right".
--
-- Someone who can see everyone's contributions filters the Contributions list
-- (say: last month, five clients, jobs CQID003 is NOT credited on) and sends
-- it to that person. They answer each job — "Correct" or "I worked on this"
-- with a note — and the answers come back to the sender, who fixes any split
-- that needs it. Answering never changes pay data on its own.
--
--   contribution_checks       — one request: who asks, who answers, the note
--   contribution_check_items  — one row per job in the request, with the answer
--
-- Read and written only through the app's server actions (service role), so
-- RLS is on with no policies: nothing is reachable with a browser key.

BEGIN;

CREATE TABLE IF NOT EXISTS public.contribution_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  note          text,
  -- The filtered Contributions link it was sent from, for the sender.
  view_href     text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  answered_at   timestamptz,
  closed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS contribution_checks_employee_idx  ON public.contribution_checks (employee_id, status);
CREATE INDEX IF NOT EXISTS contribution_checks_requester_idx ON public.contribution_checks (requested_by, status);

CREATE TABLE IF NOT EXISTS public.contribution_check_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id    uuid NOT NULL REFERENCES public.contribution_checks(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  answer      text CHECK (answer IN ('correct', 'worked')),
  comment     text,
  answered_at timestamptz,
  UNIQUE (check_id, task_id)
);

CREATE INDEX IF NOT EXISTS contribution_check_items_check_idx ON public.contribution_check_items (check_id);

ALTER TABLE public.contribution_checks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contribution_check_items ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.contribution_checks IS
  'A filtered list of jobs sent to one person to confirm their contribution credit. Answers never change pay data by themselves.';

COMMIT;
