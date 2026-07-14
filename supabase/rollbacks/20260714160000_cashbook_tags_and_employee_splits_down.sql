-- Rollback for 20260714160000_cashbook_tags_and_employee_splits.sql
-- Purely additive migration; dropping these tables loses only tags and
-- employee cost splits themselves (cashbook_entries and everything else are
-- untouched). App code degrades gracefully if these tables are absent.

BEGIN;

DROP TABLE IF EXISTS public.cashbook_entry_employee_splits;
DROP TABLE IF EXISTS public.cashbook_entry_tags;
DROP TABLE IF EXISTS public.cashbook_tags;

COMMIT;
