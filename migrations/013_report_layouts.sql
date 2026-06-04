-- ────────────────────────────────────────────────────────────────────────────
-- Migration 013: Report layouts (user + system-default column configurations)
-- ────────────────────────────────────────────────────────────────────────────
-- Lets users save personal column layouts (order / visibility / frozen /
-- grouping / sort) and lets admins set a company-wide system default — all
-- from the UI, with no code changes or deploys. layout_json is free-form so
-- new layout settings can be added later without a schema migration.
--
--   Personal layout : user_id = <employee id>, is_system_default = false
--   System default  : user_id = NULL,          is_system_default = true
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS report_layouts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID REFERENCES employees(id) ON DELETE CASCADE,
  report_name       TEXT NOT NULL,
  layout_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_system_default BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- One personal layout per (user, report).
CREATE UNIQUE INDEX IF NOT EXISTS report_layouts_user_report_key
  ON report_layouts (user_id, report_name)
  WHERE user_id IS NOT NULL;

-- Exactly one system default per report.
CREATE UNIQUE INDEX IF NOT EXISTS report_layouts_system_report_key
  ON report_layouts (report_name)
  WHERE user_id IS NULL AND is_system_default = true;

-- Fast lookup by report.
CREATE INDEX IF NOT EXISTS report_layouts_report_idx ON report_layouts (report_name);

-- All access is mediated by server actions using the service-role client, which
-- bypasses RLS. Enabling RLS with no policies denies the anon/auth keys by
-- default, so the table can never be read or written directly from the browser.
ALTER TABLE report_layouts ENABLE ROW LEVEL SECURITY;

-- Force PostgREST to refresh its schema cache so the API sees the new table.
NOTIFY pgrst, 'reload schema';
