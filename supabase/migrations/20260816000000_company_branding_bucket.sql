-- ── 1. Create company-branding bucket ──────────────────────────────────────────
-- Public bucket for company branding (logos, favicons, invoice assets).
-- These assets are naturally public as they are embedded in public invoices, emails,
-- and website headers. They do not contain user-specific PII or sensitive data.
INSERT INTO storage.buckets (id, name, public)
VALUES ('company-branding', 'company-branding', true)
ON CONFLICT (id) DO NOTHING;

-- No storage.objects RLS needed for now: all writes use the service-role admin
-- client from the Settings UI or migration script (similar to product-images).
