BEGIN;

ALTER TABLE cashbook_invoice_allocations
  DROP CONSTRAINT IF EXISTS cashbook_invoice_allocations_cashbook_entry_id_fkey;

ALTER TABLE cashbook_invoice_allocations
  ADD CONSTRAINT cashbook_invoice_allocations_cashbook_entry_id_fkey
  FOREIGN KEY (cashbook_entry_id)
  REFERENCES cashbook_entries(id)
  ON DELETE CASCADE;

COMMIT;
