-- ============================================================
-- Request Portal v1.1 refinements
-- ============================================================
-- 1. clients.drive_folder_link — the per-client Google Drive root folder
--    (design §7). Set by admin; shown on the client's intake portal so they
--    can create task folders and upload content there.
-- 2. task_requests.priority_rank — client-set ordering of their OPEN requests
--    (1 = do first). Auto-assigned on submit (last), reorderable in the
--    portal's My Requests tab.
-- Both additive + nullable — safe on live data.
-- ============================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS drive_folder_link text;
COMMENT ON COLUMN public.clients.drive_folder_link IS
  'Per-client Google Drive root folder shared with the client (intake portal upload area).';

ALTER TABLE public.task_requests
  ADD COLUMN IF NOT EXISTS priority_rank integer;
COMMENT ON COLUMN public.task_requests.priority_rank IS
  'Client-set rank among their open requests (1 = first). Null after completion.';

-- 3. Allow clients to CANCEL their own (not-yet-started) requests.
ALTER TABLE public.task_requests DROP CONSTRAINT IF EXISTS task_requests_status_check;
ALTER TABLE public.task_requests ADD CONSTRAINT task_requests_status_check CHECK (status IN
  ('submitted','under_review','approved','started','in_progress',
   'waiting_for_content','revision_requested','completed','delivered',
   'rejected','archived','cancelled'));
