-- 1. Add strict foreign key linkage to cashbook_entries
ALTER TABLE cashbook_entries 
ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL;

-- 2. CREATE INDEX IF NOT EXISTS for fast lookups
CREATE INDEX IF NOT EXISTS idx_cashbook_invoice_id ON cashbook_entries(invoice_id);

-- 3. Backfill historical data (Map plain text references to strict IDs)
-- This assumes reference looks like "Payment for INV-2023-04"
UPDATE cashbook_entries ce
SET invoice_id = i.id
FROM invoices i
WHERE ce.reference ILIKE '%' || i.invoice_number || '%'
  AND ce.invoice_id IS NULL;

-- 4. Create the core synchronization function
CREATE OR REPLACE FUNCTION sync_invoice_payments()
RETURNS TRIGGER AS $$
DECLARE
    target_invoice_id UUID;
    total_paid NUMERIC;
    inv_total NUMERIC;
    inv_status TEXT;
    inv_due_date DATE;
    new_status TEXT;
BEGIN
    -- Determine the affected invoice_id
    IF (TG_OP = 'DELETE') THEN
        target_invoice_id := OLD.invoice_id;
    ELSE
        target_invoice_id := NEW.invoice_id;
    END IF;

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

        -- We DO NOT update status if it's draft, reviewed, cancelled, or bad_debt
        IF inv_status NOT IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN
            IF total_paid >= inv_total THEN
                new_status := 'paid';
            ELSIF total_paid > 0 THEN
                new_status := 'partial';
            ELSIF inv_due_date < CURRENT_DATE THEN
                new_status := 'overdue';
            ELSE
                new_status := 'sent';
            END IF;
            
            -- Update the invoice safely
            UPDATE invoices
            SET paid_amount = total_paid,
                status = new_status
            WHERE id = target_invoice_id;
        ELSE
            -- Just update the paid amount, leave status alone
            UPDATE invoices
            SET paid_amount = total_paid
            WHERE id = target_invoice_id;
        END IF;
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

            IF inv_status NOT IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN
                IF total_paid >= inv_total THEN
                    new_status := 'paid';
                ELSIF total_paid > 0 THEN
                    new_status := 'partial';
                ELSIF inv_due_date < CURRENT_DATE THEN
                    new_status := 'overdue';
                ELSE
                    new_status := 'sent';
                END IF;
                
                UPDATE invoices
                SET paid_amount = total_paid,
                    status = new_status
                WHERE id = OLD.invoice_id;
            ELSE
                UPDATE invoices
                SET paid_amount = total_paid
                WHERE id = OLD.invoice_id;
            END IF;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 5. Attach the trigger to cashbook_entries
DROP TRIGGER IF EXISTS trigger_sync_invoice_payments ON cashbook_entries;
CREATE OR REPLACE TRIGGER trigger_sync_invoice_payments
AFTER INSERT OR UPDATE OR DELETE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION sync_invoice_payments();
