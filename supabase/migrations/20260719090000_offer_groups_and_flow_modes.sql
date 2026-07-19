-- ─────────────────────────────────────────────────────────────────────────────
-- Offer groups, flow modes, and sheet-import campaigns.
--
-- WHY
-- Real client setups outgrew the one-campaign-one-sheet model in two ways:
--
--  1. A client's vegetables flyer is a SEPARATE Figma file fed by a SEPARATE
--     sheet (e.g. "BN Mart Vegetables" vs "BN MART JULY 2026"). offer_products
--     .page splits one list across artboards WITHIN one design; it cannot route
--     rows to a different file. client_offer_groups adds that missing axis.
--
--  2. Some clients maintain their OWN master sheet (tabs "Groceries",
--     "Vegetables") that feeds downstream sheets via IMPORTRANGE plus a photo
--     automation. Cirqle writing its 15-column layout there would destroy their
--     pipeline, so those clients get offer_flow_mode='pull': Cirqle reads their
--     sheet into read-only campaign snapshots and never writes back.
--
-- BACKWARD COMPATIBILITY
-- Every column added here is nullable or defaulted so existing rows are
-- untouched. A client with ZERO groups keeps the exact legacy code path, and
-- offer_flow_mode defaults to 'push'. No group is auto-created for anyone.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_offer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- Reserved for future nesting (Groceries → Rice / Oil / Spices). Nothing
  -- creates children yet; top-level queries filter parent_id IS NULL from day
  -- one so nesting can ship without revisiting them.
  parent_id uuid REFERENCES public.client_offer_groups(id) ON DELETE CASCADE,

  name text NOT NULL,
  slug text NOT NULL,

  -- ── Push destination ──────────────────────────────────────────────────────
  -- These stay typed columns rather than living in the jsonb below because the
  -- sync path depends on them: they need validation at write time and they are
  -- read on every save.
  sheet_url text,
  sheet_id text,              -- derived once via extractSheetId() when saved
  sheet_tab_name text,        -- target tab inside that spreadsheet
  apps_script_url text,       -- per-group script; falls back to client, then shared

  -- ── Pull source ───────────────────────────────────────────────────────────
  master_tab_name text,       -- tab to read inside clients.offer_master_sheet_url
  pull_schedule text NOT NULL DEFAULT 'manual'
    CHECK (pull_schedule IN ('manual', 'hourly', 'daily')),
  last_pulled_at timestamptz,

  -- Open-ended integrations that no code path depends on structurally, so new
  -- kinds need no migration:
  --   {"figma": {"file_url": "...", "file_key": "..."}, "canva": {...}}
  integrations jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- NULL = emit the default date columns. Reserved for the DATE_FORMATS
  -- registry in src/lib/offer-sheet.ts if a client ever needs a third style.
  date_format text,

  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_client_offer_groups_client
  ON public.client_offer_groups(client_id) WHERE is_active;

-- NULL group_id = the default/ungrouped bucket, which is what every existing
-- product is and what single-group clients keep using.
ALTER TABLE public.offer_products
  ADD COLUMN IF NOT EXISTS group_id uuid
  REFERENCES public.client_offer_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_offer_products_group
  ON public.offer_products(group_id) WHERE group_id IS NOT NULL;

ALTER TABLE public.clients
  -- push   = Cirqle writes the designer sheet (today's behaviour, the default)
  -- pull   = the client owns their sheet; Cirqle only reads it, never writes
  -- manual = no sync at all; the flyer is hand-built (e.g. Dezire Mobiles)
  ADD COLUMN IF NOT EXISTS offer_flow_mode text NOT NULL DEFAULT 'push'
    CHECK (offer_flow_mode IN ('push', 'pull', 'manual')),
  ADD COLUMN IF NOT EXISTS offer_master_sheet_url text,
  ADD COLUMN IF NOT EXISTS offer_master_sheet_id text,
  ADD COLUMN IF NOT EXISTS integrations jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 'sheet_import' campaigns are snapshots of a client-owned sheet. They are
-- read-only in Cirqle until explicitly converted, so a staff edit can never be
-- silently overwritten by the next pull.
ALTER TABLE public.offer_campaigns
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'cirqle'
    CHECK (source IN ('cirqle', 'sheet_import'));

-- ── Row Level Security (house pattern: authenticated full; authz in actions) ─
ALTER TABLE public.client_offer_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_offer_groups_authenticated_all ON public.client_offer_groups;
CREATE POLICY client_offer_groups_authenticated_all ON public.client_offer_groups
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
REVOKE ALL ON public.client_offer_groups FROM anon;

-- ── Permission catalog ───────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES (
  'offer', 'manage_groups', 'offer.manage_groups',
  'Manage offer categories',
  'Configure a client''s offer categories (Groceries, Vegetables, …), their Google Sheet destinations, Apps Script and Figma links, and switch a client between Push, Pull and Manual flow modes.',
  7
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
FROM public.designations d, public.permissions p
WHERE d.is_admin = TRUE AND p.key IN ('offer.manage_groups')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
