-- Additive report runs. Apply before deploying the new reporting code.
BEGIN;
ALTER TABLE public.ad_reports DROP CONSTRAINT IF EXISTS ad_reports_status_check;
ALTER TABLE public.ad_reports ADD CONSTRAINT ad_reports_status_check
 CHECK (status IN ('pending', 'generating', 'partial', 'ready', 'failed'));
ALTER TABLE public.ad_reports
 ADD COLUMN IF NOT EXISTS config JSONB,
 ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN IF NOT EXISTS request_key TEXT,
 ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES public.system_jobs(id) ON DELETE SET NULL,
 ADD COLUMN IF NOT EXISTS export_results JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS export_failures JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS delivery_results JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS stage TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ad_reports_request_key ON public.ad_reports(request_key) WHERE request_key IS NOT NULL;

-- Report and queue row commit together. Only trusted server code may invoke this.
CREATE OR REPLACE FUNCTION public.queue_ad_report(p_config JSONB, p_request_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.ad_reports; j UUID;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
 SELECT * INTO r FROM public.ad_reports WHERE request_key = p_request_key;
 IF FOUND THEN
   IF r.config IS DISTINCT FROM p_config THEN RAISE EXCEPTION 'Request key already used with another configuration'; END IF;
   RETURN jsonb_build_object('reportId', r.id, 'jobId', r.job_id, 'status', r.status);
 END IF;
 INSERT INTO public.ad_reports(project_id, client_id, report_type, template, date_from, date_to,
 comparison_from, comparison_to, generated_by, schedule_id, status, stage, config, request_key)
 VALUES ((p_config->>'projectId')::uuid, (p_config->>'clientId')::uuid,
 p_config->>'reportType', p_config->>'template', (p_config->>'dateFrom')::date,
 (p_config->>'dateTo')::date, (p_config->>'comparisonFrom')::date,
 (p_config->>'comparisonTo')::date, (p_config->>'generatedBy')::uuid,
 (p_config->>'scheduleId')::uuid, 'pending', 'queued', p_config, p_request_key) RETURNING * INTO r;
 INSERT INTO public.system_jobs(job_type, priority, status, payload, max_attempts)
 VALUES ('advertising_generate_report', 'normal', 'pending',
 p_config || jsonb_build_object('reportId', r.id), 3) RETURNING id INTO j;
 UPDATE public.ad_reports SET job_id = j WHERE id = r.id;
 RETURN jsonb_build_object('reportId', r.id, 'jobId', j, 'status', 'pending');
END $$;
REVOKE ALL ON FUNCTION public.queue_ad_report(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_ad_report(JSONB, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.retry_ad_report(p_report_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.ad_reports; j UUID; job_status TEXT; job_heartbeat TIMESTAMPTZ;
BEGIN
 SELECT * INTO r FROM public.ad_reports WHERE id = p_report_id FOR UPDATE;
 IF NOT FOUND OR r.config IS NULL THEN RAISE EXCEPTION 'Report cannot be retried; create a new report'; END IF;
 SELECT status, COALESCE(locked_at, started_at, queued_at) INTO job_status, job_heartbeat FROM public.system_jobs WHERE id = r.job_id FOR UPDATE;
 IF job_status = 'running' AND job_heartbeat < now() - interval '5 minutes' THEN
   UPDATE public.system_jobs SET status = 'failed', finished_at = now(), error_log = 'Interrupted report run' WHERE id = r.job_id;
   UPDATE public.ad_reports SET status = 'failed' WHERE id = r.id;
   r.status := 'failed';
   job_status := 'failed';
 END IF;
 IF job_status IN ('pending', 'queued', 'running') THEN
   IF job_status IN ('pending', 'queued') THEN
     UPDATE public.system_jobs SET queued_at = now() WHERE id = r.job_id;
     UPDATE public.ad_reports SET status = 'pending', stage = 'queued' WHERE id = r.id;
   END IF;
   RETURN jsonb_build_object('reportId', r.id, 'jobId', r.job_id, 'status', r.status);
 END IF;
 IF r.status NOT IN ('partial', 'failed') THEN RAISE EXCEPTION 'Only incomplete reports can be retried'; END IF;
 INSERT INTO public.system_jobs(job_type, priority, status, payload, max_attempts)
 VALUES ('advertising_generate_report', 'normal', 'pending',
 r.config || jsonb_build_object('reportId', r.id), 3) RETURNING id INTO j;
 UPDATE public.ad_reports SET job_id = j, status = 'pending', stage = 'queued', error_message = NULL WHERE id = r.id;
 RETURN jsonb_build_object('reportId', r.id, 'jobId', j, 'status', 'pending');
END $$;
REVOKE ALL ON FUNCTION public.retry_ad_report(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_ad_report(UUID) TO service_role;
COMMIT;
