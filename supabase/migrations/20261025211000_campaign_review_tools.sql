BEGIN;
CREATE TABLE public.ad_campaign_annotations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
 occurred_on DATE NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('creative','targeting','budget','note')),
 note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
 created_by UUID REFERENCES public.employees(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.ad_budget_requests (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
 amount NUMERIC(16,2) NOT NULL CHECK (amount > 0), currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
 status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected')),
 requested_by UUID REFERENCES public.employees(id), decided_by UUID REFERENCES public.employees(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
 decided_at TIMESTAMPTZ
);
ALTER TABLE public.leads
 ADD COLUMN IF NOT EXISTS enquiry_quality TEXT CHECK (enquiry_quality IN ('valid','invalid')),
 ADD COLUMN IF NOT EXISTS quality_reason TEXT,
 ADD COLUMN IF NOT EXISTS quality_reviewed_by UUID REFERENCES public.employees(id),
 ADD COLUMN IF NOT EXISTS quality_reviewed_at TIMESTAMPTZ;
ALTER TABLE public.ad_campaign_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_budget_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_campaign_annotations, public.ad_budget_requests FROM anon, authenticated;
GRANT ALL ON public.ad_campaign_annotations, public.ad_budget_requests TO service_role;
CREATE INDEX ON public.ad_campaign_annotations(project_id, occurred_on);
CREATE INDEX ON public.ad_budget_requests(project_id, created_at);
COMMIT;
