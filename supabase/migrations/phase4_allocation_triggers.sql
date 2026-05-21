-- phase4_allocation_triggers.sql

BEGIN;

-- ── 1. Validate Over-Allocation ───────────────────────────────
CREATE OR REPLACE FUNCTION validate_cashbook_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    total_allocated DECIMAL(12,2);
    entry_amount DECIMAL(12,2);
    entry_deleted TIMESTAMPTZ;
BEGIN
    -- Only check active allocations
    IF NEW.deleted_at IS NULL THEN
        -- Get the max amount allowed from the cashbook entry (using amount_inr as base, or amount if 1:1)
        -- Assuming amount_inr is the base currency value used for reconciliation
        SELECT amount_inr, deleted_at INTO entry_amount, entry_deleted
        FROM cashbook_entries 
        WHERE id = NEW.cashbook_entry_id;

        IF entry_deleted IS NOT NULL THEN
            RAISE EXCEPTION 'Cannot allocate to a deleted cashbook entry';
        END IF;

        -- Sum all active allocations for this entry, EXCLUDING the current row if it's an update
        SELECT COALESCE(SUM(allocated_amount), 0) INTO total_allocated
        FROM cashbook_invoice_allocations
        WHERE cashbook_entry_id = NEW.cashbook_entry_id
          AND id != NEW.id
          AND deleted_at IS NULL;

        IF (total_allocated + NEW.allocated_amount) > entry_amount THEN
            RAISE EXCEPTION 'Over-allocation detected: Total allocated (%) exceeds cashbook entry amount (%)', 
                (total_allocated + NEW.allocated_amount), entry_amount;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_validate_cashbook_allocation ON cashbook_invoice_allocations;
CREATE TRIGGER trigger_validate_cashbook_allocation
BEFORE INSERT OR UPDATE ON cashbook_invoice_allocations
FOR EACH ROW
EXECUTE FUNCTION validate_cashbook_allocation();


-- ── 2. Sync Invoices from Allocations ─────────────────────────
-- Replaces the old trigger on cashbook_entries.
CREATE OR REPLACE FUNCTION sync_allocations_to_invoices()
RETURNS TRIGGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    target_invoice_id UUID;
    old_invoice_id UUID;
    total_paid NUMERIC;
    inv_total NUMERIC;
    inv_status TEXT;
    inv_due_date DATE;
    new_status TEXT;
BEGIN
    -- Determine target invoice
    IF (TG_OP = 'DELETE') THEN
        target_invoice_id := OLD.invoice_id;
    ELSE
        target_invoice_id := NEW.invoice_id;
    END IF;

    -- Recalculate target invoice
    IF target_invoice_id IS NOT NULL THEN
        -- Sum active allocations
        SELECT COALESCE(SUM(allocated_amount), 0) INTO total_paid
        FROM cashbook_invoice_allocations
        WHERE invoice_id = target_invoice_id
          AND deleted_at IS NULL;

        SELECT total_amount, status, due_date
        INTO inv_total, inv_status, inv_due_date
        FROM invoices
        WHERE id = target_invoice_id;

        IF total_paid >= inv_total AND inv_total > 0 THEN
            new_status := 'paid';
        ELSIF total_paid > 0 THEN
            new_status := 'partial';
        ELSIF inv_due_date IS NOT NULL AND inv_due_date < CURRENT_DATE THEN
            new_status := 'overdue';
        ELSE
            IF inv_status IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN
                new_status := inv_status;
            ELSE
                new_status := 'sent';
            END IF;
        END IF;

        UPDATE invoices
        SET paid_amount = total_paid,
            status = new_status
        WHERE id = target_invoice_id;
    END IF;

    -- Recalculate old invoice if it changed
    IF TG_OP = 'UPDATE' THEN
        old_invoice_id := OLD.invoice_id;
        IF old_invoice_id IS DISTINCT FROM target_invoice_id AND old_invoice_id IS NOT NULL THEN
            SELECT COALESCE(SUM(allocated_amount), 0) INTO total_paid
            FROM cashbook_invoice_allocations
            WHERE invoice_id = old_invoice_id
              AND deleted_at IS NULL;

            SELECT total_amount, status, due_date
            INTO inv_total, inv_status, inv_due_date
            FROM invoices
            WHERE id = old_invoice_id;

            IF total_paid >= inv_total AND inv_total > 0 THEN
                new_status := 'paid';
            ELSIF total_paid > 0 THEN
                new_status := 'partial';
            ELSIF inv_due_date IS NOT NULL AND inv_due_date < CURRENT_DATE THEN
                new_status := 'overdue';
            ELSE
                IF inv_status IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN
                    new_status := inv_status;
                ELSE
                    new_status := 'sent';
                END IF;
            END IF;

            UPDATE invoices
            SET paid_amount = total_paid,
                status = new_status
            WHERE id = old_invoice_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_allocations_to_invoices ON cashbook_invoice_allocations;
CREATE TRIGGER trigger_sync_allocations_to_invoices
AFTER INSERT OR UPDATE OR DELETE ON cashbook_invoice_allocations
FOR EACH ROW
EXECUTE FUNCTION sync_allocations_to_invoices();

-- ── 3. Cascade Soft Delete from Entries to Allocations ─────────
-- When cashbook_entries is soft-deleted or restored, cascade to allocations
CREATE OR REPLACE FUNCTION cascade_cashbook_entry_soft_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
        -- If entry is soft-deleted, soft-delete its active allocations
        IF NEW.deleted_at IS NOT NULL THEN
            UPDATE cashbook_invoice_allocations
            SET deleted_at = NEW.deleted_at
            WHERE cashbook_entry_id = NEW.id AND deleted_at IS NULL;
        ELSE
            -- If entry is restored (deleted_at -> NULL), restore its allocations
            -- Note: this restores ALL allocations that were deleted. If an allocation 
            -- was deleted manually before the entry, it would get restored too. 
            -- For strict auditing, maybe only restore those deleted at the same exact timestamp, 
            -- but for simplicity, restore all associated with this entry.
            UPDATE cashbook_invoice_allocations
            SET deleted_at = NULL
            WHERE cashbook_entry_id = NEW.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Drop the OLD legacy trigger that syncs invoices directly from entries
DROP TRIGGER IF EXISTS trigger_sync_invoice_payments ON cashbook_entries;

DROP TRIGGER IF EXISTS trigger_cascade_cashbook_entry_soft_delete ON cashbook_entries;
CREATE TRIGGER trigger_cascade_cashbook_entry_soft_delete
AFTER UPDATE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION cascade_cashbook_entry_soft_delete();


-- ── 4. Allocation Audit Logging Trigger ───────────────────────
CREATE OR REPLACE FUNCTION log_allocation_audit()
RETURNS TRIGGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO allocation_audit_log (
        allocation_id, cashbook_entry_id, old_invoice_id, new_invoice_id, old_amount, new_amount, action
    ) VALUES (
        CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
        CASE WHEN TG_OP = 'DELETE' THEN OLD.cashbook_entry_id ELSE NEW.cashbook_entry_id END,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.invoice_id WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NULL END,
        CASE WHEN TG_OP = 'UPDATE' THEN NEW.invoice_id WHEN TG_OP = 'INSERT' THEN NEW.invoice_id ELSE NULL END,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.allocated_amount WHEN TG_OP = 'DELETE' THEN OLD.allocated_amount ELSE NULL END,
        CASE WHEN TG_OP = 'UPDATE' THEN NEW.allocated_amount WHEN TG_OP = 'INSERT' THEN NEW.allocated_amount ELSE NULL END,
        CASE 
            WHEN TG_OP = 'INSERT' THEN 'CREATED'
            WHEN TG_OP = 'DELETE' THEN 'DELETED'
            WHEN TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'SOFT_DELETED'
            WHEN TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'RESTORED'
            WHEN TG_OP = 'UPDATE' AND OLD.invoice_id != NEW.invoice_id THEN 'REASSIGNED'
            ELSE 'UPDATED'
        END
    );
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_log_allocation_audit ON cashbook_invoice_allocations;
CREATE TRIGGER trigger_log_allocation_audit
AFTER INSERT OR UPDATE OR DELETE ON cashbook_invoice_allocations
FOR EACH ROW
EXECUTE FUNCTION log_allocation_audit();

COMMIT;
