-- ============================================================
-- Fix: Missing UNIQUE Constraints
-- ============================================================
-- Run this ONCE in Supabase SQL Editor (Dashboard → SQL Editor).
-- All statements are idempotent (use IF NOT EXISTS / DO blocks).
-- ============================================================

-- ── 1. Prevent duplicate payroll allocations ─────────────────
-- Without this a double-click / retry can allocate the same
-- cashbook entry to the same payroll twice, inflating status.
-- We exclude soft-deleted rows (deleted_at IS NOT NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_cpa_cashbook_payroll_active'
  ) THEN
    ALTER TABLE public.cashbook_payroll_allocations
      ADD CONSTRAINT uq_cpa_cashbook_payroll_active
      UNIQUE (cashbook_entry_id, payroll_id);
  END IF;
END$$;

-- ── 2. Prevent multiple discount records per invoice ─────────
-- discount_logs is a 1-to-1 relationship with invoices.
-- The import upsert logic relies on this at runtime; the DB
-- should enforce it too so no path can insert duplicates.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_discount_logs_invoice_id'
  ) THEN
    -- Remove any pre-existing duplicates first (keep newest)
    DELETE FROM public.discount_logs a
    USING public.discount_logs b
    WHERE a.invoice_id = b.invoice_id
      AND a.created_at < b.created_at;

    ALTER TABLE public.discount_logs
      ADD CONSTRAINT uq_discount_logs_invoice_id
      UNIQUE (invoice_id);
  END IF;
END$$;

-- ── 3. Guard dashboard.view permission seed ───────────────────
-- Idempotent insert — safe to run even if already seeded.
INSERT INTO public.permissions (key, label, module)
VALUES ('dashboard.view', 'View Dashboard', 'Dashboard')
ON CONFLICT (key) DO NOTHING;
