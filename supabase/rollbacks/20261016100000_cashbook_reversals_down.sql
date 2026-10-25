-- Rollback for 20261016100000_cashbook_reversals.
--
-- Reversal entries stay in the cash book as ordinary entries of the opposite
-- type; only their link back to the original is lost (and with it the
-- "Reversed" badges and the netting in cash-flow totals — a reversal inflow
-- would count as income again). Allocations a reversal released stay
-- released. Delete or re-check reversal entries BEFORE running this if that
-- matters.
--
-- The soft-delete cascade returns to its earlier form: invoice allocations
-- only, and a restore brings back every allocation of the entry.
--
-- Revert the application code first: it reads and writes these columns.

BEGIN;

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
        ELSE
            UPDATE cashbook_invoice_allocations
            SET deleted_at = NULL
            WHERE cashbook_entry_id = NEW.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS public.cashbook_invoice_allocations_released_by_idx;
DROP INDEX IF EXISTS public.cashbook_payroll_allocations_released_by_idx;
ALTER TABLE public.cashbook_invoice_allocations DROP COLUMN IF EXISTS released_by_entry_id;
ALTER TABLE public.cashbook_payroll_allocations DROP COLUMN IF EXISTS released_by_entry_id;

DROP INDEX IF EXISTS public.cashbook_entries_one_live_reversal;
ALTER TABLE public.cashbook_entries DROP CONSTRAINT IF EXISTS cashbook_entries_reversal_not_self;
ALTER TABLE public.cashbook_entries DROP COLUMN IF EXISTS reversal_of;

COMMIT;
