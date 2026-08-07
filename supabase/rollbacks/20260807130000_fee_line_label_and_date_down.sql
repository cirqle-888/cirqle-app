-- Rollback for 20260807130000_fee_line_label_and_date.sql
-- Fee lines revert to being named from the service and showing no date.

BEGIN;

ALTER TABLE public.invoice_items DROP COLUMN IF EXISTS line_date;
ALTER TABLE public.client_agreement_items DROP COLUMN IF EXISTS invoice_label;

COMMIT;
