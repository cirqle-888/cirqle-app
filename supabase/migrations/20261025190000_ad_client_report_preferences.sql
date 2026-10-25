-- Per-client report preferences for the report composer.
--
-- Additive. Until this is applied the composer works with plain defaults and
-- hides "Save as default for this client". Recipients are stored but never
-- used implicitly: the composer shows them and the person must tick "Email
-- this report" on every send.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_client_report_preferences (
  client_id           UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  preset              TEXT NOT NULL DEFAULT 'monthly'
    CONSTRAINT ad_client_report_prefs_preset_check CHECK (preset IN ('quick', 'monthly', 'detailed')),
  period              TEXT NOT NULL DEFAULT 'last_month'
    CONSTRAINT ad_client_report_prefs_period_check CHECK (period IN ('yesterday', 'last7', 'last_month', 'lifetime')),
  include_comparison  BOOLEAN NOT NULL DEFAULT true,
  -- Empty = every eligible campaign of the client at report time.
  default_project_ids UUID[] NOT NULL DEFAULT '{}',
  recipients          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Reserved for the Malayalam summary work; only 'en' is produced today.
  language            TEXT NOT NULL DEFAULT 'en'
    CONSTRAINT ad_client_report_prefs_language_check CHECK (language IN ('en', 'ml')),
  updated_by          UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Writes go through the guarded server action (admin client).
ALTER TABLE public.ad_client_report_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_client_report_prefs_select" ON public.ad_client_report_preferences;
CREATE POLICY "ad_client_report_prefs_select" ON public.ad_client_report_preferences
  FOR SELECT TO authenticated USING (true);

COMMIT;
