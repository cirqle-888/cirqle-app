-- phase6_auto_allocation_trigger.sql

BEGIN;

CREATE OR REPLACE FUNCTION auto_create_allocation_on_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- If a legacy insert provides an invoice_id directly, auto-allocate the full amount
    IF NEW.invoice_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
        INSERT INTO cashbook_invoice_allocations (
            cashbook_entry_id,
            invoice_id,
            allocated_amount,
            created_at,
            updated_at
        ) VALUES (
            NEW.id,
            NEW.invoice_id,
            NEW.amount_inr, -- Allocate the full INR amount
            NEW.entry_date::timestamp,
            now()
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_create_allocation_on_entry ON cashbook_entries;
CREATE OR REPLACE TRIGGER trigger_auto_create_allocation_on_entry
AFTER INSERT ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION auto_create_allocation_on_entry();

COMMIT;
