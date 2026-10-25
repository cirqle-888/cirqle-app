-- Roll back application code and disable the provider webhook first.
-- Keep the event inbox and report delivery history for recovery.
BEGIN;
DROP TRIGGER track_report_schedule_progress ON public.ad_reports;
DROP FUNCTION public.track_report_schedule_progress();
DROP FUNCTION public.finish_report_delivery(UUID,TEXT,TEXT,JSONB);
DROP FUNCTION public.claim_report_delivery(UUID,TEXT);
DROP FUNCTION public.record_report_delivery_event(TEXT,TEXT,TEXT,TIMESTAMPTZ);
DROP FUNCTION public.reconcile_report_delivery_events(UUID);
REVOKE ALL ON public.ad_report_delivery_events FROM service_role;
COMMIT;
