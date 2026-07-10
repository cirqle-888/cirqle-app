-- ============================================================
-- Phase 2 Performance Indexes
-- Date: 2026-07-09
-- 
-- The following indexes are created to prevent sequential scans 
-- on large foreign key joins added in recent phases.
-- Every index creation is idempotent (IF NOT EXISTS) and non-breaking.
-- ============================================================

-- 1. ad_projects
-- Reason: Project views and reports frequently join `ad_projects` to `clients`.
CREATE INDEX IF NOT EXISTS idx_ad_projects_client_id ON public.ad_projects (client_id);

-- 2. invoice_expense_items
-- Reason: The invoice dashboard frequently looks up expense items by `cashbook_entry_id` or `invoice_id` to generate itemized billing lines.
CREATE INDEX IF NOT EXISTS idx_invoice_expense_items_invoice_id ON public.invoice_expense_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_expense_items_cashbook_entry_id ON public.invoice_expense_items (cashbook_entry_id);

-- 3. allocations (or invoice_allocations if the table is named allocations)
-- Reason: Payments and cashbook transfers look up allocations by `cashbook_entry_id` and `invoice_id`.
DO $$
BEGIN
  IF to_regclass('public.allocations') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_allocations_cashbook_entry_id ON public.allocations (cashbook_entry_id);
    CREATE INDEX IF NOT EXISTS idx_allocations_invoice_id ON public.allocations (invoice_id);
  END IF;
END $$;

-- 4. ad_campaign_mapping
-- Reason: Ad sync workers map active campaigns back to `project_id` and `client_id`.
DO $$
BEGIN
  IF to_regclass('public.ad_campaign_mapping') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_ad_campaign_mapping_project_id ON public.ad_campaign_mapping (project_id);
    CREATE INDEX IF NOT EXISTS idx_ad_campaign_mapping_client_id ON public.ad_campaign_mapping (client_id);
  END IF;
END $$;

-- Refresh planner statistics
ANALYZE ad_projects;
DO $$
BEGIN
  IF to_regclass('public.invoice_expense_items') IS NOT NULL THEN
    ANALYZE invoice_expense_items;
  END IF;
  IF to_regclass('public.allocations') IS NOT NULL THEN
    ANALYZE allocations;
  END IF;
  IF to_regclass('public.ad_campaign_mapping') IS NOT NULL THEN
    ANALYZE ad_campaign_mapping;
  END IF;
END $$;
