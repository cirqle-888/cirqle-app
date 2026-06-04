-- ────────────────────────────────────────────────────────────────────────────
-- Migration 012: Soft-delete support for tasks
-- Adds deleted_at column so tasks can be moved to trash and recovered.
-- Safe to run multiple times (IF NOT EXISTS guard).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Partial index for fast active-task queries (excludes trashed rows)
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at
  ON tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Force PostgREST to pick up the new column immediately
NOTIFY pgrst, 'reload schema';
