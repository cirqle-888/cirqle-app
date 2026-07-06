-- ============================================================================
-- 017 — Reusable approval engine (Cirqle Connect Wave B)
-- One polymorphic engine for designs, invoices, quotations, expenses, task
-- completions, files, campaigns… Design: docs/cirqle-connect/DATABASE_SCHEMA.md §2
-- Requires: 014 (timeline), 015 (chat — approval cards + is_conversation_member()).
-- ============================================================================

CREATE TABLE IF NOT EXISTS approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What is being approved (polymorphic; entity_id as text = works for any table)
  entity_type    text NOT NULL,   -- invoice|quotation|task_completion|expense|file|campaign|design|attachment|other
  entity_id      text,
  title          text NOT NULL,
  description    text,
  -- Who decides: exactly one of the three rules
  approver_employee_id    uuid REFERENCES employees(id)    ON DELETE SET NULL,
  approver_designation_id uuid REFERENCES designations(id) ON DELETE SET NULL,
  approver_permission     text,
  -- State machine
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','changes_requested','cancelled')),
  step           int NOT NULL DEFAULT 1,        -- reserved for v2 sequential chains
  -- Context (denormalized, mirrors activity_logs scope columns)
  client_id      uuid REFERENCES clients(id)       ON DELETE SET NULL,
  project_id     uuid REFERENCES ad_projects(id)   ON DELETE SET NULL,
  task_id        uuid REFERENCES tasks(id)         ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id     uuid REFERENCES messages(id)      ON DELETE SET NULL,   -- the chat card
  requested_by   uuid NOT NULL REFERENCES employees(id),
  decided_by     uuid REFERENCES employees(id),
  decided_at     timestamptz,
  due_at         timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending   ON approvals (status, approver_employee_id, approver_designation_id);
CREATE INDEX IF NOT EXISTS idx_approvals_entity    ON approvals (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_approvals_requester ON approvals (requested_by, created_at DESC);

-- Append-only history. NEVER updated, NEVER deleted — immutability enforced
-- by the ABSENCE of update/delete policies + explicit REVOKE below.
CREATE TABLE IF NOT EXISTS approval_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id   uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  actor_id      uuid REFERENCES employees(id),
  event         text NOT NULL CHECK (event IN
                ('requested','approved','rejected','changes_requested','commented','version_added','cancelled','reopened')),
  comment       text,
  attachment_id uuid REFERENCES message_attachments(id) ON DELETE SET NULL,
  version_no    int,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_events ON approval_events (approval_id, created_at);

-- ── RLS: reads for involved parties; ALL writes server-action-only ──────────
ALTER TABLE approvals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approvals_select ON approvals;
CREATE POLICY approvals_select ON approvals FOR SELECT
  USING (
    requested_by = current_employee_id()
    OR approver_employee_id = current_employee_id()
    OR (approver_designation_id IS NOT NULL AND approver_designation_id =
        (SELECT designation_id FROM employees WHERE id = current_employee_id()))
    OR (conversation_id IS NOT NULL AND is_conversation_member(conversation_id))
  );

DROP POLICY IF EXISTS approval_events_select ON approval_events;
CREATE POLICY approval_events_select ON approval_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM approvals a WHERE a.id = approval_id));
  -- (the approvals_select policy already gates which approval rows resolve)

REVOKE INSERT, UPDATE, DELETE ON approvals       FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON approval_events FROM authenticated, anon;

-- ── Permission keys ──────────────────────────────────────────────────────────
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('approvals', 'request',
    'approvals.request', 'Request approvals',
    'Create approval requests on invoices, quotations, tasks, expenses and files', 99),
  ('approvals', 'decide_all',
    'approvals.decide_all', 'Decide any approval',
    'Approve or reject any approval request regardless of the assigned approver', 100)
ON CONFLICT (key) DO NOTHING;
