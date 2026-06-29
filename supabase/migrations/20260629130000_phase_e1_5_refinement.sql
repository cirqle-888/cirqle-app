-- ==============================================================================
-- PHASE E1.5 REFINEMENT: Enterprise AI Foundations
-- ==============================================================================

-- 1. Expand ad_ai_insights
ALTER TABLE public.ad_ai_insights
ADD COLUMN IF NOT EXISTS root_cause TEXT,
ADD COLUMN IF NOT EXISTS suggested_action TEXT,
ADD COLUMN IF NOT EXISTS business_impact TEXT,
ADD COLUMN IF NOT EXISTS expected_roi TEXT,
ADD COLUMN IF NOT EXISTS estimated_savings NUMERIC,
ADD COLUMN IF NOT EXISTS timeline TEXT,
-- supporting_metrics is already JSONB, we can just use it or add it if missing
ADD COLUMN IF NOT EXISTS recommendation_status TEXT DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS recommendation_history JSONB DEFAULT '[]'::jsonb;

-- 2. Expand company_settings
ALTER TABLE public.company_settings
ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS default_ai_provider TEXT DEFAULT 'openai',
ADD COLUMN IF NOT EXISTS default_model TEXT DEFAULT 'gpt-4',
ADD COLUMN IF NOT EXISTS ai_temperature NUMERIC(3, 2) DEFAULT 0.7,
ADD COLUMN IF NOT EXISTS ai_max_tokens INTEGER DEFAULT 2000,
ADD COLUMN IF NOT EXISTS ai_cache_ttl INTEGER DEFAULT 24,
ADD COLUMN IF NOT EXISTS forecast_horizon INTEGER DEFAULT 30,
ADD COLUMN IF NOT EXISTS confidence_threshold INTEGER DEFAULT 70,
ADD COLUMN IF NOT EXISTS daily_ai_budget NUMERIC DEFAULT 10.00,
ADD COLUMN IF NOT EXISTS monthly_ai_budget NUMERIC DEFAULT 300.00,
ADD COLUMN IF NOT EXISTS health_score_weights JSONB DEFAULT '{"budget":20,"performance":40,"benchmark":20,"forecast":20}'::jsonb,
ADD COLUMN IF NOT EXISTS prompt_version TEXT DEFAULT 'v1';

-- 3. Advanced Materialized Views
DROP MATERIALIZED VIEW IF EXISTS public.mv_agency_benchmarks;
DROP MATERIALIZED VIEW IF EXISTS public.mv_client_performance;
DROP MATERIALIZED VIEW IF EXISTS public.mv_campaign_performance;

-- Create an extended view calculating rolling metrics
CREATE MATERIALIZED VIEW public.mv_campaign_performance AS
SELECT 
  project_id,
  SUM(spend) as total_spend,
  SUM(revenue) as total_revenue,
  SUM(impressions) as total_impressions,
  SUM(clicks) as total_clicks,
  SUM(leads) as total_leads,
  SUM(revenue) - SUM(spend) as profit,
  CASE WHEN SUM(revenue) > 0 THEN (SUM(revenue) - SUM(spend)) / SUM(revenue) ELSE 0 END as margin,
  CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE 0 END as roas,
  CASE WHEN SUM(clicks) > 0 THEN SUM(spend) / SUM(clicks) ELSE 0 END as cpc,
  CASE WHEN SUM(impressions) > 0 THEN (SUM(clicks)::numeric / SUM(impressions)) * 100 ELSE 0 END as ctr,
  CASE WHEN SUM(leads) > 0 THEN SUM(spend) / SUM(leads) ELSE 0 END as cpa,
  CASE WHEN SUM(leads) > 0 THEN SUM(spend) / SUM(leads) ELSE 0 END as cpl, -- cpa/cpl distinction depends on context
  CASE WHEN SUM(impressions) > 0 THEN (SUM(spend) / SUM(impressions)) * 1000 ELSE 0 END as cpm,
  CASE WHEN SUM(clicks) > 0 THEN (SUM(leads)::numeric / SUM(clicks)) * 100 ELSE 0 END as conversion_rate,
  
  -- Simulated Rolling 30 Days (In a real scenario, this requires a window function or nested subquery over dates)
  -- For MV simplicity without windowing over massive joined dates, we'll aggregate total. 
  -- Real 30-day requires `SUM(spend) FILTER (WHERE date >= current_date - 30)` but MVs aren't great with current_date since it's frozen at refresh time.
  -- We'll include placeholder static columns for the schema contract, updated by application logic or a time-aware cron.
  0 AS rolling_7d_spend,
  0 AS rolling_30d_spend,
  0 AS rolling_90d_spend,
  0 AS spend_growth_pct,
  0 AS spend_variance_pct,
  'flat' AS trend
FROM public.ad_daily_metrics
GROUP BY project_id;

CREATE UNIQUE INDEX idx_mv_campaign_performance_project ON public.mv_campaign_performance (project_id);

CREATE MATERIALIZED VIEW public.mv_client_performance AS
SELECT 
  p.client_id,
  SUM(m.spend) as total_spend,
  SUM(m.revenue) as total_revenue,
  SUM(m.leads) as total_leads,
  SUM(m.revenue) - SUM(m.spend) as profit,
  CASE WHEN SUM(m.revenue) > 0 THEN (SUM(m.revenue) - SUM(m.spend)) / SUM(m.revenue) ELSE 0 END as margin,
  CASE WHEN SUM(m.spend) > 0 THEN SUM(m.revenue) / SUM(m.spend) ELSE 0 END as roas,
  CASE WHEN SUM(m.leads) > 0 THEN SUM(m.spend) / SUM(m.leads) ELSE 0 END as cpa
FROM public.ad_daily_metrics m
JOIN public.ad_projects p ON m.project_id = p.id
GROUP BY p.client_id;

CREATE UNIQUE INDEX idx_mv_client_performance_client ON public.mv_client_performance (client_id);

CREATE MATERIALIZED VIEW public.mv_agency_benchmarks AS
SELECT 
  AVG(roas) as avg_roas,
  AVG(cpc) as avg_cpc,
  AVG(ctr) as avg_ctr,
  AVG(cpa) as avg_cpa,
  AVG(cpm) as avg_cpm,
  AVG(conversion_rate) as avg_conversion_rate,
  AVG(margin) as avg_margin
FROM public.mv_campaign_performance;
