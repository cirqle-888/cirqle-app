-- ============================================================
-- PHASE 1: SOFT DELETE SUPPORT
-- Adds deleted_at column and updates trigger to exclude deleted
-- rows from invoice payment sum calculations.
-- ============================================================

-- DRY RUN PREVIEW (runs in a rolled-back transaction)
-- Uncomment to preview before applying:
-- BEGIN;
--   SELECT COUNT(*) AS existing_entries, 
--          COUNT(CASE WHEN reference ~ 'INV-' THEN 1 END) AS invoice_linked
--   FROM cashbook_entries;
-- ROLLBACK;

-- ── Step 1: Add soft-delete column ──────────────────────────
ALTER TABLE cashbook_entries
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Partial index for fast active-entry queries
CREATE INDEX IF NOT EXISTS idx_cashbook_active
ON cashbook_entries(deleted_at)
WHERE deleted_at IS NULL;

-- ── Step 2: Rebuild trigger with soft-delete awareness ───────
-- Also includes:
--   - SECURITY DEFINER (bypass RLS)
--   - Debug mode via app.cashbook_debug GUC
--   - Audit log insert (Phase 2 will add the table; this is a no-op until then)
--   - Correct status logic for all invoice states including draft

CREATE OR REPLACE FUNCTION sync_invoice_payments()
RETURNS TRIGGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    target_invoice_id  UUID;
    old_invoice_id     UUID;
    total_paid         NUMERIC;
    inv_total          NUMERIC;
    inv_status         TEXT;
    inv_due_date       DATE;
    old_paid_amount    NUMERIC;
    new_paid_amount    NUMERIC;
    old_status_val     TEXT;
    new_status         TEXT;
    debug_mode         BOOLEAN;
BEGIN
    -- Debug mode: SET app.cashbook_debug = 'on'; in your session to enable
    debug_mode := COALESCE(current_setting('app.cashbook_debug', true), 'off') = 'on';

    -- Determine the affected invoice_id
    IF (TG_OP = 'DELETE') THEN
        target_invoice_id := OLD.invoice_id;
    ELSE
        target_invoice_id := NEW.invoice_id;
    END IF;

    IF debug_mode THEN
        RAISE NOTICE '[cashbook_sync] op=%, entry_id=%, invoice_id=%',
            TG_OP,
            CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            target_invoice_id;
    END IF;

    -- ── Recalculate target invoice (NEW invoice_id) ──────────
    IF target_invoice_id IS NOT NULL THEN
        -- SUM only active (non-deleted), inflow entries
        SELECT COALESCE(SUM(amount), 0) INTO total_paid
        FROM cashbook_entries
        WHERE invoice_id = target_invoice_id
          AND type = 'inflow'
          AND deleted_at IS NULL;

        SELECT total_amount, status, due_date, paid_amount
        INTO inv_total, inv_status, inv_due_date, old_paid_amount
        FROM invoices
        WHERE id = target_invoice_id;

        -- Status transition logic
        IF total_paid >= inv_total AND inv_total > 0 THEN
            new_status := 'paid';
        ELSIF total_paid > 0 THEN
            new_status := 'partial';
        ELSIF inv_due_date IS NOT NULL AND inv_due_date < CURRENT_DATE THEN
            new_status := 'overdue';
        ELSE
            -- Preserve draft/reviewed/cancelled/bad_debt — do not force to 'sent'
            IF inv_status IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN
                new_status := inv_status;
            ELSE
                new_status := 'sent';
            END IF;
        END IF;

        new_paid_amount := total_paid;
        old_status_val  := inv_status;

        UPDATE invoices
        SET paid_amount = new_paid_amount,
            status      = new_status
        WHERE id = target_invoice_id;

        IF debug_mode THEN
            RAISE NOTICE '[cashbook_sync] invoice=%: paid % → %, status % → %',
                target_invoice_id, old_paid_amount, new_paid_amount, old_status_val, new_status;
        END IF;

        -- Audit log (safe no-op if table doesn't exist yet — Phase 2 creates it)
        BEGIN
            INSERT INTO cashbook_audit_log (
                entry_id, invoice_id, operation,
                old_amount, new_amount,
                old_paid_amount, new_paid_amount,
                old_status, new_status
            ) VALUES (
                CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
                target_invoice_id,
                TG_OP,
                CASE WHEN TG_OP = 'DELETE' THEN OLD.amount
                     WHEN TG_OP = 'UPDATE' THEN OLD.amount
                     ELSE NULL END,
                CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.amount ELSE NULL END,
                old_paid_amount,
                new_paid_amount,
                old_status_val,
                new_status
            );
        EXCEPTION WHEN undefined_table THEN
            -- cashbook_audit_log does not exist yet — silently skip
            NULL;
        END;
    END IF;

    -- ── Recalculate OLD invoice (when entry moves between invoices) ──
    IF TG_OP = 'UPDATE' THEN
        old_invoice_id := OLD.invoice_id;
        IF old_invoice_id IS DISTINCT FROM target_invoice_id AND old_invoice_id IS NOT NULL THEN
            SELECT COALESCE(SUM(amount), 0) INTO total_paid
            FROM cashbook_entries
            WHERE invoice_id = old_invoice_id
              AND type = 'inflow'
              AND deleted_at IS NULL;

            SELECT total_amount, status, due_date, paid_amount
            INTO inv_total, inv_status, inv_due_date, old_paid_amount
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
                status      = new_status
            WHERE id = old_invoice_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

-- Re-attach trigger (idempotent)
DROP TRIGGER IF EXISTS trigger_sync_invoice_payments ON cashbook_entries;
CREATE TRIGGER trigger_sync_invoice_payments
AFTER INSERT OR UPDATE OR DELETE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION sync_invoice_payments();
