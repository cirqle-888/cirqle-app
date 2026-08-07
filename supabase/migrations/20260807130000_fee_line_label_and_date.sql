-- ═══════════════════════════════════════════════════════════════════════════
-- FEE LINE LABEL + DATE — make an agreement fee read on the invoice the way it
-- reads in the signed proposal.
--
-- Two gaps the first invoice exposed:
--
-- 1. NAME. A fee line was labelled from the SERVICE name, but the service is an
--    internal catalogue entry ("Logo Design") while the client signed a
--    proposal line ("Brand Identity Development"). The client should see the
--    wording they agreed to, so each agreement item carries its own
--    invoice_label; the service name is only the fallback.
--
-- 2. DATE. The invoice's Date column is read from the linked task
--    (invoice_items.task_id → tasks.task_date). A fee line has no task — it is
--    the agreement's charge, not one job — so the column rendered blank. Fee
--    lines now carry their own line_date, set to the first task delivered
--    against that agreement item inside the period the fee covers. Nullable:
--    a fee raised before any work is dated simply shows no date, exactly as
--    before.
--
-- line_date is deliberately its own column rather than a join: a fee can cover
-- many tasks (15 posts) or none, so there is no single task to point at, and
-- the value must stay editable independently of task edits.
--
-- ADDITIVE + idempotent. Rollback:
-- supabase/rollbacks/20260807130000_fee_line_label_and_date_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.client_agreement_items
  ADD COLUMN IF NOT EXISTS invoice_label TEXT;

COMMENT ON COLUMN public.client_agreement_items.invoice_label IS
  'Client-facing name for this line on the invoice (e.g. "Brand Identity Development"). NULL = fall back to the service name.';

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS line_date DATE;

COMMENT ON COLUMN public.invoice_items.line_date IS
  'Display date for lines with no linked task (agreement fee lines). Set to the first task delivered against the agreement item within the period the fee covers.';

COMMIT;
