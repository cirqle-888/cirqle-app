-- ============================================================================
-- 021 — Cirqle Connect Wave 2 (polish + workspace + push + chains)
-- Covers four independent features; each block is self-contained and idempotent
-- so partial re-runs are safe.
--   A) message_plays      — voice "played" receipts (WhatsApp blue mic)
--   B) push_subscriptions — Web Push (VAPID) device endpoints
--   C) workspace_items    — Personal Workspace (owner-only, NO admin bypass)
--   D) approval_steps     — sequential multi-step approval chains
-- Requires: 015 (chat — current_employee_id()), 017 (approvals).
-- ============================================================================

-- ── A) Voice played receipts ────────────────────────────────────────────────
-- Distinct from message_reads (018): "read" = saw the message row; "played" =
-- actually listened to a voice note. Sender-visible only (enforced in the
-- server action's read path, same as read receipts).
CREATE TABLE IF NOT EXISTS message_plays (
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  played_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_message_plays_msg ON message_plays (message_id);

ALTER TABLE message_plays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_plays_select ON message_plays;
CREATE POLICY message_plays_select ON message_plays FOR SELECT
  USING (is_conversation_member(conversation_id));
REVOKE INSERT, UPDATE, DELETE ON message_plays FROM authenticated, anon;

-- Realtime so the sender's "played" tick lights up live.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'message_plays'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE message_plays;
  END IF;
END $$;

-- ── B) Web Push subscriptions ───────────────────────────────────────────────
-- One row per browser/device endpoint. Owner-only; writes server-action only.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_push_subs_emp ON push_subscriptions (employee_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_subs_select ON push_subscriptions;
CREATE POLICY push_subs_select ON push_subscriptions FOR SELECT
  USING (employee_id = current_employee_id());
REVOKE INSERT, UPDATE, DELETE ON push_subscriptions FROM authenticated, anon;

-- ── C) Personal Workspace ───────────────────────────────────────────────────
-- Private per-employee items: todos, saved messages, pins, notes, reminders.
-- CRITICAL: owner-only, NO admin bypass — this is the user's private space.
CREATE TABLE IF NOT EXISTS workspace_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'todo'
                CHECK (kind IN ('todo','note','saved_message','pin','reminder')),
  title         text NOT NULL,
  body          text,
  -- Planner buckets: due_date drives Today / Tomorrow / This week.
  due_date      date,
  remind_at     timestamptz,
  reminded_at   timestamptz,          -- set by the daily cron once fired
  is_done       boolean NOT NULL DEFAULT false,
  done_at       timestamptz,
  -- Optional back-reference to whatever the item was created from.
  ref_type      text,                 -- message|task|invoice|client|conversation…
  ref_id        text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_owner ON workspace_items (employee_id, is_done, due_date);
CREATE INDEX IF NOT EXISTS idx_workspace_remind ON workspace_items (remind_at)
  WHERE remind_at IS NOT NULL AND reminded_at IS NULL;

ALTER TABLE workspace_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_owner_only ON workspace_items;
CREATE POLICY workspace_owner_only ON workspace_items FOR SELECT
  USING (employee_id = current_employee_id());   -- no admin bypass, by design
REVOKE INSERT, UPDATE, DELETE ON workspace_items FROM authenticated, anon;

-- ── D) Sequential approval chains ───────────────────────────────────────────
-- Optional ordered steps for one approval. When present, decideApproval
-- advances step-by-step (approvals.step already exists from 017) and only
-- finalizes the parent on the LAST step's approval. A rejection at any step
-- rejects the whole request. Approvals WITHOUT steps behave exactly as today.
CREATE TABLE IF NOT EXISTS approval_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id   uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  step_no       int NOT NULL,                     -- 1-based, matches approvals.step
  approver_employee_id    uuid REFERENCES employees(id)    ON DELETE SET NULL,
  approver_designation_id uuid REFERENCES designations(id) ON DELETE SET NULL,
  approver_permission     text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','changes_requested','skipped')),
  decided_by    uuid REFERENCES employees(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id, step_no)
);
CREATE INDEX IF NOT EXISTS idx_approval_steps ON approval_steps (approval_id, step_no);

ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_steps_select ON approval_steps;
CREATE POLICY approval_steps_select ON approval_steps FOR SELECT
  USING (EXISTS (SELECT 1 FROM approvals a WHERE a.id = approval_id));
REVOKE INSERT, UPDATE, DELETE ON approval_steps FROM authenticated, anon;

-- ── Permission keys ──────────────────────────────────────────────────────────
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('workspace', 'access',
    'workspace.access', 'Personal workspace',
    'Use the private personal workspace (todos, saved messages, reminders)', 110)
ON CONFLICT (key) DO NOTHING;
