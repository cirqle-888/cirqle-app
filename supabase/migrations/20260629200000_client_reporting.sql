-- =============================================================================
-- PHASE R1: Client Reporting System — Database Foundation
-- =============================================================================
-- Creates:
--   1. client_branding          — per-client brand / white-label config
--   2. ad_reports               — generated report records
--   3. ad_report_schedules      — automated delivery schedules
--   4. ad_report_analytics      — report event tracking (append-only)
--   5. Storage bucket           — ad-reports (private)
--   6. Indexes + RLS policies
--
-- Conventions followed:
--   • FK: uses clients(id) — consistent with all existing ad_* tables
--   • RLS: DROP POLICY IF EXISTS before CREATE POLICY (idempotent)
--   • Triggers: DROP TRIGGER IF EXISTS before CREATE OR REPLACE TRIGGER (idempotent)
--   • FK schedule_id inline in ad_reports (no ALTER TABLE needed)
--   • Storage bucket: (id, name, public) only — matches product-images pattern
--   • No storage.objects RLS — admin client bypasses RLS (same as product-images)
--   • All tables: IF NOT EXISTS guards
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions (already present; included defensively)
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. client_branding
--    One row per client. Resolves the brand config for every report.
--    white_label_mode controls whose logo / name appears on the output.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.client_branding (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  client_id               UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,

  -- Identity
  agency_name             TEXT,                    -- e.g. "Marketing Cirqle"
  client_name             TEXT,                    -- e.g. "MEZZA Royal Food Products"

  -- Brand colours (hex strings, e.g. "#7C3AED")
  primary_color           TEXT NOT NULL DEFAULT '#7C3AED',
  secondary_color         TEXT NOT NULL DEFAULT '#A78BFA',
  accent_color            TEXT NOT NULL DEFAULT '#F59E0B',

  -- Logos (Supabase Storage public URLs or external CDN URLs)
  logo_url                TEXT,                    -- client logo
  agency_logo_url         TEXT,                    -- agency / Cirqle logo

  -- Contact footer
  contact_phone           TEXT,
  contact_email           TEXT,
  contact_website         TEXT,
  footer_text             TEXT,                    -- overrides default footer copy

  -- White-label mode
  --   'cirqle'  → show Cirqle branding (default)
  --   'client'  → show client branding only
  --   'agency'  → show agency branding only
  white_label_mode        TEXT NOT NULL DEFAULT 'cirqle'
    CONSTRAINT client_branding_wl_mode_check
    CHECK (white_label_mode IN ('cirqle', 'client', 'agency')),

  -- Options
  confidential_watermark  BOOLEAN NOT NULL DEFAULT false,
  show_powered_by         BOOLEAN NOT NULL DEFAULT true,

  -- Extensible: language, currency overrides, custom fonts, themes, etc.
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT client_branding_client_unique UNIQUE (client_id)
);

CREATE INDEX IF NOT EXISTS idx_client_branding_client
  ON public.client_branding (client_id);

COMMENT ON TABLE public.client_branding IS
  'Per-client brand configuration for report white-labelling. One row per client.';

-- ---------------------------------------------------------------------------
-- 2. ad_report_schedules
--    Created BEFORE ad_reports so the FK can reference it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ad_report_schedules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id          UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  client_id           UUID NOT NULL REFERENCES public.clients(id)     ON DELETE CASCADE,

  -- Schedule definition
  frequency           TEXT NOT NULL DEFAULT 'weekly'
    CONSTRAINT ad_report_schedules_freq_check
    CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom')),

  -- Optional cron override (e.g. "0 9 * * 1" = every Monday 9 AM UTC)
  -- When set, takes precedence over `frequency`.
  cron_expression     TEXT,

  -- Hour of day to deliver (UTC, 0–23)
  delivery_hour       SMALLINT NOT NULL DEFAULT 7
    CONSTRAINT ad_report_schedules_hour_check
    CHECK (delivery_hour BETWEEN 0 AND 23),

  delivery_timezone   TEXT NOT NULL DEFAULT 'UTC',

  -- Report config
  report_type         TEXT NOT NULL DEFAULT 'weekly'
    CONSTRAINT ad_report_schedules_rtype_check
    CHECK (report_type IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom')),

  template            TEXT NOT NULL DEFAULT 'performance'
    CONSTRAINT ad_report_schedules_tmpl_check
    CHECK (template IN ('executive', 'marketing', 'lead_gen', 'ecommerce', 'performance', 'agency')),

  -- Which formats to generate: ["pdf"], ["pdf","xlsx"], ["pdf","image_portrait"] etc.
  formats             JSONB NOT NULL DEFAULT '["pdf"]'::jsonb,

  -- Whether to include comparison to previous period
  include_comparison  BOOLEAN NOT NULL DEFAULT true,

  -- Delivery recipients: [{email, name, language}]
  recipients          JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Lifecycle
  is_active           BOOLEAN NOT NULL DEFAULT true,
  last_run_at         TIMESTAMPTZ,
  next_run_at         TIMESTAMPTZ,

  -- Audit
  created_by          UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_report_schedules_project
  ON public.ad_report_schedules (project_id);

-- Cron query index: find all active schedules due to run
CREATE INDEX IF NOT EXISTS idx_ad_report_schedules_next_run
  ON public.ad_report_schedules (next_run_at)
  WHERE is_active = true;

COMMENT ON TABLE public.ad_report_schedules IS
  'Automated report delivery schedules. Polled by /api/cron/report-scheduler.';

-- ---------------------------------------------------------------------------
-- 3. ad_reports
--    One row per generated report. Stores output URLs and cached RenderData
--    so re-exporting any format never re-fetches DB or re-calls AI.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ad_reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id          UUID NOT NULL REFERENCES public.ad_projects(id) ON DELETE CASCADE,
  client_id           UUID NOT NULL REFERENCES public.clients(id)     ON DELETE CASCADE,

  -- What kind of report
  report_type         TEXT NOT NULL DEFAULT 'custom'
    CONSTRAINT ad_reports_type_check
    CHECK (report_type IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom')),

  template            TEXT NOT NULL DEFAULT 'performance'
    CONSTRAINT ad_reports_template_check
    CHECK (template IN ('executive', 'marketing', 'lead_gen', 'ecommerce', 'performance', 'agency')),

  -- Date range covered by the report
  date_from           DATE NOT NULL,
  date_to             DATE NOT NULL,
  CONSTRAINT ad_reports_date_range_check CHECK (date_from <= date_to),

  -- Optional comparison period (previous week / month / custom)
  comparison_from     DATE,
  comparison_to       DATE,

  -- Generation lifecycle
  status              TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ad_reports_status_check
    CHECK (status IN ('pending', 'generating', 'ready', 'failed')),

  error_message       TEXT,
  generation_time_ms  INTEGER,
  generation_cost     NUMERIC(10, 6),              -- AI token cost (USD)

  -- Output file URLs (Supabase Storage signed URLs)
  pdf_url             TEXT,
  xlsx_url            TEXT,
  csv_url             TEXT,
  image_url_portrait  TEXT,                        -- 1080×1920 PNG
  image_url_square    TEXT,                        -- 1080×1080 PNG

  -- Cached payloads (prevents re-fetching on re-export)
  render_data         JSONB,                       -- full RenderData snapshot
  ai_narrative        JSONB,                       -- structured AI report sections

  -- Audit
  generated_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  schedule_id         UUID REFERENCES public.ad_report_schedules(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ad_reports_project
  ON public.ad_reports (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_reports_client
  ON public.ad_reports (client_id, created_at DESC);

-- Fast lookup for UI: "show me pending/generating reports"
CREATE INDEX IF NOT EXISTS idx_ad_reports_status
  ON public.ad_reports (status)
  WHERE status IN ('pending', 'generating');

COMMENT ON TABLE public.ad_reports IS
  'Generated report records. Stores output file URLs and cached RenderData for all export formats.';

-- ---------------------------------------------------------------------------
-- 4. ad_report_analytics
--    Append-only event log: view, download, share, email delivery.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ad_report_analytics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  report_id       UUID NOT NULL REFERENCES public.ad_reports(id) ON DELETE CASCADE,

  event           TEXT NOT NULL
    CONSTRAINT ad_report_analytics_event_check
    CHECK (event IN (
      'generated', 'viewed', 'downloaded', 'shared',
      'email_delivered', 'email_failed', 'whatsapp_sent'
    )),

  format          TEXT,                            -- 'pdf', 'xlsx', 'csv', 'image_portrait', etc.
  user_id         UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  recipient_email TEXT,                            -- for email_delivered / email_failed events

  -- Extensible: device, IP, referrer, etc.
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_report_analytics_report
  ON public.ad_report_analytics (report_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_report_analytics_event
  ON public.ad_report_analytics (event, occurred_at DESC);

COMMENT ON TABLE public.ad_report_analytics IS
  'Immutable event log for report lifecycle: generation, views, downloads, email delivery.';

-- ---------------------------------------------------------------------------
-- 5. Storage bucket
--    Private bucket — files accessed via time-limited signed URLs.
--    No storage.objects RLS needed: all writes use the service-role admin
--    client (same pattern as the product-images bucket).
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('ad-reports', 'ad-reports', false)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security
--    Pattern: DROP IF EXISTS then CREATE — idempotent on re-run.
--    Convention from phase3_allocations.sql and advertising_module.sql.
-- ---------------------------------------------------------------------------

ALTER TABLE public.client_branding      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_reports           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_report_schedules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_report_analytics  ENABLE ROW LEVEL SECURITY;

-- client_branding
DROP POLICY IF EXISTS "client_branding_authenticated_all" ON public.client_branding;
CREATE POLICY "client_branding_authenticated_all"
  ON public.client_branding FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ad_reports
DROP POLICY IF EXISTS "ad_reports_authenticated_all" ON public.ad_reports;
CREATE POLICY "ad_reports_authenticated_all"
  ON public.ad_reports FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ad_report_schedules
DROP POLICY IF EXISTS "ad_report_schedules_authenticated_all" ON public.ad_report_schedules;
CREATE POLICY "ad_report_schedules_authenticated_all"
  ON public.ad_report_schedules FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ad_report_analytics (authenticated users may SELECT and INSERT; no UPDATE/DELETE)
DROP POLICY IF EXISTS "ad_report_analytics_authenticated_read" ON public.ad_report_analytics;
CREATE POLICY "ad_report_analytics_authenticated_read"
  ON public.ad_report_analytics FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "ad_report_analytics_authenticated_insert" ON public.ad_report_analytics;
CREATE POLICY "ad_report_analytics_authenticated_insert"
  ON public.ad_report_analytics FOR INSERT TO authenticated
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 7. updated_at triggers
--    update_updated_at() exists in the live DB (used by system_jobs, etc.).
--    DROP IF EXISTS guards make this idempotent.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS update_client_branding_modtime ON public.client_branding;
CREATE OR REPLACE TRIGGER update_client_branding_modtime
  BEFORE UPDATE ON public.client_branding
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_ad_report_schedules_modtime ON public.ad_report_schedules;
CREATE OR REPLACE TRIGGER update_ad_report_schedules_modtime
  BEFORE UPDATE ON public.ad_report_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- (ad_reports and ad_report_analytics have no updated_at column intentionally:
--  reports are status-transitioned only; analytics is append-only.)
