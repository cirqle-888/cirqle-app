BEGIN;
CREATE TABLE public.ad_report_delivery_events (
 event_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('delivered','bounced','failed')),
 occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.ad_report_delivery_events(provider_id, occurred_at);
ALTER TABLE public.ad_report_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_report_delivery_events FROM anon, authenticated;
GRANT ALL ON public.ad_report_delivery_events TO service_role;

CREATE FUNCTION public.reconcile_report_delivery_events(p_report_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.ad_reports; result JSONB := '[]'; attempt JSONB; e public.ad_report_delivery_events;
BEGIN
 SELECT * INTO r FROM public.ad_reports WHERE id = p_report_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 FOR attempt IN SELECT value FROM jsonb_array_elements(r.delivery_results) LOOP
  SELECT * INTO e FROM public.ad_report_delivery_events WHERE provider_id = attempt->>'providerId' ORDER BY occurred_at DESC, event_id DESC LIMIT 1;
  IF FOUND AND (attempt->>'providerEventAt' IS NULL OR e.occurred_at > (attempt->>'providerEventAt')::timestamptz) THEN
    attempt := attempt || jsonb_build_object('status', e.state, 'providerEventAt', e.occurred_at);
  END IF;
  result := result || jsonb_build_array(attempt);
 END LOOP;
 UPDATE public.ad_reports SET delivery_results = result WHERE id = r.id;
END $$;
CREATE FUNCTION public.record_report_delivery_event(p_event_id TEXT, p_provider_id TEXT, p_state TEXT, p_occurred_at TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD;
BEGIN
 INSERT INTO public.ad_report_delivery_events(event_id, provider_id, state, occurred_at)
 VALUES (p_event_id, p_provider_id, p_state, p_occurred_at) ON CONFLICT DO NOTHING;
 FOR r IN SELECT id FROM public.ad_reports WHERE delivery_results @> jsonb_build_array(jsonb_build_object('providerId', p_provider_id)) LOOP
  PERFORM public.reconcile_report_delivery_events(r.id);
 END LOOP;
END $$;
CREATE FUNCTION public.claim_report_delivery(p_report_id UUID, p_email TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.ad_reports; prior JSONB; attempt_id UUID := gen_random_uuid(); result JSONB;
BEGIN
 SELECT * INTO r FROM public.ad_reports WHERE id = p_report_id FOR UPDATE;
 IF NOT FOUND OR r.status <> 'ready' OR r.review_status <> 'approved' THEN RAISE EXCEPTION 'Approve a complete report before sending'; END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.config->'recipients','[]')) x WHERE lower(x->>'email') = lower(p_email)) THEN RAISE EXCEPTION 'Recipient is not on this report'; END IF;
 SELECT value INTO prior FROM jsonb_array_elements(r.delivery_results) WHERE lower(value->>'email') = lower(p_email);
 IF prior IS NOT NULL AND prior->>'status' <> 'failed' THEN RAISE EXCEPTION 'This recipient has already been sent or needs manual review'; END IF;
 SELECT COALESCE(jsonb_agg(value),'[]') INTO result FROM jsonb_array_elements(r.delivery_results) WHERE lower(value->>'email') <> lower(p_email);
 result := result || jsonb_build_array(jsonb_build_object('email',p_email,'status','sending','attemptId',attempt_id));
 UPDATE public.ad_reports SET delivery_results = result WHERE id = r.id;
 RETURN jsonb_build_object('attemptId',attempt_id,'renderData',r.render_data,'exports',r.export_results);
END $$;
CREATE FUNCTION public.finish_report_delivery(p_report_id UUID, p_email TEXT, p_attempt_id TEXT, p_result JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 UPDATE public.ad_reports SET delivery_results = (
  SELECT COALESCE(jsonb_agg(CASE WHEN value->>'attemptId' = p_attempt_id AND lower(value->>'email') = lower(p_email)
    THEN value || p_result ELSE value END),'[]') FROM jsonb_array_elements(delivery_results)
 ) WHERE id = p_report_id;
 PERFORM public.reconcile_report_delivery_events(p_report_id);
END $$;
REVOKE ALL ON FUNCTION public.reconcile_report_delivery_events(UUID), public.record_report_delivery_event(TEXT,TEXT,TEXT,TIMESTAMPTZ), public.claim_report_delivery(UUID,TEXT), public.finish_report_delivery(UUID,TEXT,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_report_delivery_events(UUID), public.record_report_delivery_event(TEXT,TEXT,TEXT,TIMESTAMPTZ), public.claim_report_delivery(UUID,TEXT), public.finish_report_delivery(UUID,TEXT,TEXT,JSONB) TO service_role;
-- Distinct lifecycle clocks; queueing is not successful generation/delivery.
ALTER TABLE public.ad_report_schedules
 ADD COLUMN last_enqueued_at TIMESTAMPTZ,
 ADD COLUMN last_generated_at TIMESTAMPTZ,
 ADD COLUMN last_delivered_at TIMESTAMPTZ;
CREATE FUNCTION public.track_report_schedule_progress()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE delivered_at TIMESTAMPTZ;
BEGIN
 IF NEW.schedule_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP = 'INSERT' THEN
  UPDATE public.ad_report_schedules SET last_enqueued_at = GREATEST(last_enqueued_at, NEW.created_at) WHERE id = NEW.schedule_id;
 END IF;
 IF NEW.status = 'ready' AND NEW.generated_at IS NOT NULL THEN
  UPDATE public.ad_report_schedules SET last_generated_at = GREATEST(last_generated_at, NEW.generated_at) WHERE id = NEW.schedule_id;
 END IF;
 SELECT max((value->>'providerEventAt')::timestamptz) INTO delivered_at
 FROM jsonb_array_elements(NEW.delivery_results) WHERE value->>'status' = 'delivered';
 IF delivered_at IS NOT NULL THEN
  UPDATE public.ad_report_schedules SET last_delivered_at = GREATEST(last_delivered_at, delivered_at) WHERE id = NEW.schedule_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.track_report_schedule_progress() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER track_report_schedule_progress AFTER INSERT OR UPDATE OF status, generated_at, delivery_results ON public.ad_reports
FOR EACH ROW EXECUTE FUNCTION public.track_report_schedule_progress();
COMMIT;
