-- Activate the dormant `notifications` table (it existed in the base schema
-- since day one but no code ever wrote to it — confirmed empty, zero
-- references). Adds what's needed to use it as the foundation for the new
-- crons (recurring-task top-up, payroll auto-draft) and Smart Focus:
--
--   - source_key: idempotency key so a cron re-run for the same period
--     (e.g. 'payroll_draft:2026-06') doesn't write a duplicate notification.
--   - indexes for the two real query shapes: "unread for me" (bell dropdown)
--     and recency ordering.
--
-- "Broadcast to all admins" notifications are FANNED OUT as one row per
-- admin employee_id (NOT a single shared employee_id=NULL row) — a shared
-- row would mean one admin marking it read hides it for every other admin.
-- The unique index is therefore (type, source_key, employee_id): one row
-- per admin per period, each independently readable/markable.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS source_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_source_key_uniq
  ON notifications (type, source_key, employee_id)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_employee_unread_idx
  ON notifications (employee_id, read, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_created_at_idx
  ON notifications (created_at DESC);
