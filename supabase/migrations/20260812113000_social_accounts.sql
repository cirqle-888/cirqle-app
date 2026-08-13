-- ============================================================================
-- Cirqle Social Hub — Phase 1: connected social accounts + insights storage
-- ============================================================================
-- Normalized internal data layer (spec §22): the app never depends directly on
-- Meta API response shapes. Adapter code writes into these tables; UI reads
-- only from them.
--
--   social_accounts               — one row per connected FB Page / IG account
--   social_account_insights_daily — one row per account per day (time series)
--   social_media_items            — published content registry + per-item metrics
--
-- Metric naming follows Meta's 2025/2026 reset: `views` is the canonical
-- consumption metric (impressions/plays are dead), reach is kept as secondary.
-- ============================================================================

BEGIN;

-- ── Connected social accounts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  connection_id           UUID REFERENCES public.provider_connections(id) ON DELETE SET NULL,
  provider                TEXT NOT NULL DEFAULT 'meta',
  platform                TEXT NOT NULL CHECK (platform IN ('facebook_page','instagram')),
  external_id             TEXT NOT NULL,             -- Page ID / IG user ID
  name                    TEXT NOT NULL,
  username                TEXT,                      -- IG @handle
  profile_picture_url     TEXT,
  followers_count         INTEGER,
  -- IG rows: the FB Page the IG professional account is linked through.
  linked_page_account_id  UUID REFERENCES public.social_accounts(id) ON DELETE SET NULL,
  -- Page access token (AES-256-GCM encrypted by the app). Page tokens obtained
  -- from a long-lived user token do not expire. IG rows publish via metaGraph
  -- calls authorized by the linked page's token or the connection user token.
  access_token            TEXT,
  status                  TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected','disconnected','needs_reauth','error')),
  publishing_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  insights_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at          TIMESTAMPTZ,
  last_error              TEXT,
  metadata                JSONB,                     -- raw provider extras (category, biography, …)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, external_id)
);

CREATE INDEX IF NOT EXISTS social_accounts_client_idx     ON public.social_accounts (client_id);
CREATE INDEX IF NOT EXISTS social_accounts_connection_idx ON public.social_accounts (connection_id);
CREATE INDEX IF NOT EXISTS social_accounts_status_idx     ON public.social_accounts (status);

DROP TRIGGER IF EXISTS update_social_accounts_modtime ON public.social_accounts;
CREATE OR REPLACE TRIGGER update_social_accounts_modtime
  BEFORE UPDATE ON public.social_accounts FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Holds encrypted tokens → service-role only (same posture as provider_connections).
ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;

-- ── Daily account-level insights ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_account_insights_daily (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  metric_date        DATE NOT NULL,
  followers_count    INTEGER,          -- snapshot at sync time
  follows            INTEGER,          -- new follows that day (page_daily_follows_unique / follower_count)
  unfollows          INTEGER,
  reach              BIGINT,
  views              BIGINT,           -- canonical consumption metric (2026)
  total_interactions BIGINT,           -- IG total_interactions / FB page_post_engagements
  accounts_engaged   BIGINT,           -- IG only
  profile_links_taps BIGINT,           -- IG only (replaced website_clicks etc.)
  page_views         BIGINT,           -- FB page_views_total / IG profile views where exposed
  raw                JSONB,            -- full metric payload for future-proofing
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, metric_date)
);

CREATE INDEX IF NOT EXISTS social_insights_daily_date_idx
  ON public.social_account_insights_daily (account_id, metric_date DESC);

ALTER TABLE public.social_account_insights_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_insights_read ON public.social_account_insights_daily;
CREATE POLICY social_insights_read ON public.social_account_insights_daily
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Published media registry + per-item performance ─────────────────────────
CREATE TABLE IF NOT EXISTS public.social_media_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  external_media_id  TEXT NOT NULL,
  media_type         TEXT,             -- IMAGE | VIDEO | CAROUSEL_ALBUM | photo | video_inline …
  media_product_type TEXT,             -- FEED | REELS | STORY | AD
  caption            TEXT,
  permalink          TEXT,
  thumbnail_url      TEXT,
  media_url          TEXT,
  posted_at          TIMESTAMPTZ,
  is_story           BOOLEAN NOT NULL DEFAULT FALSE,
  story_expires_at   TIMESTAMPTZ,      -- stories: posted_at + 24h; insights die with it
  -- Metrics (views-era naming)
  views              BIGINT,
  reach              BIGINT,
  likes              INTEGER,
  comments           INTEGER,
  shares             INTEGER,
  saves              INTEGER,
  total_interactions BIGINT,
  engagement_rate    NUMERIC(8,4),     -- total_interactions / reach * 100 (when reach > 0)
  raw_insights       JSONB,
  last_insights_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, external_media_id)
);

CREATE INDEX IF NOT EXISTS social_media_items_posted_idx
  ON public.social_media_items (account_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS social_media_items_product_idx
  ON public.social_media_items (account_id, media_product_type);

DROP TRIGGER IF EXISTS update_social_media_items_modtime ON public.social_media_items;
CREATE OR REPLACE TRIGGER update_social_media_items_modtime
  BEFORE UPDATE ON public.social_media_items FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.social_media_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_media_items_read ON public.social_media_items;
CREATE POLICY social_media_items_read ON public.social_media_items
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Permission catalog ───────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('social', 'connect',       'social.connect',       'Connect Social Accounts',
    'Connect/disconnect Meta assets (Facebook Pages, Instagram accounts) for clients', 91),
  ('social', 'view_insights', 'social.view_insights', 'View Social Insights',
    'View social dashboards: reach, views, engagement, content performance', 92)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('social.connect','social.view_insights')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
