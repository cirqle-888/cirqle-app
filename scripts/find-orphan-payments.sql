-- scripts/find-orphan-payments.sql
-- Finds cashbook inflow entries that look like they were meant for an invoice
-- (reference looks like INV-...) but have NO active allocation in cashbook_invoice_allocations.

SELECT 
    c.id,
    c.entry_date,
    c.description,
    c.reference,
    c.amount_inr,
    c.client_id
FROM cashbook_entries c
LEFT JOIN cashbook_invoice_allocations a ON c.id = a.cashbook_entry_id AND a.deleted_at IS NULL
WHERE c.type = 'inflow'
  AND c.deleted_at IS NULL
  AND c.reference ILIKE '%INV-%'
  AND a.id IS NULL
ORDER BY c.entry_date DESC;
