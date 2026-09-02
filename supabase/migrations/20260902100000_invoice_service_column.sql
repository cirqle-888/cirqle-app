-- ============================================================================
-- Optional "Service" column on the printed invoice
--
-- Some clients buy several services and want to see which ones were done for
-- them; a client on a single service already knows, and the column is noise on
-- their invoice. So this is a standing fact about the CLIENT, with a per-
-- invoice escape hatch — the same shape as invoices.expenses_mode.
--
--   clients.invoice_show_services   the client's rule. false = today's layout.
--   invoices.show_service_column    NULL = follow the client; true/false
--                                   overrides for this one invoice.
--
-- The override is deliberately NULLABLE rather than a plain boolean: a plain
-- one cannot express "this client normally gets the column, but not on THIS
-- invoice", because false would be indistinguishable from unset.
--
-- Both default to the current behaviour, so applying this changes no existing
-- invoice. src/lib/invoices/service-column.ts is the single place that reads
-- the two together.
--
-- No grants needed: `clients` and `invoices` are both in the authenticated
-- keep list and their grants are table-level, so new columns are covered.
-- ============================================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS invoice_show_services boolean NOT NULL DEFAULT false;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS show_service_column boolean;

COMMENT ON COLUMN public.clients.invoice_show_services IS
  'Print a Service column on this client''s invoices by default.';
COMMENT ON COLUMN public.invoices.show_service_column IS
  'Per-invoice override for the Service column. NULL = follow clients.invoice_show_services.';
