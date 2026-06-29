-- ==============================================================================
-- PHASE E1: AI Foundation, Database & Intelligence Layer
-- ==============================================================================

-- 1. Prompt Management
CREATE TABLE IF NOT EXISTS public.ai_prompts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider TEXT NOT NULL, -- e.g. 'openai', 'gemini'
  prompt_type TEXT NOT NULL, -- e.g. 'health_score', 'recommendation'
  version TEXT NOT NULL, -- e.g. '1.0.0'
  prompt_template TEXT NOT NULL,
  variables JSONB DEFAULT '[]'::jsonb, -- e.g. ["budget", "roas_trend"]
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'active', 'archived'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure only one active version per provider+prompt_type
CREATE UNIQUE INDEX idx_active_ai_prompts ON public.ai_prompts (provider, prompt_type) WHERE status = 'active';

-- 2. AI Cache
CREATE TABLE IF NOT EXISTS public.ad_ai_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  analysis_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response JSONB NOT NULL,
  token_usage JSONB,
  cost NUMERIC(10, 6),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_cache_lookup ON public.ad_ai_cache (client_id, project_id, analysis_type, payload_hash) WHERE expires_at > NOW();

-- 3. AI Insights & Recommendations
CREATE TABLE IF NOT EXISTS public.ad_ai_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  insight_type TEXT NOT NULL, -- 'recommendation', 'alert', 'opportunity'
  title TEXT NOT NULL,
  summary TEXT,
  explanation TEXT,
  supporting_metrics JSONB,
  recommendation TEXT,
  priority TEXT DEFAULT 'normal', -- 'low', 'normal', 'high', 'critical'
  hybrid_confidence NUMERIC(5, 2), -- 0.00 to 100.00
  expected_impact TEXT,
  status TEXT DEFAULT 'active', -- 'active', 'accepted', 'applied', 'rejected', 'dismissed', 'expired'
  accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  dismissed_reason TEXT,
  user_feedback TEXT, -- 'helpful', 'not_helpful', 'incorrect', 'already_applied'
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Forecast Accuracy
CREATE TABLE IF NOT EXISTS public.ad_forecast_accuracy (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prediction_date DATE NOT NULL,
  metric TEXT NOT NULL, -- e.g. 'spend', 'roas'
  predicted_value NUMERIC(15, 6),
  actual_value NUMERIC(15, 6),
  variance NUMERIC(15, 6),
  accuracy_percent NUMERIC(5, 2),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- 5. Benchmarks
CREATE TABLE IF NOT EXISTS public.ad_benchmarks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  benchmark_type TEXT NOT NULL, -- 'campaign', 'client', 'agency', 'industry', 'region', 'country', 'objective'
  entity_id UUID, -- References the client/campaign if applicable
  metric_name TEXT NOT NULL,
  metric_value NUMERIC(15, 6),
  sample_size INTEGER,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_ad_benchmarks_lookup ON public.ad_benchmarks (benchmark_type, entity_id, metric_name);

-- 6. Materialized Views
-- Note: These depend on ad_daily_metrics which exists from previous phases.

CREATE MATERIALIZED VIEW public.mv_campaign_performance AS
SELECT 
  project_id,
  SUM(spend) as total_spend,
  SUM(revenue) as total_revenue,
  SUM(impressions) as total_impressions,
  SUM(clicks) as total_clicks,
  SUM(leads) as total_leads,
  CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE 0 END as roas,
  CASE WHEN SUM(clicks) > 0 THEN SUM(spend) / SUM(clicks) ELSE 0 END as cpc,
  CASE WHEN SUM(impressions) > 0 THEN (SUM(clicks)::numeric / SUM(impressions)) * 100 ELSE 0 END as ctr
FROM public.ad_daily_metrics
GROUP BY project_id;

CREATE UNIQUE INDEX idx_mv_campaign_performance_project ON public.mv_campaign_performance (project_id);

CREATE MATERIALIZED VIEW public.mv_client_performance AS
SELECT 
  p.client_id,
  SUM(m.spend) as total_spend,
  SUM(m.revenue) as total_revenue,
  CASE WHEN SUM(m.spend) > 0 THEN SUM(m.revenue) / SUM(m.spend) ELSE 0 END as roas
FROM public.ad_daily_metrics m
JOIN public.ad_projects p ON m.project_id = p.id
GROUP BY p.client_id;

CREATE UNIQUE INDEX idx_mv_client_performance_client ON public.mv_client_performance (client_id);

CREATE MATERIALIZED VIEW public.mv_agency_benchmarks AS
SELECT 
  AVG(roas) as avg_roas,
  AVG(cpc) as avg_cpc,
  AVG(ctr) as avg_ctr
FROM public.mv_campaign_performance;

