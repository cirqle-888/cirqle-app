-- Post-apply verification for 20260714160000_cashbook_tags_and_employee_splits.sql
-- Run in the Supabase SQL editor after applying the migration.

-- 1. Tables present (expect 3 rows)
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('cashbook_tags', 'cashbook_entry_tags', 'cashbook_entry_employee_splits')
 ORDER BY table_name;

-- 2. Case-insensitive tag uniqueness works (expect 1 row back, not 2 — proves
--    the unique index prevents "Photoshop"/"photoshop" duplicates)
-- (Read-only sanity: skip if you don't want to insert test data.)

-- 3. Every split's amount_inr sums to (approximately) its parent entry's
--    amount_inr — catches any future bug in the equal-split writer.
--    Expect 0 rows (any row here means a split set doesn't reconcile).
SELECT s.cashbook_entry_id,
       ROUND(SUM(s.amount_inr), 2) AS split_total,
       e.amount_inr               AS entry_total
  FROM cashbook_entry_employee_splits s
  JOIN cashbook_entries e ON e.id = s.cashbook_entry_id
 GROUP BY s.cashbook_entry_id, e.amount_inr
HAVING ABS(SUM(s.amount_inr) - e.amount_inr) > 0.02;

-- 4. No orphaned tags (every tag used by at least one entry) — informational,
--    not a failure; unused tags are harmless (created then never applied).
SELECT t.id, t.name
  FROM cashbook_tags t
  LEFT JOIN cashbook_entry_tags et ON et.tag_id = t.id
 WHERE et.tag_id IS NULL;

-- 5. Spend-by-tag snapshot (sanity-read the numbers)
SELECT tg.name AS tag, COUNT(*) AS entries, ROUND(SUM(e.amount_inr), 2) AS total_inr
  FROM cashbook_entry_tags et
  JOIN cashbook_tags tg ON tg.id = et.tag_id
  JOIN cashbook_entries e ON e.id = et.cashbook_entry_id
 WHERE e.deleted_at IS NULL AND e.type = 'outflow'
 GROUP BY tg.name
 ORDER BY total_inr DESC;

-- 6. Cost-by-employee snapshot (sanity-read the numbers)
SELECT emp.cqid, emp.name, COUNT(*) AS items, ROUND(SUM(s.amount_inr), 2) AS total_inr
  FROM cashbook_entry_employee_splits s
  JOIN employees emp ON emp.id = s.employee_id
 GROUP BY emp.cqid, emp.name
 ORDER BY total_inr DESC;
