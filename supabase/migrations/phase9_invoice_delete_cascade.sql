-- Fix: invoice deletion blocked by cashbook_invoice_allocations FK
-- The original phase3 migration set invoice_id ON DELETE RESTRICT.
-- Phase7 only fixed the cashbook_entry_id FK. This corrects invoice_id.

BEGIN;

ALTER TABLE cashbook_invoice_allocations
  DROP CONSTRAINT IF EXISTS cashbook_invoice_allocations_invoice_id_fkey;

ALTER TABLE cashbook_invoice_allocations
  ADD CONSTRAINT cashbook_invoice_allocations_invoice_id_fkey
  FOREIGN KEY (invoice_id)
  REFERENCES invoices(id)
  ON DELETE CASCADE;

COMMIT;
