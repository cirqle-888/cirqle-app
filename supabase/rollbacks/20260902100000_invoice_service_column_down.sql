-- Rollback for 20260902100000_invoice_service_column.
--
-- Drops both columns. Any per-client or per-invoice choice is lost; invoices
-- go back to never printing a Service column, which is what they do today.

BEGIN;

ALTER TABLE public.invoices DROP COLUMN IF EXISTS show_service_column;
ALTER TABLE public.clients  DROP COLUMN IF EXISTS invoice_show_services;

COMMIT;
