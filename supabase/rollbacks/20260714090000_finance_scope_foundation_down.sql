-- Rollback for 20260714090000_finance_scope_foundation.sql
-- Fully reverses Phase 1. No data loss is possible in either direction:
-- the migration only ADDS columns/triggers/constraints, so dropping them
-- returns the schema to its exact prior state. Any scope/section values
-- entered meanwhile are discarded with the columns (by design).

BEGIN;

DROP TRIGGER IF EXISTS trg_derive_task_scope       ON public.tasks;
DROP TRIGGER IF EXISTS trg_derive_ad_project_scope ON public.ad_projects;
DROP TRIGGER IF EXISTS trg_derive_cashbook_scope   ON public.cashbook_entries;
DROP FUNCTION IF EXISTS public.derive_task_scope();
DROP FUNCTION IF EXISTS public.derive_cashbook_scope();

DROP INDEX IF EXISTS cashbook_entries_scope_idx;
DROP INDEX IF EXISTS cashbook_entries_scope_triage_idx;
DROP INDEX IF EXISTS tasks_scope_idx;

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_scope_valid,
  DROP CONSTRAINT IF EXISTS tasks_scope_client_integrity,
  DROP COLUMN IF EXISTS scope;

ALTER TABLE public.ad_projects
  DROP CONSTRAINT IF EXISTS ad_projects_scope_valid,
  DROP CONSTRAINT IF EXISTS ad_projects_scope_client_integrity,
  DROP COLUMN IF EXISTS scope;

ALTER TABLE public.cashbook_entries
  DROP CONSTRAINT IF EXISTS cashbook_entries_scope_valid,
  DROP CONSTRAINT IF EXISTS cashbook_entries_scope_client_integrity,
  DROP COLUMN IF EXISTS scope;

ALTER TABLE public.cashbook_categories
  DROP CONSTRAINT IF EXISTS cashbook_categories_section_valid,
  DROP CONSTRAINT IF EXISTS cashbook_categories_default_scope_valid,
  DROP COLUMN IF EXISTS statement_section,
  DROP COLUMN IF EXISTS account_code,
  DROP COLUMN IF EXISTS default_scope;

COMMIT;
