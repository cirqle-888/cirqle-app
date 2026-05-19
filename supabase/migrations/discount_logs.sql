-- ============================================================
-- Discount Logs Table Migration
-- ============================================================
-- Run this ONCE in Supabase SQL Editor (Dashboard → SQL Editor).
-- Safe to re-run (uses IF NOT EXISTS).
--
-- This table stores invoice discount history — imported via the
-- Bulk Import tool (Discount History mode).
-- ============================================================

CREATE TABLE IF NOT EXISTS discount_logs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id          UUID REFERENCES invoices(id) ON DELETE SET NULL,
  client_id           UUID REFERENCES clients(id)  ON DELETE SET NULL,
  discount_amount     DECIMAL(12,2) DEFAULT 0,
  discount_percentage DECIMAL(7,4)  DEFAULT 0,
  invoice_total       DECIMAL(12,2) DEFAULT 0,
  reason              TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discount_logs_invoice_id ON discount_logs (invoice_id);
CREATE INDEX IF NOT EXISTS idx_discount_logs_client_id  ON discount_logs (client_id);
CREATE INDEX IF NOT EXISTS idx_discount_logs_created_at ON discount_logs (created_at);

-- ── Verification ─────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'discount_logs';
