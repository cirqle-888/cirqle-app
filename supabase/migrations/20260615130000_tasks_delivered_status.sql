-- ============================================================
-- Add 'delivered' to the tasks.status CHECK constraint
-- ============================================================
-- The Task page is the single source of truth for the request workflow.
-- New task-driven stage flow:
--   pending(New) → in_progress → delivered → done(Completed) → cancelled
--
-- 'delivered' = work sent to the client, awaiting their review. It is a
-- NON-billable intermediate state: auto-draft invoices, batch invoicing,
-- "to be invoiced", reporting and contribution scoring all continue to key
-- on 'done' only, so adding this value changes no billing behaviour.
--
-- The base schema (supabase-schema.sql) created tasks.status with
--   CHECK (status IN ('pending','in_progress','done','invoiced','cancelled'))
-- which would reject 'delivered'. This migration widens it. Idempotent.

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_status_check CHECK (status IN
    ('pending', 'in_progress', 'delivered', 'done', 'invoiced', 'cancelled'));

-- ------------------------------------------------------------
-- One-time data alignment (safe + idempotent)
-- ------------------------------------------------------------
-- Under the OLD mapping, an invoiced/paid linked task mirrored its request to
-- 'delivered'. Under the NEW mapping those map to 'completed'. Re-align any
-- such historical rows so they read "Completed" instead of "Under Review".
-- (A task could not legitimately have been 'delivered' before this migration —
-- the constraint above blocked it — so this only touches legacy invoiced/paid
-- rows, never genuinely-delivered work.)
UPDATE public.task_requests tr
SET status            = 'completed',
    client_status     = 'completed',
    status_updated_at = now(),
    updated_at        = now()
FROM public.tasks t
WHERE tr.promoted_task_id = t.id
  AND tr.status = 'delivered'
  AND t.status IN ('done', 'invoiced', 'paid');
