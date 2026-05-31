-- Migration 011: add receipt_number to cashbook_entries
--
-- Format mirrors the invoice numbering convention:
--   RCPT-CQ-{YYMM}-{ClientCode}
--   e.g.  RCPT-CQ-2606-042
--
-- "CQ" = Cirqle brand identifier
-- YYMM = entry date month (two-digit year + zero-padded month)
-- ClientCode = client's registered code (from clients.code),
--              same code embedded in the linked invoice number
--
-- Duplicate handling (same client + same month):
--   Normal:          RCPT-CQ-2606-042
--   First duplicate: RCPT-CQ-2606-042A
--   Further:         RCPT-CQ-2606-042-2, RCPT-CQ-2606-042-3, …
--
-- NULL = legacy entry (created before this migration) or outflow.
-- UI falls back to the old UUID-derived format for those rows.

ALTER TABLE cashbook_entries
  ADD COLUMN IF NOT EXISTS receipt_number TEXT;

-- Unique index — partial so multiple NULLs are allowed (outflows + legacy).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cashbook_entries_receipt_number
  ON cashbook_entries(receipt_number)
  WHERE receipt_number IS NOT NULL;
