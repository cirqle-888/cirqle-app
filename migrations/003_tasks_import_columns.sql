-- ────────────────────────────────────────────────────────────────────────────
-- Migration 003: Add missing columns to tasks required by Bulk Import
-- Run this in Supabase SQL Editor → fixes the import errors immediately
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS task_number        INTEGER,
  ADD COLUMN IF NOT EXISTS quantity           DECIMAL(10,2) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_recurring       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_interval TEXT
    CHECK (recurring_interval IN ('daily','weekly','monthly','yearly') OR recurring_interval IS NULL),
  ADD COLUMN IF NOT EXISTS recurring_end_date DATE;

-- Unique index so task numbers don't clash (optional but recommended)
CREATE UNIQUE INDEX IF NOT EXISTS tasks_task_number_key ON tasks (task_number)
  WHERE task_number IS NOT NULL;
