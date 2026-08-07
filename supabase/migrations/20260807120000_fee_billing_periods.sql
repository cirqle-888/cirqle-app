-- ═══════════════════════════════════════════════════════════════════════════
-- FEE BILLING PERIODS — retire ensure_retainer_invoice_lines()
--
-- The function shipped in 20260807110000 billed one retainer fee per CALENDAR
-- MONTH. The progress engine bills per DELIVERY PERIOD, and those are not the
-- same thing: an agreement starting mid-month merges its stub month into the
-- next, so 20 Jul → 31 Aug is ONE cycle owing ONE fee. Per-month billing
-- charged that cycle twice (AED 400 in July + AED 400 in August for Elara),
-- directly contradicting the "progress and billing can never disagree"
-- doctrine the coverage engine was built on. It also never billed one_time
-- items at all, so package fees silently never reached an invoice.
--
-- The rule now lives in src/lib/agreements/billing.ts, built ON TOP of
-- resolveDeliveryPeriod() and covered by a test asserting that the number of
-- fees charged equals the number of distinct delivery periods. The cron at
-- /api/cron/retainer-invoices applies it. Keeping a second, divergent copy in
-- SQL is exactly how the two would drift apart again, so the function is
-- replaced with a tombstone that refuses to run and says where to go instead.
--
-- The agreement_item_id column and its unique index from 20260807110000 are
-- KEPT — they are how a fee line is identified and de-duplicated.
--
-- Rollback: supabase/rollbacks/20260807120000_fee_billing_periods_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.ensure_retainer_invoice_lines(p_period DATE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ensure_retainer_invoice_lines() has been retired: it billed one fee per calendar month, which double-charges the merged first cycle of a mid-month agreement start and never billed one_time items. Use GET /api/cron/retainer-invoices?month=YYYY-MM (add &dryRun=1 to preview).'
    USING HINT = 'The billing-period rule now lives in src/lib/agreements/billing.ts, alongside the delivery-period engine it must agree with.';
END;
$$;

COMMENT ON FUNCTION public.ensure_retainer_invoice_lines(DATE) IS
  'RETIRED tombstone — raises. Fee billing moved to /api/cron/retainer-invoices (src/lib/agreements/billing.ts).';

COMMIT;
