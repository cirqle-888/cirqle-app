-- 1. Allow the "daily" template on ad_reports.
--    The original CHECK omitted 'daily', so generating a Daily Report
--    (now the default) fails at insert. Recreate the constraint with 'daily'.
ALTER TABLE public.ad_reports DROP CONSTRAINT IF EXISTS ad_reports_template_check;
ALTER TABLE public.ad_reports ADD CONSTRAINT ad_reports_template_check
  CHECK (template IN ('executive', 'marketing', 'lead_gen', 'ecommerce', 'performance', 'agency', 'daily'));

-- 2. Retention window (in days) for generated reports. The cleanup cron
--    deletes ad_reports rows + their storage objects older than this.
--    Reports are delivered to WhatsApp/email, so the DB only keeps them briefly.
INSERT INTO public.company_settings (key, value)
VALUES ('report_retention_days', '1')
ON CONFLICT (key) DO NOTHING;
