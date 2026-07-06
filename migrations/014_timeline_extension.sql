-- ============================================================================
-- 014 — Universal Timeline extension (Cirqle Connect Wave A)
-- Extends activity_logs into the app-wide event backbone.
-- Design: docs/cirqle-connect/DATABASE_SCHEMA.md §1
--
-- Safe to run on a live database:
--   • purely additive (new nullable columns, new indexes, backfill UPDATE)
--   • existing logActivity() writers keep working unchanged
--   • app code tolerates this migration NOT being applied (graceful fallback)
-- ============================================================================

-- 1. Widen entity_type: the CHECK moves to code (same pattern as `action`).
ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;

-- 2. Category + scope columns (all nullable — old rows and writers stay valid).
--    conversation_id has NO foreign key yet: the conversations table arrives
--    with the chat module (CHAT_MODULE_PLAN.md Phase 1). Plain uuid until then.
ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS category        text,
  ADD COLUMN IF NOT EXISTS client_id       uuid REFERENCES clients(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_id      uuid REFERENCES ad_projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id         uuid REFERENCES tasks(id)       ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

-- 3. Scope indexes — each timeline tab is ONE index scan.
CREATE INDEX IF NOT EXISTS idx_activity_client   ON activity_logs (client_id,       created_at DESC) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_project  ON activity_logs (project_id,      created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_task     ON activity_logs (task_id,         created_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_conv     ON activity_logs (conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_category ON activity_logs (category,        created_at DESC);

-- 4. Backfill category for existing rows from entity_type.
UPDATE activity_logs SET category = CASE entity_type
  WHEN 'task'         THEN 'tasks'
  WHEN 'contribution' THEN 'tasks'
  WHEN 'score'        THEN 'tasks'
  WHEN 'invoice'      THEN 'billing'
  WHEN 'cashbook'     THEN 'finance'
  WHEN 'payroll'      THEN 'finance'
  WHEN 'employee'     THEN 'employees'
  ELSE 'crm' END
WHERE category IS NULL;

-- 5. Append-only hardening: nobody below service role may update/delete.
--    (activity_logs already has RLS from 010 with service-role-only writes;
--    this makes the append-only property explicit for the authenticated role.)
REVOKE UPDATE, DELETE ON activity_logs FROM authenticated;
REVOKE UPDATE, DELETE ON activity_logs FROM anon;

-- 6. New permission keys (same catalog/seeding pattern as migration 005).
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('timeline', 'view_all',
    'timeline.view_all',
    'View global activity feed',
    'See the company-wide activity timeline across all clients, projects and employees',
    90),
  ('timeline', 'view_finance',
    'timeline.view_finance',
    'View finance activities',
    'See billing and finance events (invoices, payments, expenses, payroll) on timelines',
    91)
ON CONFLICT (key) DO NOTHING;
