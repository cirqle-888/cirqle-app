-- ============================================================================
-- Campaign Mapping — discover campaigns inside a shared ad account and map each
-- to a Client + Objective + Cirqle Project.
-- ============================================================================
-- One Meta (or other provider) Ad Account can hold campaigns for many clients.
-- `ad_campaigns` is the discovery + mapping registry: every campaign found in an
-- account lands here as `unmapped` until a user assigns it. Mapping links the
-- row to an `ad_projects` row (1 campaign : 1 project) so all existing per-project
-- machinery (sync, metrics, reports, AI, health, schedules) works unchanged.
--
-- Defensive: app code degrades to an empty / "run migration" state until this is
-- applied. Conventions match 20260628120000_advertising_module.sql.
-- ============================================================================

BEGIN;

-- ── Discovery + mapping registry ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_campaigns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Where the campaign lives (provider side)
  ad_account_id        UUID NOT NULL REFERENCES public.ad_accounts(id)         ON DELETE CASCADE,
  connection_id        UUID          REFERENCES public.provider_connections(id) ON DELETE SET NULL,
  provider             TEXT NOT NULL DEFAULT 'meta',
  external_campaign_id TEXT NOT NULL,                 -- e.g. Meta campaign id
  name                 TEXT NOT NULL,
  objective            TEXT,                          -- raw provider objective (OUTCOME_LEADS, …)
  status               TEXT,                          -- raw provider status (ACTIVE/PAUSED/…)
  -- Mapping decision (NULL until assigned)
  mapping_status       TEXT NOT NULL DEFAULT 'unmapped'
    CHECK (mapping_status IN ('unmapped','mapped','ignored')),
  client_id            UUID REFERENCES public.clients(id)     ON DELETE SET NULL,
  project_id           UUID REFERENCES public.ad_projects(id) ON DELETE SET NULL,
  campaign_type        TEXT,                          -- chosen Cirqle objective (reach/traffic/…)
  -- Bookkeeping
  raw                  JSONB,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ad_account_id, external_campaign_id)
);

CREATE INDEX IF NOT EXISTS ad_campaigns_account_status_idx
  ON public.ad_campaigns (ad_account_id, mapping_status);
CREATE INDEX IF NOT EXISTS ad_campaigns_project_idx
  ON public.ad_campaigns (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_campaigns_client_idx
  ON public.ad_campaigns (client_id) WHERE client_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_ad_campaigns_modtime ON public.ad_campaigns;
CREATE TRIGGER update_ad_campaigns_modtime
  BEFORE UPDATE ON public.ad_campaigns FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ── Row Level Security (house pattern: authenticated full; authz in actions) ─
ALTER TABLE public.ad_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_campaigns_authenticated_all ON public.ad_campaigns;
CREATE POLICY ad_campaigns_authenticated_all ON public.ad_campaigns
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Permission catalog: advertising.map_campaigns (exists in keys.ts, never
--    seeded). Add it so it is grantable per designation in Settings. ──────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('advertising', 'map_campaigns', 'advertising.map_campaigns', 'Map Campaigns',
    'Discover ad-account campaigns and assign each to a client, objective and project', 78)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key = 'advertising.map_campaigns'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
