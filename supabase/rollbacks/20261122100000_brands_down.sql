-- Undo 20261122100000_brands.
-- Drops the brand columns and the brands table. Which brand each account,
-- campaign, task, entry and service belonged to is lost; the rows themselves
-- are untouched. Also removes the invoice-identity cache the app writes.
BEGIN;
ALTER TABLE public.social_accounts  DROP COLUMN IF EXISTS brand_id;
ALTER TABLE public.ad_projects      DROP COLUMN IF EXISTS brand_id;
ALTER TABLE public.tasks            DROP COLUMN IF EXISTS brand_id;
ALTER TABLE public.cashbook_entries DROP COLUMN IF EXISTS brand_id;
ALTER TABLE public.services         DROP COLUMN IF EXISTS brand_id;
DROP TABLE IF EXISTS public.brands;
DELETE FROM public.company_settings WHERE key = 'brand_invoice_identity';
NOTIFY pgrst, 'reload schema';
COMMIT;
