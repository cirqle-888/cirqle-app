-- Request portal v1.2 — Cancelled status + pipeline value
-- 1. Allow 'cancelled' in task_requests.status (core.ts already types it;
--    the original CHECK constraint shipped without it).
-- 2. estimated_value: optional ₹ value per request so admins can see the
--    pipeline value of pending/active work before tasks (and billing) exist.

ALTER TABLE public.task_requests
  DROP CONSTRAINT IF EXISTS task_requests_status_check;

ALTER TABLE public.task_requests
  ADD CONSTRAINT task_requests_status_check CHECK (status IN
    ('submitted','under_review','approved','started','in_progress',
     'waiting_for_content','revision_requested','completed','delivered',
     'rejected','archived','cancelled'));

ALTER TABLE public.task_requests
  ADD COLUMN IF NOT EXISTS estimated_value numeric;

COMMENT ON COLUMN public.task_requests.estimated_value IS
  'Optional staff-entered pipeline value (INR). Falls back to client/service pricing in the UI when null.';
