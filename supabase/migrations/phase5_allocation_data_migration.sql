-- phase5_allocation_data_migration.sql
-- IDEMPOTENT: safe to re-run. Uses INSERT ... WHERE NOT EXISTS to avoid
-- duplicating allocations if the migration is accidentally applied twice.

BEGIN;

-- 1. Insert allocations from existing cashbook entries (skip already-migrated rows)
INSERT INTO cashbook_invoice_allocations (
    cashbook_entry_id,
    invoice_id,
    allocated_amount,
    created_at,
    updated_at,
    deleted_at
)
SELECT
    ce.id AS cashbook_entry_id,
    ce.invoice_id,
    ce.amount_inr AS allocated_amount,
    ce.entry_date::timestamp AS created_at,
    now() AS updated_at,
    ce.deleted_at
FROM cashbook_entries ce
WHERE ce.invoice_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM cashbook_invoice_allocations cia
    WHERE cia.cashbook_entry_id = ce.id
  );

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
