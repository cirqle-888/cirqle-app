-- ════════════════════════════════════════════════════════════════════════════
-- Migration 011: receipt_number on cashbook_entries
--
-- Format:  RCPT-{YYMM}-CQ{ClientCode}-{NNN}
-- Example: RCPT-2606-CQ042-001
--
-- Segments:
--   RCPT        = document type
--   YYMM        = entry_date month (two-digit year + zero-padded month)
--   CQ{code}    = "CQ" Cirqle brand + client's registered code from clients.code
--   NNN         = GLOBAL monthly sequence — increments for every receipt in the
--                 month, regardless of client (001, 002, 003, …)
--
-- Global sequence examples (three receipts in Jun 2026):
--   RCPT-2606-CQ042-001   client 042 pays first
--   RCPT-2606-CQ015-002   client 015 pays second
--   RCPT-2606-CQ042-003   client 042 pays again — new seq, same CQ042
--   RCPT-2606-GEN-004     no linked invoice/client
--
-- ── Concurrency protection ────────────────────────────────────────────────────
-- receipt_number_sequences table holds one row per YYMM with a monotonically
-- incrementing counter. INSERT ON CONFLICT DO UPDATE ... RETURNING is
-- single-statement and atomic in PostgreSQL — two simultaneous transactions
-- can never receive the same seq value. No advisory locks, no retries needed.
--
-- ── Historical backfill ───────────────────────────────────────────────────────
-- Every existing inflow entry is assigned a receipt number inside this
-- migration. Entries are ordered by (entry_date ASC, created_at ASC) within
-- each month so the numbers reflect chronological payment order.
--
-- ── Rollback plan ────────────────────────────────────────────────────────────
-- Run the ROLLBACK section at the bottom if you need to undo this migration.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Step 1: Add column ────────────────────────────────────────────────────────
ALTER TABLE cashbook_entries
  ADD COLUMN IF NOT EXISTS receipt_number TEXT;

-- ── Step 2: Sequence counter table ───────────────────────────────────────────
-- One row per YYMM. INSERT ... ON CONFLICT DO UPDATE makes counter
-- increments atomic and race-safe without application-level locking.
CREATE TABLE IF NOT EXISTS receipt_number_sequences (
  month_key TEXT PRIMARY KEY,   -- 'YYMM' e.g. '2606'
  next_seq  INTEGER NOT NULL DEFAULT 1
);

-- ── Step 3: Atomic generator function ────────────────────────────────────────
-- Called by the application (via supabase.rpc) instead of the JS generator.
-- Increments the counter atomically and returns the fully-formatted number.
--
-- Parameters:
--   p_entry_date  TEXT  'YYYY-MM-DD'  used to derive YYMM
--   p_client_code TEXT  client's registered code, or NULL/'GEN' for generic
--
-- Returns: TEXT receipt number, e.g. 'RCPT-2606-CQ042-007'
CREATE OR REPLACE FUNCTION generate_receipt_number(
  p_entry_date  TEXT,
  p_client_code TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_yymm   TEXT;
  v_seq    INTEGER;
  v_suffix TEXT;
BEGIN
  -- Derive YYMM from the entry date string
  v_yymm := to_char(p_entry_date::DATE, 'YYMM');

  -- Atomically claim the next sequence value for this month.
  -- INSERT creates the row on the first receipt of a new month.
  -- ON CONFLICT bumps the counter and returns the new value.
  INSERT INTO receipt_number_sequences (month_key, next_seq)
    VALUES (v_yymm, 2)
  ON CONFLICT (month_key) DO UPDATE
    SET next_seq = receipt_number_sequences.next_seq + 1
  RETURNING next_seq - 1        -- return the value BEFORE the increment
  INTO v_seq;

  -- Format client suffix: CQ{code} or GEN
  IF p_client_code IS NULL OR trim(p_client_code) = '' OR upper(trim(p_client_code)) = 'GEN' THEN
    v_suffix := 'GEN';
  ELSE
    v_suffix := 'CQ' || upper(trim(p_client_code));
  END IF;

  RETURN 'RCPT-' || v_yymm || '-' || v_suffix || '-' || lpad(v_seq::TEXT, 3, '0');
END;
$$;

-- ── Step 4: Unique index ──────────────────────────────────────────────────────
-- Partial index: NULLs (outflows + pre-backfill rows during the transaction)
-- are excluded so multiple NULLs are allowed simultaneously.
-- The index is the final safety net — even if two concurrent calls somehow
-- produced the same number, the INSERT would fail rather than silently create
-- a duplicate.
DROP INDEX IF EXISTS idx_cashbook_entries_receipt_number;
CREATE UNIQUE INDEX idx_cashbook_entries_receipt_number
  ON cashbook_entries(receipt_number)
  WHERE receipt_number IS NOT NULL;

-- ── Step 5: Historical backfill ───────────────────────────────────────────────
-- Assigns receipt numbers to ALL existing inflow entries that don't have one.
-- Ordering: entry_date ASC, created_at ASC within each month so the numbers
-- are chronologically meaningful.
--
-- ⚠ This CTE runs BEFORE we initialise receipt_number_sequences, so we build
--   month-level sequences purely in SQL here and then prime the sequences table
--   with the correct starting values for future receipts.

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Walk inflow entries ordered by (entry_date ASC, created_at ASC) globally.
  -- We track month_key + per-month counter ourselves here since the sequences
  -- table is not yet populated.
  FOR r IN
    SELECT
      ce.id,
      to_char(ce.entry_date::DATE, 'YYMM')                     AS month_key,
      row_number() OVER (
        PARTITION BY to_char(ce.entry_date::DATE, 'YYMM')
        ORDER BY ce.entry_date ASC, ce.created_at ASC, ce.id ASC
      )::INTEGER                                                 AS seq,
      COALESCE(
        NULLIF(upper(trim(cl.code)), ''),
        'GEN'
      )                                                          AS client_code
    FROM cashbook_entries ce
    LEFT JOIN invoices     inv ON inv.id = ce.invoice_id
    LEFT JOIN clients      cl  ON cl.id  = inv.client_id
    WHERE ce.type       = 'inflow'
      AND ce.deleted_at IS NULL
      AND ce.receipt_number IS NULL   -- skip entries already numbered
    ORDER BY ce.entry_date ASC, ce.created_at ASC
  LOOP
    UPDATE cashbook_entries
    SET receipt_number =
      'RCPT-' || r.month_key
      || '-' || CASE WHEN r.client_code = 'GEN' THEN 'GEN' ELSE 'CQ' || r.client_code END
      || '-' || lpad(r.seq::TEXT, 3, '0')
    WHERE id = r.id;
  END LOOP;
END;
$$;

-- ── Step 6: Prime sequence counters for each backfilled month ─────────────────
-- After the backfill above, insert the correct starting next_seq for each
-- month so future receipts continue from the right number.
INSERT INTO receipt_number_sequences (month_key, next_seq)
SELECT
  to_char(entry_date::DATE, 'YYMM')         AS month_key,
  COUNT(*)::INTEGER + 1                      AS next_seq   -- max seq used + 1
FROM cashbook_entries
WHERE type       = 'inflow'
  AND deleted_at IS NULL
  AND receipt_number IS NOT NULL
GROUP BY to_char(entry_date::DATE, 'YYMM')
ON CONFLICT (month_key) DO UPDATE
  SET next_seq = EXCLUDED.next_seq;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration, before going live)
-- ════════════════════════════════════════════════════════════════════════════

/*
-- 1. How many receipts were backfilled?
SELECT COUNT(*) AS backfilled_count
FROM cashbook_entries
WHERE type = 'inflow' AND receipt_number IS NOT NULL;

-- 2. Sample of first 20 historical receipts in chronological order
SELECT
  entry_date,
  receipt_number,
  description,
  amount_inr
FROM cashbook_entries
WHERE type = 'inflow' AND receipt_number IS NOT NULL
ORDER BY entry_date ASC, created_at ASC, id ASC
LIMIT 20;

-- 3. Confirm no duplicate receipt numbers
SELECT receipt_number, COUNT(*) AS cnt
FROM cashbook_entries
WHERE receipt_number IS NOT NULL
GROUP BY receipt_number
HAVING COUNT(*) > 1;
-- Expected: 0 rows

-- 4. Confirm no inflow entries are missing a receipt number
SELECT COUNT(*) AS missing_count
FROM cashbook_entries
WHERE type = 'inflow' AND deleted_at IS NULL AND receipt_number IS NULL;
-- Expected: 0

-- 5. Check sequence counters are correct
SELECT
  s.month_key,
  s.next_seq,
  COUNT(ce.id) AS receipts_in_month
FROM receipt_number_sequences s
LEFT JOIN cashbook_entries ce
  ON to_char(ce.entry_date::DATE, 'YYMM') = s.month_key
  AND ce.type = 'inflow'
  AND ce.deleted_at IS NULL
GROUP BY s.month_key, s.next_seq
ORDER BY s.month_key;
-- next_seq should equal receipts_in_month + 1 for every row
*/


-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK PLAN (run only if you need to undo this migration)
-- ════════════════════════════════════════════════════════════════════════════

/*
BEGIN;
DROP INDEX  IF EXISTS idx_cashbook_entries_receipt_number;
DROP FUNCTION IF EXISTS generate_receipt_number(TEXT, TEXT);
DROP TABLE  IF EXISTS receipt_number_sequences;
ALTER TABLE cashbook_entries DROP COLUMN IF EXISTS receipt_number;
COMMIT;
*/
