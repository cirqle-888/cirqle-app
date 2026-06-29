-- ============================================================================
-- Advertising Management Module — Phase 1 (Foundation Slice)
-- ============================================================================
-- Adds the advertising-specific tables and links them into the existing Cirqle
-- spine (clients, task_requests, tasks, contributions, invoices, permissions).
-- NOTHING here duplicates an existing entity — ad_* rows only carry advertising
-- data and reference existing rows.
--
-- All app code that reads these tables is written defensively (try/catch +
-- "migrated" flags), so the application keeps working normally until this file
-- is applied in the Supabase SQL editor.
--
-- Conventions match phase10_invoice_expense_items.sql / 20260610120000_request_portal.sql:
-- BEGIN/COMMIT, CREATE TABLE IF NOT EXISTS, gen_random_uuid() PKs, RLS with an
-- "authenticated all" policy, NUMERIC money + amount/amount_inr/currency, indexes.
-- ============================================================================

BEGIN;

-- ── 1. Advertising projects (core) ──────────────────────────────────────────
-- Budgets are 1:1 with the project, so they live as columns here rather than a
-- separate table (the two budgets the PRD describes: ad spend + service charge).
CREATE TABLE IF NOT EXISTS public.ad_projects (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Links into the existing spine (never duplicated).
  client_id            UUID REFERENCES public.clients(id)       ON DELETE SET NULL,
  request_id           UUID REFERENCES public.task_requests(id) ON DELETE SET NULL,
  -- General
  campaign_name        TEXT NOT NULL,
  platform             TEXT NOT NULL DEFAULT 'meta',   -- meta/google/instagram/facebook/linkedin/tiktok/youtube/x/snapchat/custom
  campaign_type        TEXT,                           -- awareness/reach/traffic/engagement/leads/messages/sales/conversion/remarketing/app_install/video_views
  status               TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','active','paused','completed','cancelled')),
  -- Budget 1: advertising spend (money spent inside the ad platform)
  ad_budget_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  ad_budget_currency   TEXT NOT NULL DEFAULT 'INR',
  -- Budget 2: agency service charge (fixed amount OR percent of ad spend)
  service_charge_type  TEXT NOT NULL DEFAULT 'fixed'
    CHECK (service_charge_type IN ('fixed','percent')),
  service_charge_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_percent          NUMERIC(6,3)  NOT NULL DEFAULT 0,
  -- Targeting / objective (project-level; per-asset detail lives in ad_assets)
  objective            TEXT,
  optimization_goal    TEXT,
  -- Timeline
  start_date           DATE,
  end_date             DATE,
  -- Bookkeeping
  notes                TEXT,
  created_by           UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ            -- soft delete (matches tasks)
);
CREATE INDEX IF NOT EXISTS ad_projects_client_idx  ON public.ad_projects (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_projects_status_idx  ON public.ad_projects (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ad_projects_request_idx ON public.ad_projects (request_id) WHERE request_id IS NOT NULL;

-- ── 2. Daily performance metrics (one row per project per day) ───────────────
-- Every PRD field is a nullable column so an employee can faithfully copy what
-- Meta/Google Ads Manager reports. Derived metrics (ctr/cpc/cpm/roas/…) are
-- computed in src/lib/advertising/metrics.ts when a column is left blank, so a
-- manually-entered value always wins.
CREATE TABLE IF NOT EXISTS public.ad_daily_metrics (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  metric_date         DATE NOT NULL,
  -- Money (in the project's ad currency)
  spend               NUMERIC(14,2),
  revenue             NUMERIC(14,2),
  cpc                 NUMERIC(14,4),
  cpm                 NUMERIC(14,4),
  cpr                 NUMERIC(14,4),   -- cost per result
  result_cost         NUMERIC(14,4),
  remaining_budget    NUMERIC(14,2),
  currency            TEXT NOT NULL DEFAULT 'INR',
  -- Counts
  reach               BIGINT,
  impressions         BIGINT,
  clicks              BIGINT,
  conversions         BIGINT,
  leads               BIGINT,
  messages            BIGINT,
  purchases           BIGINT,
  video_views         BIGINT,
  landing_page_views  BIGINT,
  adds_to_cart        BIGINT,
  checkouts           BIGINT,
  -- Ratios
  ctr                 NUMERIC(12,4),
  roas                NUMERIC(12,4),
  frequency           NUMERIC(12,4),
  -- Workflow
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft','submitted','approved')),
  entered_by          UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  approved_by         UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  approved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, metric_date)
);
CREATE INDEX IF NOT EXISTS ad_daily_metrics_project_idx ON public.ad_daily_metrics (project_id, metric_date DESC);

-- ── 3. Task link (reuse the existing tasks table; never duplicate it) ────────
CREATE TABLE IF NOT EXISTS public.ad_project_tasks (
  project_id  UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES public.tasks(id)       ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS ad_project_tasks_task_idx ON public.ad_project_tasks (task_id);

-- ── 4. Campaign assets (creatives + targeting) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'image'
    CHECK (kind IN ('image','video','text','carousel','other')),
  headline          TEXT,
  primary_text      TEXT,
  description        TEXT,
  cta               TEXT,
  destination_url   TEXT,
  utm               TEXT,
  media_url         TEXT,
  -- Targeting
  audience          TEXT,
  placement         TEXT,
  location          TEXT,
  age_range         TEXT,
  gender            TEXT,
  languages         TEXT,
  pixel             TEXT,
  conversion_event  TEXT,
  created_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ad_assets_project_idx ON public.ad_assets (project_id);

-- ── 5. Attachments (reuses Supabase storage like the product-images bucket) ──
CREATE TABLE IF NOT EXISTS public.ad_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  file_url     TEXT NOT NULL,
  file_name    TEXT,
  kind         TEXT,   -- creative/invoice/screenshot/csv/report/approval/contract/other
  uploaded_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ad_attachments_project_idx ON public.ad_attachments (project_id);

-- ── 6. Notes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  author_id   UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ad_notes_project_idx ON public.ad_notes (project_id, created_at DESC);

-- ── 7. Events / timeline / audit (folds History + Events + Audit for now) ────
CREATE TABLE IF NOT EXISTS public.ad_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  actor_id    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ad_events_project_idx ON public.ad_events (project_id, created_at DESC);

-- ── 8. Invoice ad-spend section (mirrors invoice_expense_items) ──────────────
-- Agency Services bill through the normal invoice_items; Advertising Spend bills
-- through this separate section (the "two sections" the PRD requires). Resynced
-- from the project budget so a budget change updates the invoice automatically.
CREATE TABLE IF NOT EXISTS public.invoice_ad_spend_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES public.invoices(id)    ON DELETE CASCADE,
  ad_project_id  UUID REFERENCES public.ad_projects(id)          ON DELETE SET NULL,
  description    TEXT NOT NULL DEFAULT '',
  amount         NUMERIC(14,2) NOT NULL DEFAULT 0,   -- in invoice currency
  amount_inr     NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'INR',
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_ad_spend_items_invoice_idx ON public.invoice_ad_spend_items (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_ad_spend_items_project_idx ON public.invoice_ad_spend_items (ad_project_id);

-- Additive link columns on invoices (never breaks existing rows).
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS ad_project_id  UUID REFERENCES public.ad_projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ad_spend_mode  TEXT NOT NULL DEFAULT 'separate';

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Matches the house pattern (phase10): authenticated users have full access;
-- fine-grained authorization is enforced in the server actions via the
-- permission guards, not in the database.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ad_projects','ad_daily_metrics','ad_project_tasks','ad_assets',
    'ad_attachments','ad_notes','ad_events','invoice_ad_spend_items'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_authenticated_all', t);
  END LOOP;
END $$;

-- ── Permissions catalog (granular keys; reuse designations, no role table) ───
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('advertising', 'view',           'advertising.view',           'View Advertising',
    'See the Advertising dashboard, campaigns and daily performance', 70),
  ('advertising', 'create',         'advertising.create',         'Create Advertising Projects',
    'Create new advertising campaigns / projects', 71),
  ('advertising', 'edit',           'advertising.edit',           'Edit Advertising Projects',
    'Edit campaign details, assets, status and timeline', 72),
  ('advertising', 'delete',         'advertising.delete',         'Delete Advertising Projects',
    'Soft-delete advertising campaigns', 73),
  ('advertising', 'manage_budget',  'advertising.manage_budget',  'Manage Advertising Budgets',
    'Set the ad spend budget and agency service charge, and sync invoices', 74),
  ('advertising', 'enter_metrics',  'advertising.enter_metrics',  'Enter Daily Metrics',
    'Add / edit daily performance entries for assigned campaigns', 75),
  ('advertising', 'approve_metrics','advertising.approve_metrics','Approve Daily Metrics',
    'Approve daily performance entries submitted by media buyers', 76),
  ('advertising', 'view_reports',   'advertising.view_reports',   'View Advertising Reports',
    'View and export campaign performance reports', 77)
ON CONFLICT (key) DO NOTHING;

-- Grant every advertising permission to admin designations (mirrors request portal).
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('advertising.view','advertising.create','advertising.edit','advertising.delete',
                 'advertising.manage_budget','advertising.enter_metrics','advertising.approve_metrics',
                 'advertising.view_reports')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
