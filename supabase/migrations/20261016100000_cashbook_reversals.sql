-- Cash Book: returned / reversed entries, and payroll allocations that follow
-- a deleted entry.
--
-- 1. `cashbook_entries.reversal_of` — a reversal is an ordinary entry of the
--    opposite type, on the same account and in the same category as the entry
--    it undoes, pointing back at it. Same category is the point: the two net
--    to zero inside that category, so P&L and category totals show the net
--    effect without any report having to know about reversals. One LIVE
--    reversal per entry (partial unique index), and never of itself.
--
-- 2. `released_by_entry_id` on both allocation tables — which reversal took
--    an allocation off its invoice or payslip. Deleting the reversal puts
--    exactly those back, and restoring a deleted original does NOT resurrect
--    them (the money really did bounce).
--
-- 3. cascade_cashbook_entry_soft_delete() now also covers PAYROLL
--    allocations. Before this, deleting a salary entry left its allocation
--    live, so the payslip stayed "paid" for money that was never recorded.
--    Restore is also narrowed to the allocations that THIS delete removed
--    (same timestamp, not released by a reversal) instead of every
--    allocation the entry ever had.
--
-- No data is changed. Entries deleted BEFORE this migration may still hold
-- live payroll allocations; the query at the bottom lists them for a person
-- to review. Safe to re-run.

BEGIN;

-- ── 1. reversal_of ──────────────────────────────────────────────────────────
ALTER TABLE public.cashbook_entries
  ADD COLUMN IF NOT EXISTS reversal_of uuid REFERENCES public.cashbook_entries(id);

ALTER TABLE public.cashbook_entries
  DROP CONSTRAINT IF EXISTS cashbook_entries_reversal_not_self;
ALTER TABLE public.cashbook_entries
  ADD CONSTRAINT cashbook_entries_reversal_not_self CHECK (reversal_of IS NULL OR reversal_of <> id);

CREATE UNIQUE INDEX IF NOT EXISTS cashbook_entries_one_live_reversal
  ON public.cashbook_entries(reversal_of)
  WHERE reversal_of IS NOT NULL AND deleted_at IS NULL;

-- ── 2. Which reversal released an allocation ────────────────────────────────
-- Deliberately NO foreign key: a second relationship to cashbook_entries
-- makes every PostgREST embed between the two tables ambiguous (PGRST201).
-- The first run of this file did add one; 20261016110000 drops it.
ALTER TABLE public.cashbook_invoice_allocations
  ADD COLUMN IF NOT EXISTS released_by_entry_id uuid;
ALTER TABLE public.cashbook_payroll_allocations
  ADD COLUMN IF NOT EXISTS released_by_entry_id uuid;

CREATE INDEX IF NOT EXISTS cashbook_invoice_allocations_released_by_idx
  ON public.cashbook_invoice_allocations(released_by_entry_id) WHERE released_by_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cashbook_payroll_allocations_released_by_idx
  ON public.cashbook_payroll_allocations(released_by_entry_id) WHERE released_by_entry_id IS NOT NULL;

-- ── 3. Soft delete / restore cascades to BOTH allocation tables ────────────
-- The allocation tables' own triggers (sync_allocations_to_invoices,
-- sync_payroll_payments) then recompute invoice paid amounts and payslip
-- status, exactly as for a manual allocation change.
CREATE OR REPLACE FUNCTION cascade_cashbook_entry_soft_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
        IF NEW.deleted_at IS NOT NULL THEN
            UPDATE cashbook_invoice_allocations
               SET deleted_at = NEW.deleted_at
             WHERE cashbook_entry_id = NEW.id AND deleted_at IS NULL;
            UPDATE cashbook_payroll_allocations
               SET deleted_at = NEW.deleted_at
             WHERE cashbook_entry_id = NEW.id AND deleted_at IS NULL;
        ELSE
            -- Restore only what the delete itself removed.
            UPDATE cashbook_invoice_allocations
               SET deleted_at = NULL
             WHERE cashbook_entry_id = NEW.id
               AND deleted_at = OLD.deleted_at
               AND released_by_entry_id IS NULL;
            UPDATE cashbook_payroll_allocations
               SET deleted_at = NULL
             WHERE cashbook_entry_id = NEW.id
               AND deleted_at = OLD.deleted_at
               AND released_by_entry_id IS NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cascade_cashbook_entry_soft_delete ON cashbook_entries;
CREATE TRIGGER trigger_cascade_cashbook_entry_soft_delete
AFTER UPDATE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION cascade_cashbook_entry_soft_delete();

COMMIT;

-- ── Review after applying (read-only) ───────────────────────────────────────
-- Payslips still marked paid by an allocation whose cash-book entry is
-- deleted. Each is a payment that no longer exists in the books; decide per
-- row whether to soft-delete the allocation (the payslip then returns to
-- pending through sync_payroll_payments).
--
-- SELECT p.id AS payroll_id, p.status, a.id AS allocation_id,
--        a.allocated_amount, e.entry_date, e.deleted_at
--   FROM cashbook_payroll_allocations a
--   JOIN cashbook_entries e ON e.id = a.cashbook_entry_id
--   JOIN payroll p          ON p.id = a.payroll_id
--  WHERE a.deleted_at IS NULL AND e.deleted_at IS NOT NULL
--  ORDER BY e.deleted_at DESC;
