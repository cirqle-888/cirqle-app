-- ============================================================================
-- 024 — Publish invoice tables to realtime
-- The task → invoice sync is already 100% server-side (see
-- supabase/migrations/20260701120000_billing_sync_hardening.sql): a task hitting
-- 'done' auto-creates/updates its client-month draft line, and un-doing or
-- deleting a done task removes it. But the Invoices page only ever saw that on a
-- full navigation/reload — nothing pushed the change to an already-open page.
--
-- Publishing these three tables lets the Invoices page subscribe and refresh the
-- instant a line is added/removed/retotalled, so creating or deleting tasks
-- reflects live in the invoice list without a manual reload.
--
--   invoices              — draft created, totals recalculated, status changes
--   invoice_items         — task lines added / removed / moved / re-priced
--   invoice_expense_items — client-tagged cashbook outflows auto-attached
--
-- Idempotent: safe to re-run. No table/column changes — publication only.
-- Default REPLICA IDENTITY is fine: the client listener only triggers a refetch
-- and never reads the changed row's old values from the event payload.
-- ============================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_items', 'invoice_expense_items'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;
