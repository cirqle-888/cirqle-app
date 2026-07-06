-- ============================================================================
-- 015 — Chat module Phase 1 (Cirqle Connect)
-- Conversations, members, messages, reactions, attachments.
-- Design: CHAT_MODULE_PLAN.md §4–5, docs/cirqle-connect/*.
--
-- Realtime: browsers subscribe directly to Supabase Realtime with the anon
-- key + the user's session; RLS below is what authorizes which rows they
-- receive. `messages` is added to the realtime publication at the bottom.
-- ============================================================================

-- ── Helper: current employee id from the auth session ───────────────────────
CREATE OR REPLACE FUNCTION current_employee_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM employees WHERE auth_id = auth.uid() LIMIT 1
$$;

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('channel','dm','group','project','task','client')),
  name        text,                      -- null for DMs (derived from members)
  topic       text,
  is_private  boolean NOT NULL DEFAULT false,
  -- CRM links (used by type='project'|'task'|'client'; Phase 3 wires these)
  project_id  uuid REFERENCES ad_projects(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES tasks(id)       ON DELETE CASCADE,
  client_id   uuid REFERENCES clients(id)     ON DELETE CASCADE,
  portal_token text,
  created_by  uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations (type, archived_at);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id)     ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member')),
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  notify_level    text NOT NULL DEFAULT 'all' CHECK (notify_level IN ('all','mentions','none')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_employee ON conversation_members (employee_id);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES employees(id) ON DELETE SET NULL, -- null = client/system
  sender_portal   text,                                             -- portal token for client senders
  parent_id       uuid REFERENCES messages(id) ON DELETE CASCADE,   -- threads (Phase 2)
  body            text NOT NULL DEFAULT '',
  kind            text NOT NULL DEFAULT 'text'
                  CHECK (kind IN ('text','file','system','voice','ai','approval')),
  metadata        jsonb NOT NULL DEFAULT '{}',
  edited_at       timestamptz,
  deleted_at      timestamptz,                                      -- soft delete
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- FTS over body + (future) voice transcript — Wave C reuses this column
  body_search     tsvector GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(body,'') || ' ' || coalesce(metadata->>'transcript',''))
                  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING gin (body_search);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  uuid NOT NULL REFERENCES messages(id)  ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, employee_id, emoji)
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  file_name    text NOT NULL,
  mime_type    text,
  size_bytes   bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON message_attachments (message_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Writes go through server actions (service role bypasses RLS). The policies
-- below authorize READS — including which realtime events each browser gets.

ALTER TABLE conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments  ENABLE ROW LEVEL SECURITY;

-- Membership check used by every policy (fast: PK lookup)
CREATE OR REPLACE FUNCTION is_conversation_member(conv_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversation_members
    WHERE conversation_id = conv_id AND employee_id = current_employee_id()
  )
$$;

-- Conversations: members see theirs; non-private channels visible to all staff
DROP POLICY IF EXISTS conv_select ON conversations;
CREATE POLICY conv_select ON conversations FOR SELECT
  USING (
    is_conversation_member(id)
    OR (type = 'channel' AND is_private = false AND auth.uid() IS NOT NULL)
  );

DROP POLICY IF EXISTS conv_members_select ON conversation_members;
CREATE POLICY conv_members_select ON conversation_members FOR SELECT
  USING (is_conversation_member(conversation_id));

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT
  USING (is_conversation_member(conversation_id));

DROP POLICY IF EXISTS reactions_select ON message_reactions;
CREATE POLICY reactions_select ON message_reactions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_id AND is_conversation_member(m.conversation_id)
  ));

DROP POLICY IF EXISTS attachments_select ON message_attachments;
CREATE POLICY attachments_select ON message_attachments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_id AND is_conversation_member(m.conversation_id)
  ));

-- No INSERT/UPDATE/DELETE policies for authenticated: all writes are
-- server-action-only (service role). This is deliberate.

-- ── Realtime ─────────────────────────────────────────────────────────────────
-- Add messages to the realtime publication so postgres_changes events fire.
-- (Wrapped: harmless if already added.)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Permission keys (catalog pattern from 005) ───────────────────────────────
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('chat', 'access',
    'chat.access', 'Use team chat',
    'Open the Chat page, read and send messages in channels and DMs', 95),
  ('chat', 'create_channels',
    'chat.create_channels', 'Create channels',
    'Create new team channels and group conversations', 96),
  ('chat', 'moderate',
    'chat.moderate', 'Moderate chat',
    'Delete any message, manage members in any conversation', 97),
  ('chat', 'client_conversations',
    'chat.client_conversations', 'Client conversations',
    'Read and reply to client portal conversations', 98)
ON CONFLICT (key) DO NOTHING;

-- Link the timeline scope column now that conversations exists (from 014).
DO $$
BEGIN
  ALTER TABLE activity_logs
    ADD CONSTRAINT activity_logs_conversation_fk
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
