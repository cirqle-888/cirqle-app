-- ============================================================================
-- Field Marketing — territory map, physical prospects & visit tracking
-- ============================================================================
-- Direct / door-to-door marketing: reps physically visit supermarkets, shops
-- and business centres. This is NOT the Meta-lead-ads CRM (public.leads, which
-- is client-scoped and has no geography) — it is a standalone module whose
-- prospects live ON A MAP and move through their own pipeline, and which
-- CONVERTS a place into a real client when it agrees.
--
--   field_places          — the physical prospect (lat/lng + pipeline)
--   field_place_contacts  — one row per contact/phone number collected
--   field_visits          — the visit log (drives "already covered" + follow-up)
--   field_territories     — simple named areas for team coverage
--
-- Follows the house pattern of 20260812123000_leads_crm.sql:
--   RLS `FOR SELECT TO authenticated`, update_updated_at trigger,
--   permission-catalog INSERT + admin designation grant. Idempotent.
--   Reads are server-side (createAdminClient bypasses RLS/grants), so these
--   tables deliberately do NOT join the browser `authenticated` GRANT keep-list.
-- ============================================================================

BEGIN;

-- ── Territories (named areas; polygon boundary deferred to a later phase) ─────
CREATE TABLE IF NOT EXISTS public.field_territories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#6366f1',       -- pin/label tint
  assigned_to  UUID REFERENCES public.employees(id) ON DELETE SET NULL,  -- owning rep
  geojson      JSONB,                                  -- optional polygon boundary
  created_by   UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_field_territories_modtime ON public.field_territories;
CREATE OR REPLACE TRIGGER update_field_territories_modtime
  BEFORE UPDATE ON public.field_territories FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.field_territories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_territories_read ON public.field_territories;
CREATE POLICY field_territories_read ON public.field_territories
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Places — a physical business plotted on the map ──────────────────────────
CREATE TABLE IF NOT EXISTS public.field_places (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL DEFAULT 'shop'
    CHECK (category IN ('supermarket','shop','business_centre','restaurant','pharmacy','salon','office','other')),
  status               TEXT NOT NULL DEFAULT 'not_visited'
    CHECK (status IN ('not_visited','visited','interested','negotiating','converted','not_interested','revisit')),
  likelihood           TEXT
    CHECK (likelihood IN ('hot','warm','cold')),        -- conversion chance; NULL = unset
  -- Geography (required — a place with no coordinates can't sit on the map)
  latitude             DOUBLE PRECISION NOT NULL,
  longitude            DOUBLE PRECISION NOT NULL,
  address              TEXT,
  area                 TEXT,                             -- locality / neighbourhood
  google_place_id      TEXT,                             -- reserved: future Google Places link
  -- Workflow
  assigned_to          UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  territory_id         UUID REFERENCES public.field_territories(id) ON DELETE SET NULL,
  last_visit_at        TIMESTAMPTZ,
  next_followup_at     TIMESTAMPTZ,
  notes                TEXT,
  -- Conversion linkage (set when the place becomes a real account)
  converted_client_id  UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  converted_lead_id    UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  created_by           UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS field_places_status_idx    ON public.field_places (status);
CREATE INDEX IF NOT EXISTS field_places_assigned_idx  ON public.field_places (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS field_places_territory_idx ON public.field_places (territory_id) WHERE territory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS field_places_followup_idx  ON public.field_places (next_followup_at) WHERE next_followup_at IS NOT NULL;
-- Bounding-box scans for the "any place within ~50 m?" duplicate check.
CREATE INDEX IF NOT EXISTS field_places_latlng_idx    ON public.field_places (latitude, longitude);

DROP TRIGGER IF EXISTS update_field_places_modtime ON public.field_places;
CREATE OR REPLACE TRIGGER update_field_places_modtime
  BEFORE UPDATE ON public.field_places FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.field_places ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_places_read ON public.field_places;
CREATE POLICY field_places_read ON public.field_places
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Contacts — many people / phone numbers per place ─────────────────────────
CREATE TABLE IF NOT EXISTS public.field_place_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id    UUID NOT NULL REFERENCES public.field_places(id) ON DELETE CASCADE,
  name        TEXT,
  role        TEXT,                                     -- e.g. "Owner", "Manager"
  phone       TEXT,
  email       TEXT,
  notes       TEXT,
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS field_contacts_place_idx ON public.field_place_contacts (place_id, created_at);

ALTER TABLE public.field_place_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_contacts_read ON public.field_place_contacts;
CREATE POLICY field_contacts_read ON public.field_place_contacts
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Visits — the coverage log ("who has already been here, when, outcome") ───
CREATE TABLE IF NOT EXISTS public.field_visits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id          UUID NOT NULL REFERENCES public.field_places(id) ON DELETE CASCADE,
  visited_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  visited_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome           TEXT,                               -- the status recorded at the visit
  notes             TEXT,
  -- Where the rep actually stood (proof of visit); may differ from the place pin.
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  next_followup_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS field_visits_place_idx ON public.field_visits (place_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS field_visits_rep_idx   ON public.field_visits (visited_by, visited_at DESC) WHERE visited_by IS NOT NULL;

ALTER TABLE public.field_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_visits_read ON public.field_visits;
CREATE POLICY field_visits_read ON public.field_visits
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Permission catalog ───────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('field', 'view',   'field.view',   'View Field Marketing',
    'Open the Field Marketing module: the territory map, place list and visit history', 97),
  ('field', 'manage', 'field.manage', 'Manage Field Marketing',
    'Add/edit places, log visits, change status, assign reps, manage territories and convert places to clients', 98)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('field.view','field.manage')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
