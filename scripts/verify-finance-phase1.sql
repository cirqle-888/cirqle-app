-- Post-apply verification for 20260714090000_finance_scope_foundation.sql
-- Run in the Supabase SQL editor after applying the migration.
-- Every check states its PASS condition; anything else needs a look.

-- 1. Column presence (expect 6 rows)
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE (table_name = 'tasks'               AND column_name = 'scope')
    OR (table_name = 'ad_projects'         AND column_name = 'scope')
    OR (table_name = 'cashbook_entries'    AND column_name = 'scope')
    OR (table_name = 'cashbook_categories' AND column_name IN
        ('statement_section','account_code','default_scope'))
 ORDER BY table_name, column_name;

-- 2. Backfill totality: tasks + ad_projects must have ZERO null scopes
SELECT 'tasks' AS t, count(*) AS null_scope FROM tasks WHERE scope IS NULL
UNION ALL
SELECT 'ad_projects', count(*) FROM ad_projects WHERE scope IS NULL;
-- PASS: both counts 0

-- 3. Integrity: no 'client'-scoped row may lack a client (expect all zeros)
SELECT 'tasks' AS t, count(*) AS bad FROM tasks
 WHERE scope = 'client' AND client_id IS NULL
UNION ALL
SELECT 'ad_projects', count(*) FROM ad_projects
 WHERE scope = 'client' AND client_id IS NULL
UNION ALL
SELECT 'cashbook_entries', count(*) FROM cashbook_entries
 WHERE scope = 'client' AND client_id IS NULL;

-- 4. Scope distribution snapshot (sanity-read the numbers)
SELECT scope, count(*) FROM cashbook_entries
 WHERE deleted_at IS NULL GROUP BY scope ORDER BY scope;
SELECT scope, count(*) FROM tasks
 WHERE deleted_at IS NULL GROUP BY scope ORDER BY scope;
SELECT scope, count(*) FROM ad_projects
 WHERE deleted_at IS NULL GROUP BY scope ORDER BY scope;

-- 5. Triage queue size: rows Phase 3's queue will ask you to classify
SELECT count(*) AS untriaged_cashbook_rows,
       min(entry_date) AS oldest, max(entry_date) AS newest
  FROM cashbook_entries WHERE scope IS NULL AND deleted_at IS NULL;

-- 6. Category mapping coverage — any row here renders as "Unclassified" in
--    the P&L until you map it (edit statement_section/account_code directly)
SELECT id, name, type, category_group
  FROM cashbook_categories
 WHERE statement_section IS NULL AND is_active
 ORDER BY type, display_order;

-- 7. Trigger shim behaviour (read-only inspection of trigger presence)
SELECT tgname, tgrelid::regclass AS on_table
  FROM pg_trigger
 WHERE tgname IN ('trg_derive_task_scope','trg_derive_ad_project_scope',
                  'trg_derive_cashbook_scope');
-- PASS: 3 rows

-- 8. Constraints present (expect 8 rows)
SELECT conname FROM pg_constraint WHERE conname IN
  ('tasks_scope_valid','tasks_scope_client_integrity',
   'ad_projects_scope_valid','ad_projects_scope_client_integrity',
   'cashbook_entries_scope_valid','cashbook_entries_scope_client_integrity',
   'cashbook_categories_section_valid','cashbook_categories_default_scope_valid')
 ORDER BY conname;
