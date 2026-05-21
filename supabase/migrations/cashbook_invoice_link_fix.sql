-- We must add SECURITY DEFINER so the trigger bypasses RLS when updating invoices
CREATE OR REPLACE FUNCTION sync_invoice_payments()
RETURNS TRIGGER
SECURITY DEFINER
AS $$
DECLARE
    target_invoice_id UUID;
    total_paid NUMERIC;
    inv_total NUMERIC;
    inv_status TEXT;
    inv_due_date DATE;
    new_status TEXT;
BEGIN
    RAISE NOTICE 'TRIGGER sync_invoice_payments FIRED FOR OP: %', TG_OP;

    -- Determine the affected invoice_id
    IF (TG_OP = 'DELETE') THEN
        target_invoice_id := OLD.invoice_id;
    ELSE
        target_invoice_id := NEW.invoice_id;
    END IF;

    RAISE NOTICE 'TARGET INVOICE ID: %', target_invoice_id;

    -- If there's a link, recalculate
    IF target_invoice_id IS NOT NULL THEN
        -- Calculate the perfect sum from all active inflow entries
        SELECT COALESCE(SUM(amount), 0) INTO total_paid
        FROM cashbook_entries
        WHERE invoice_id = target_invoice_id
          AND type = 'inflow';

        -- Get current invoice stats
        SELECT total_amount, status, due_date INTO inv_total, inv_status, inv_due_date
        FROM invoices
        WHERE id = target_invoice_id;

        RAISE NOTICE 'INVOICE ID %: CURRENT TOTAL_PAID=%, INV_TOTAL=%', target_invoice_id, total_paid, inv_total;

        -- Determine the new status naturally based on amount, even if it was draft
        IF total_paid >= inv_total THEN
            new_status := 'paid';
        ELSIF total_paid > 0 THEN
            new_status := 'partial';
        ELSIF inv_due_date < CURRENT_DATE THEN
            new_status := 'overdue';
        ELSE
            -- If it has no payments, but was draft/reviewed, we shouldn't force it to 'sent'
            -- We only transition to sent if it was already an active invoice
            IF inv_status IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN
                new_status := inv_status;
            ELSE
                new_status := 'sent';
            END IF;
        END IF;
        
        -- Bypass RLS safely and update the invoice
        UPDATE invoices
        SET paid_amount = total_paid,
            status = new_status
        WHERE id = target_invoice_id;
    END IF;

    -- Handle case where a cashbook entry was re-assigned to a different invoice
    IF (TG_OP = 'UPDATE') THEN
        IF (OLD.invoice_id IS DISTINCT FROM NEW.invoice_id AND OLD.invoice_id IS NOT NULL) THEN
            -- Recalculate the OLD invoice as well
            SELECT COALESCE(SUM(amount), 0) INTO total_paid
            FROM cashbook_entries
            WHERE invoice_id = OLD.invoice_id
              AND type = 'inflow';

            SELECT total_amount, status, due_date INTO inv_total, inv_status, inv_due_date
            FROM invoices
            WHERE id = OLD.invoice_id;

            IF total_paid >= inv_total THEN
                new_status := 'paid';
            ELSIF total_paid > 0 THEN
                new_status := 'partial';
            ELSIF inv_due_date < CURRENT_DATE THEN
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
            WHERE id = OLD.invoice_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_invoice_payments ON cashbook_entries;

CREATE TRIGGER trigger_sync_invoice_payments
AFTER INSERT OR UPDATE OR DELETE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION sync_invoice_payments();
