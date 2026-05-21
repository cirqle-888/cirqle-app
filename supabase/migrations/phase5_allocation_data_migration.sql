-- phase5_allocation_data_migration.sql

BEGIN;

-- 1. Insert allocations from existing cashbook entries
INSERT INTO cashbook_invoice_allocations (
    cashbook_entry_id, 
    invoice_id, 
    allocated_amount, 
    created_at, 
    updated_at,
    deleted_at
)
SELECT 
    id AS cashbook_entry_id,
    invoice_id,
    amount_inr AS allocated_amount,
    entry_date::timestamp AS created_at, -- using entry_date or fallback to now()
    now() AS updated_at,
    deleted_at
FROM cashbook_entries
WHERE invoice_id IS NOT NULL;

-- The triggers we added in phase 4 will automatically start calculating invoices based on these.
-- Since the trigger on cashbook_invoice_allocations runs AFTER INSERT FOR EACH ROW, it will recalculate
-- the invoices immediately during this INSERT statement! 

-- To be absolutely safe, let's touch all invoices that have allocations to force a recalculation
-- (This ensures the trigger logic perfectly matches the old logic)
-- Actually, the INSERT statement above will fire the trigger for every row.
-- But just in case, we can manually recalculate:

WITH alloc_sums AS (
    SELECT invoice_id, SUM(allocated_amount) as total_paid
    FROM cashbook_invoice_allocations
    WHERE deleted_at IS NULL
    GROUP BY invoice_id
)
UPDATE invoices i
SET paid_amount = COALESCE(s.total_paid, 0)
FROM alloc_sums s
WHERE i.id = s.invoice_id
  AND i.paid_amount IS DISTINCT FROM COALESCE(s.total_paid, 0);

COMMIT;
