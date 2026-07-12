-- ==============================================================================
-- PHASE E1.5: Enterprise AI Foundation Improvements
-- ==============================================================================

-- 1. Expand ai_prompts
ALTER TABLE public.ai_prompts
ADD COLUMN IF NOT EXISTS model TEXT,
ADD COLUMN IF NOT EXISTS temperature NUMERIC(3, 2),
ADD COLUMN IF NOT EXISTS max_tokens INTEGER,
ADD COLUMN IF NOT EXISTS top_p NUMERIC(3, 2),
ADD COLUMN IF NOT EXISTS frequency_penalty NUMERIC(3, 2),
ADD COLUMN IF NOT EXISTS presence_penalty NUMERIC(3, 2),
ADD COLUMN IF NOT EXISTS output_schema JSONB;

-- Rename 'status' to 'prompt_status' or just use 'status' since it already exists. We will keep 'status' and 'version'.
-- The previous migration had: status, version. The user requested prompt_version, prompt_status.
-- Let's just alias them in our types, or rename the columns. We'll rename them for exact compliance.
ALTER TABLE public.ai_prompts RENAME COLUMN version TO prompt_version;
ALTER TABLE public.ai_prompts RENAME COLUMN status TO prompt_status;

-- ReCREATE INDEX IF NOT EXISTS since we renamed columns
DROP INDEX IF EXISTS idx_active_ai_prompts;
CREATE UNIQUE INDEX idx_active_ai_prompts ON public.ai_prompts (provider, prompt_type) WHERE prompt_status = 'active';

-- 2. Expand ad_ai_cache
ALTER TABLE public.ad_ai_cache
ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
ADD COLUMN IF NOT EXISTS model TEXT,
-- provider is already there
ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER,
ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
ADD COLUMN IF NOT EXISTS total_tokens INTEGER,
ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(15, 6),
ADD COLUMN IF NOT EXISTS cache_hit_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS created_by_worker TEXT;

-- 3. Expand Materialized Views
-- Drop existing MVs first to recreate them with expanded columns
DROP MATERIALIZED VIEW IF EXISTS public.mv_agency_benchmarks;
DROP MATERIALIZED VIEW IF EXISTS public.mv_client_performance;
DROP MATERIALIZED VIEW IF EXISTS public.mv_campaign_performance;

-- Recreate mv_campaign_performance
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
  CASE WHEN SUM(leads) > 0 THEN SUM(spend) / SUM(leads) ELSE 0 END as cpa, -- or Cost Per Lead depending on goal
  CASE WHEN SUM(impressions) > 0 THEN (SUM(spend) / SUM(impressions)) * 1000 ELSE 0 END as cpm,
  CASE WHEN SUM(clicks) > 0 THEN (SUM(leads)::numeric / SUM(clicks)) * 100 ELSE 0 END as conversion_rate
FROM public.ad_daily_metrics
GROUP BY project_id;

CREATE UNIQUE INDEX idx_mv_campaign_performance_project ON public.mv_campaign_performance (project_id);

-- Recreate mv_client_performance
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

-- Recreate mv_agency_benchmarks
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


-- 4. RPC for cache hit counter
CREATE OR REPLACE FUNCTION increment_ai_cache_hit(row_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE public.ad_ai_cache
  SET cache_hit_count = cache_hit_count + 1
  WHERE id = row_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
