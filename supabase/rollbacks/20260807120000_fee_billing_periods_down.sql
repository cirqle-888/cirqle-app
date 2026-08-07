-- Rollback for 20260807120000_fee_billing_periods.sql
--
-- Removes the tombstone. It deliberately does NOT restore the original
-- per-calendar-month implementation: that version double-billed the merged
-- first cycle of a mid-month agreement start and never billed one_time items.
-- If you need the old body, it is in 20260807110000_agreement_work_values.sql
-- in git history — read the header of the forward migration first.

BEGIN;

DROP FUNCTION IF EXISTS public.ensure_retainer_invoice_lines(DATE);

COMMIT;
