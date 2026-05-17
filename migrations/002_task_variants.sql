-- ────────────────────────────────────────────────────────────────────────────
-- Migration 002: Task variants (revisions / concepts / size variants)
-- ────────────────────────────────────────────────────────────────────────────
-- Extends existing tables only — no new tables, no new top-level features.
-- Pricing Matrix remains the single source of truth for client-specific
-- pricing; variant overrides ride along as JSONB columns on existing rows.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Tasks: variant linkage + billing mode + override flags
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_task_id    UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_type      TEXT CHECK (variant_type IN ('revision','concept','size')),
  ADD COLUMN IF NOT EXISTS variant_label     TEXT,
  ADD COLUMN IF NOT EXISTS billing_mode      TEXT NOT NULL DEFAULT 'fixed'
                                              CHECK (billing_mode IN ('fixed','percent_of_parent','parameter_driven')),
  ADD COLUMN IF NOT EXISTS billing_percent   NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS billing_override  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_billable       BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

-- 2. Services: global default variant pricing per service
--    Shape: { "sizes": {"Story":50,"Banner":50,"TV":60}, "concepts": {"default":100} }
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS default_variant_pricing JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. Pricing Matrix: per-client overrides for variant + parameter rates
--    variant_pricing shape:     { "sizes": {"Banner":55}, "concepts": {"default":100} }
--    parameter_overrides shape: { "<parameter_uuid>": 6, "<parameter_uuid>": 3 }  (percent values)
ALTER TABLE client_service_pricing
  ADD COLUMN IF NOT EXISTS variant_pricing     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS parameter_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
