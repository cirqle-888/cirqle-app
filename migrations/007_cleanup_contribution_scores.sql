-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: Clean up contribution_scores — orphans, zeros, duplicates
-- ─────────────────────────────────────────────────────────────────────────────
-- ROOT CAUSE (confirmed via Supabase SQL editor, 2026-05-25)
-- ----------------------------------------------------------
-- The bulk-import pipeline inserted contribution_scores rows for EVERY employee
-- assigned to EVERY task, even employees who did zero work on that task.
-- These rows have score_percentage = 0 and earnings_inr = 0.
-- They are valid FK references (task_id IS NOT NULL, task exists), so the
-- !inner join does NOT exclude them. They inflate "My Contributions" counts
-- and show years the employee was never active (CQID002 showed 47 x 2023 rows
-- despite joining after 2024 — all with score_percentage = 0).
--
-- Evidence:
--   All 47 rows for CQID002 with task_date < 2024-01-01 have score_percentage = 0
--   and calculated_at = 2026-05-23 05:07:17 (the recalculation run timestamp).
--   Task #1 "Onam" (2023-08-23): CQID001 = 100%, CQID002 = 0%, CQID003 = 0%.
--
-- Secondary issues also confirmed:
--   • Rows with task_id IS NULL (import pipeline failures)
--   • Stale FK rows where the task was later deleted
--   • Multiple rows per (task_id, employee_id) from repeated recalculations
--
-- This migration:
--   Step 1 — Delete score_percentage = 0 rows (no real contribution)
--   Step 2 — Delete rows with NULL task_id (pure orphans)
--   Step 3 — Delete rows where referenced task no longer exists (stale FKs)
--   Step 4 — Deduplicate: keep only MAX(id) per (task_id, employee_id)
--   Step 5 — Add NOT NULL constraint on task_id
--   Step 6 — Recreate UNIQUE(task_id, employee_id) as a proper table constraint
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Step 1: Delete 0% score rows ─────────────────────────────────────────────
-- score_percentage = 0 means the employee was listed as a potential contributor
-- but did no actual work. These rows must not count toward contribution totals,
-- yearly charts, or "My Contributions" KPIs.
-- The application layer now filters score_percentage > 0 on both paths, so
-- these rows would never appear in dashboards even if kept — but deleting them
-- removes the data-integrity risk permanently.
DELETE FROM contribution_scores
WHERE score_percentage = 0
   OR score_percentage IS NULL;

-- ── Step 2: Delete rows with NULL task_id ────────────────────────────────────
-- Pure orphans: inserted when the import pipeline had no valid task to reference.
-- PostgreSQL treats each NULL as distinct so UNIQUE(task_id, employee_id)
-- cannot deduplicate them.
DELETE FROM contribution_scores
WHERE task_id IS NULL;

-- ── Step 3: Delete stale FK rows (task deleted after score was created) ───────
DELETE FROM contribution_scores cs
WHERE NOT EXISTS (
  SELECT 1 FROM tasks t WHERE t.id = cs.task_id
);

-- ── Step 4: Deduplicate — keep newest row per (task_id, employee_id) ─────────
-- Repeated recalculations create multiple rows for the same pair. Keep the
-- row with the latest calculated_at (most recent score). id is a UUID so
-- MAX(id) does not work — use DISTINCT ON with ORDER BY calculated_at DESC.
DELETE FROM contribution_scores
WHERE id NOT IN (
  SELECT DISTINCT ON (task_id, employee_id) id
  FROM contribution_scores
  ORDER BY task_id, employee_id, calculated_at DESC
);

-- ── Step 5: Add NOT NULL constraint on task_id ───────────────────────────────
-- Steps 1–2 must have cleared all NULLs for this to succeed.
ALTER TABLE contribution_scores
  ALTER COLUMN task_id SET NOT NULL;

-- ── Step 6: Recreate UNIQUE(task_id, employee_id) as a proper constraint ─────
-- The pre-existing constraint may have been a plain index; replace it with a
-- named table constraint so violations are caught at INSERT/UPDATE time.
DO $$
BEGIN
  BEGIN
    ALTER TABLE contribution_scores
      DROP CONSTRAINT IF EXISTS contribution_scores_task_id_employee_id_key;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    DROP INDEX IF EXISTS contribution_scores_task_id_employee_id_idx;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$$;

ALTER TABLE contribution_scores
  ADD CONSTRAINT contribution_scores_task_employee_unique
  UNIQUE (task_id, employee_id);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries — run in Supabase SQL editor after applying
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. No zero/null scores remain:
--    SELECT COUNT(*) FROM contribution_scores WHERE score_percentage <= 0 OR score_percentage IS NULL;
--    → must return 0

-- 2. No NULL task_id rows remain:
--    SELECT COUNT(*) FROM contribution_scores WHERE task_id IS NULL;
--    → must return 0

-- 3. No stale FK rows remain:
--    SELECT COUNT(*) FROM contribution_scores cs
--    WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = cs.task_id);
--    → must return 0

-- 4. No duplicate (task_id, employee_id) pairs remain:
--    SELECT task_id, employee_id, COUNT(*) c FROM contribution_scores
--    GROUP BY task_id, employee_id HAVING COUNT(*) > 1;
--    → must return 0 rows

-- 5. CQID002 year distribution (should be 2024+ only after cleanup):
--    SELECT date_part('year', t.task_date) AS year, COUNT(*) AS count
--    FROM contribution_scores cs
--    JOIN tasks t ON t.id = cs.task_id
--    JOIN employees e ON e.id = cs.employee_id
--    WHERE e.cqid = 'CQID002'
--    GROUP BY year ORDER BY year;
--    → rows for 2023 must be gone

-- 6. Per-employee count sanity check (total company tasks ~1691):
--    SELECT e.cqid, COUNT(cs.id) AS contributions
--    FROM employees e
--    LEFT JOIN contribution_scores cs ON cs.employee_id = e.id
--    GROUP BY e.cqid ORDER BY contributions DESC;
--    → no single employee should equal total task count
