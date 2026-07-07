-- ============================================================================
-- 022 — Workspace Manager + global Quick Actions backing data
-- A "workspace" is a saved UI context (sidebar scope + dashboard widget scope
-- + a default landing page) — e.g. "HR", "Accounts", "Marketing". Switching
-- workspaces ONLY changes navigation/UI, never permissions: every query that
-- filters by workspace does so on top of, never instead of, the existing
-- permission checks (hasPermission / RLS) already enforced everywhere else.
--
-- Requires: 001 (current_employee_id, current_employee_designation_has).
-- ============================================================================

-- ── is_current_employee_admin() — small helper, mirrors the is_admin check
--    already inlined in current_employee_designation_has(), extracted so
--    workspace policies don't need a dummy permission key to test adminness.
CREATE OR REPLACE FUNCTION is_current_employee_admin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM employees e
    JOIN designations d ON d.id = e.designation_id
    WHERE e.auth_id = auth.uid() AND e.is_archived = FALSE AND d.is_admin = TRUE
  )
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ── Workspaces ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  icon                 text NOT NULL DEFAULT 'LayoutGrid',   -- lucide icon name, curated list client-side
  color                text NOT NULL DEFAULT 'violet',       -- tailwind color token, curated list client-side
  -- NULL = unrestricted ("show everything the viewer already has permission
  -- for"). A real array = show ONLY these nav hrefs (still perm-filtered on
  -- top). Empty array is treated the same as NULL (defensive).
  sidebar_module_hrefs text[],
  dashboard_widget_keys text[],
  default_landing_href text NOT NULL DEFAULT '/dashboard',
  is_system            boolean NOT NULL DEFAULT false,       -- "All Workspace" — protected from delete/rename
  created_by           uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Who can SEE/switch into a workspace (admins bypass this — they see all).
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, employee_id)
);

-- Remembered per ACCOUNT (not per browser), per the spec.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS current_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;

ALTER TABLE workspaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspaces_select ON workspaces;
CREATE POLICY workspaces_select ON workspaces FOR SELECT
  USING (
    is_system                              -- "All Workspace" always visible
    OR is_current_employee_admin()         -- admins see every workspace
    OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = id AND wm.employee_id = current_employee_id())
  );

DROP POLICY IF EXISTS workspace_members_select ON workspace_members;
CREATE POLICY workspace_members_select ON workspace_members FOR SELECT
  USING (is_current_employee_admin() OR employee_id = current_employee_id());

-- All writes go through server actions (admin-gated there too) — same
-- REVOKE-based pattern as every other Connect table.
REVOKE INSERT, UPDATE, DELETE ON workspaces        FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON workspace_members FROM authenticated, anon;

-- Seed the one built-in, protected workspace.
INSERT INTO workspaces (name, icon, color, sidebar_module_hrefs, dashboard_widget_keys, default_landing_href, is_system)
SELECT 'All Workspace', 'LayoutGrid', 'slate', NULL, NULL, '/dashboard', true
WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE is_system = true);

-- ── Quick Actions: usage tracking (Frequent / Recent) ───────────────────────
-- One row per (employee, item). `count` powers Frequent, `last_used_at`
-- powers Recent. workspace_id is the workspace ACTIVE at the time of use —
-- lets Quick Actions prioritize items used within the current workspace
-- without needing a second tracking table.
CREATE TABLE IF NOT EXISTS item_usage (
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  item_key      text NOT NULL,           -- stable id, e.g. 'nav:/dashboard/invoices' or 'action:new-invoice'
  item_type     text NOT NULL DEFAULT 'nav',
  label         text NOT NULL,           -- denormalized so the list renders with no joins
  href          text NOT NULL,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  count         int NOT NULL DEFAULT 1,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_item_usage_recent ON item_usage (employee_id, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_usage_freq   ON item_usage (employee_id, count DESC);

ALTER TABLE item_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS item_usage_owner_only ON item_usage;
CREATE POLICY item_usage_owner_only ON item_usage FOR SELECT
  USING (employee_id = current_employee_id());   -- owner-only, no admin bypass — it's personal usage data
REVOKE INSERT, UPDATE, DELETE ON item_usage FROM authenticated, anon;

-- ── Quick Actions: manual favorites ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quick_action_favorites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  item_key     text NOT NULL,
  item_type    text NOT NULL DEFAULT 'nav',
  label        text NOT NULL,
  href         text NOT NULL,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_favorites_owner ON quick_action_favorites (employee_id, sort_order);

ALTER TABLE quick_action_favorites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_favorites_owner_only ON quick_action_favorites;
CREATE POLICY qa_favorites_owner_only ON quick_action_favorites FOR SELECT
  USING (employee_id = current_employee_id());
REVOKE INSERT, UPDATE, DELETE ON quick_action_favorites FROM authenticated, anon;

-- ── Permission key: who besides admins can manage workspaces ────────────────
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('workspaces', 'manage',
    'workspaces.manage', 'Manage workspaces',
    'Create, edit, and assign Workspace Manager workspaces', 111)
ON CONFLICT (key) DO NOTHING;
