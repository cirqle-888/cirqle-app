-- Add 'monthly' to the allowed report templates.
--
-- ad_report_schedules_tmpl_check was already stale before this change — it
-- never got 'daily' added when 20260630120000_ad_reports_daily_and_retention.sql
-- added it to ad_reports_template_check, so recurring schedules could never be
-- set up for a Daily Report. Both constraints are recreated here with the
-- full, matching template list (including the new 'monthly').

ALTER TABLE public.ad_reports DROP CONSTRAINT IF EXISTS ad_reports_template_check;
ALTER TABLE public.ad_reports ADD CONSTRAINT ad_reports_template_check
  CHECK (template IN ('executive', 'marketing', 'lead_gen', 'ecommerce', 'performance', 'agency', 'daily', 'monthly'));

ALTER TABLE public.ad_report_schedules DROP CONSTRAINT IF EXISTS ad_report_schedules_tmpl_check;
ALTER TABLE public.ad_report_schedules ADD CONSTRAINT ad_report_schedules_tmpl_check
  CHECK (template IN ('executive', 'marketing', 'lead_gen', 'ecommerce', 'performance', 'agency', 'daily', 'monthly'));
