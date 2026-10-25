-- Roll back application code together with this migration. Retain snapshots and
-- audit data deliberately; no report or client data is deleted.
BEGIN;
DROP FUNCTION public.queue_ad_report(JSONB, TEXT);
ALTER FUNCTION public.queue_ad_report_base(JSONB, TEXT) RENAME TO queue_ad_report;
REVOKE ALL ON public.ad_report_drafts, public.ad_report_shares FROM service_role;
COMMIT;
