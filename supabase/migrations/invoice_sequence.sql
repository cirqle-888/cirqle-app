-- ============================================================
-- Invoice Billing-Period Architecture Migration
-- ============================================================
-- Run this ONCE in Supabase SQL Editor (Dashboard → SQL Editor).
-- All statements use IF NOT EXISTS — safe to re-run.
--
-- What this does:
--   1. Adds billing-period and sequence-month columns to invoices
--   2. Adds 'reviewed' to the invoices status CHECK constraint
--
-- Invoice number format: INV-{YYMM}-{ClientCode}
--   e.g. INV-2509-001
--
--   YYMM       = invoice ISSUE month (Sep for Aug tasks, by default)
--   ClientCode = client's registered code (001, 004, etc.)
--
-- Backward compatibility:
--   Existing invoices are NOT modified. All new columns default to NULL.
-- ============================================================


-- ── 1. Add missing columns to invoices ──────────────────────────────────────

ALTER TABLE invoices
  -- Billing period (the task/work period this invoice covers)
  ADD COLUMN IF NOT EXISTS billing_period_start    DATE,
  ADD COLUMN IF NOT EXISTS billing_period_end      DATE,
  ADD COLUMN IF NOT EXISTS billing_period_label    TEXT,        -- e.g. "August 2025"

  -- Invoice issue month (YYMM of the invoice number, not the task month)
  ADD COLUMN IF NOT EXISTS invoice_sequence_month  TEXT,        -- e.g. "2509"

  -- Financial breakdown (previously added by app migrations; idempotent)
  ADD COLUMN IF NOT EXISTS subtotal                DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate                DECIMAL(5,2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount              DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount         DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS previous_balance        DECIMAL(12,2) DEFAULT 0;


-- ── 2. Add 'reviewed' to the status CHECK constraint ────────────────────────
-- PostgreSQL does not support ALTER CONSTRAINT, so we drop + recreate.

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN (
    'draft', 'reviewed', 'sent', 'partial', 'paid',
    'overdue', 'cancelled', 'bad_debt'
  ));


-- ── 3. Helpful indexes ───────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_invoices_sequence_month
  ON invoices (invoice_sequence_month);

CREATE INDEX IF NOT EXISTS idx_invoices_billing_period
  ON invoices (billing_period_start, billing_period_end);


-- ── Verification ─────────────────────────────────────────────────────────────
-- Run this after the migration to confirm everything worked:
--
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'invoices' AND column_name LIKE 'billing%';
--   -- Should return: billing_period_start, billing_period_end, billing_period_label
