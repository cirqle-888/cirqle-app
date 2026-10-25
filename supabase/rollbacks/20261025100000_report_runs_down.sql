-- Stop report generation/workers, deploy the previous code, then run this.
-- Keep additive columns and snapshots for recovery; do not erase report history.
BEGIN;
DROP FUNCTION IF EXISTS public.retry_ad_report(UUID);
DROP FUNCTION IF EXISTS public.queue_ad_report(JSONB, TEXT);
UPDATE public.ad_reports SET status = 'ready',
 error_message = COALESCE(error_message, 'Some report formats were not generated.')
 WHERE status = 'partial';
ALTER TABLE public.ad_reports DROP CONSTRAINT IF EXISTS ad_reports_status_check;
ALTER TABLE public.ad_reports ADD CONSTRAINT ad_reports_status_check
 CHECK (status IN ('pending', 'generating', 'ready', 'failed'));
COMMIT;
