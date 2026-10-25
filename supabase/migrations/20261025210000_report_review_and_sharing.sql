BEGIN;
CREATE TABLE public.ad_report_drafts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
 created_by UUID REFERENCES public.employees(id),
 config JSONB NOT NULL, config_hash TEXT NOT NULL, render_data JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day'
);
ALTER TABLE public.ad_report_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_report_drafts FROM anon, authenticated;
GRANT ALL ON public.ad_report_drafts TO service_role;
ALTER TABLE public.ad_reports
 ADD COLUMN image_bundle_url TEXT,
 ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','approved','superseded')),
 ADD COLUMN approved_by UUID REFERENCES public.employees(id),
 ADD COLUMN approved_at TIMESTAMPTZ,
 ADD COLUMN snapshot_id UUID REFERENCES public.ad_report_drafts(id) ON DELETE SET NULL,
 ADD COLUMN supersedes_id UUID REFERENCES public.ad_reports(id) ON DELETE SET NULL;
CREATE TABLE public.ad_report_shares (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 report_id UUID NOT NULL REFERENCES public.ad_reports(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_by UUID REFERENCES public.employees(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ
);
ALTER TABLE public.ad_report_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_report_shares FROM anon, authenticated;
GRANT ALL ON public.ad_report_shares TO service_role;

-- Preserve the tested atomic run creation and add a reviewed snapshot binding.
ALTER FUNCTION public.queue_ad_report(JSONB, TEXT) RENAME TO queue_ad_report_base;
REVOKE ALL ON FUNCTION public.queue_ad_report_base(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.queue_ad_report(p_config JSONB, p_request_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.ad_report_drafts; existing public.ad_reports; run JSONB; content JSONB;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
 SELECT * INTO existing FROM public.ad_reports WHERE request_key = p_request_key;
 IF FOUND THEN
   IF (existing.config - 'snapshotId') IS DISTINCT FROM (p_config - 'snapshotId') THEN RAISE EXCEPTION 'Request key reused with other settings'; END IF;
   RETURN jsonb_build_object('reportId', existing.id, 'jobId', existing.job_id, 'status', existing.status);
 END IF;
 IF p_config->>'snapshotId' IS NOT NULL THEN
  SELECT * INTO d FROM public.ad_report_drafts WHERE id = (p_config->>'snapshotId')::uuid FOR UPDATE;
  IF NOT FOUND OR d.expires_at <= now() OR d.client_id <> (p_config->>'clientId')::uuid
    OR d.created_by IS DISTINCT FROM (p_config->>'generatedBy')::uuid THEN
   RAISE EXCEPTION 'Preview is unavailable or expired';
  END IF;
  IF (d.config - ARRAY['recipients','generatedBy','reportId','snapshotId','allowIncomplete'])
    IS DISTINCT FROM (p_config - ARRAY['recipients','generatedBy','reportId','snapshotId','allowIncomplete']) THEN
   RAISE EXCEPTION 'Settings changed; refresh preview';
  END IF;
 END IF;
 IF p_config->>'supersedesId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ad_reports WHERE id = (p_config->>'supersedesId')::uuid AND client_id = (p_config->>'clientId')::uuid) THEN RAISE EXCEPTION 'Revision scope mismatch'; END IF;
 run := public.queue_ad_report_base(p_config, p_request_key);
 IF d.id IS NOT NULL THEN
  content := jsonb_set(d.render_data, '{config}', p_config);
  UPDATE public.ad_reports SET render_data = content, ai_narrative = content->'ai',
   snapshot_id = d.id, supersedes_id = (p_config->>'supersedesId')::uuid,
   review_status = CASE WHEN COALESCE((p_config->>'allowIncomplete')::boolean, false) THEN 'unreviewed' ELSE 'approved' END,
   approved_by = CASE WHEN COALESCE((p_config->>'allowIncomplete')::boolean, false) THEN NULL ELSE d.created_by END,
   approved_at = CASE WHEN COALESCE((p_config->>'allowIncomplete')::boolean, false) THEN NULL ELSE now() END
   WHERE id = (run->>'reportId')::uuid AND render_data IS NULL;
 END IF;
 RETURN run;
END $$;
REVOKE ALL ON FUNCTION public.queue_ad_report(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_ad_report(JSONB, TEXT) TO service_role;
COMMIT;
