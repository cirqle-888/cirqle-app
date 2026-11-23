-- ============================================================================
-- Ad Library — ads saved from the Facebook Ad Library with the Chrome extension
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- The "Cirqle Ad Saver" Chrome extension puts a Save button on every ad in
-- facebook.com/ads/library. A saved ad lands here with its text, links, dates
-- and a copy of its pictures and videos (Facebook's own media links expire,
-- so the files are copied into the private "ad-library" storage bucket).
--
-- The extension has no app session. Each person makes their own connect key in
-- the app (Ad Library → Connect Chrome); only a SHA-256 hash of the key is kept
-- here, and the extension sends the key as a bearer token to /api/ad-library.
--
-- All three tables are server-only: RLS on, no browser grants. The app reads
-- and writes them with the service role behind advertising.view / .create.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_saver_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL,                     -- sha256 hex of the key; the key itself is shown once
  key_hint      TEXT,                              -- last 4 characters, so the person can tell keys apart
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_saver_keys_hash_key ON public.ad_saver_keys (key_hash);

CREATE TABLE IF NOT EXISTS public.ad_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.saved_ads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id         TEXT NOT NULL,                 -- Facebook Ad Library id
  platform           TEXT NOT NULL DEFAULT 'facebook',
  status             TEXT,                          -- active | inactive (when it was saved)
  page_name          TEXT,
  page_url           TEXT,
  page_avatar        TEXT,                          -- storage path in ad-library, or null
  body               TEXT,                          -- the ad's main text
  headline           TEXT,
  link_caption       TEXT,                          -- the small domain line, e.g. AMAZON.IN
  landing_url        TEXT,
  cta                TEXT,                          -- Shop Now, Learn More…
  started_on         DATE,
  ended_on           DATE,
  multiple_versions  BOOLEAN NOT NULL DEFAULT FALSE,
  media              JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{kind:'image'|'video', path, poster}]
  folder_id          UUID REFERENCES public.ad_folders(id) ON DELETE SET NULL,
  client_id          UUID REFERENCES clients(id) ON DELETE SET NULL,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  notes              TEXT,
  source_url         TEXT,                          -- the Ad Library page it was saved from
  saved_by           UUID REFERENCES employees(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_ads_library_key ON public.saved_ads (platform, library_id);
CREATE INDEX IF NOT EXISTS saved_ads_folder_idx ON public.saved_ads (folder_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS saved_ads_client_idx ON public.saved_ads (client_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS saved_ads_created_idx ON public.saved_ads (created_at DESC);

ALTER TABLE public.ad_saver_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_folders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_ads     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_saver_keys, public.ad_folders, public.saved_ads FROM anon, authenticated;

-- Private bucket for copies of the ads' pictures and videos. Read through
-- short-lived signed links made by the app; written through signed upload
-- links handed to the extension by /api/ad-library.
INSERT INTO storage.buckets (id, name, public)
VALUES ('ad-library', 'ad-library', false)
ON CONFLICT (id) DO NOTHING;

-- A few starting folders; rename or delete them in the app.
INSERT INTO public.ad_folders (name, sort)
SELECT v.name, v.sort FROM (VALUES ('Inspiration', 0), ('Competitors', 1), ('Client ideas', 2)) AS v(name, sort)
WHERE NOT EXISTS (SELECT 1 FROM public.ad_folders);

COMMIT;
