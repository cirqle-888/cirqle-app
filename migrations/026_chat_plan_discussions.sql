-- ============================================================================
-- 026 — Chat: social-plan discussion rooms, per-member hide, archivable rooms
-- ============================================================================

-- 1. Allow type='plan' + link column to social_calendars.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_type_check
  CHECK (type IN ('channel','dm','group','project','task','client','request','plan'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS plan_id uuid
  REFERENCES social_calendars(id) ON DELETE CASCADE;

-- 2. Per-member hide — the "delete chat" model for DMs.
--    Archiving a DM would be a GLOBAL delete: one participant could wipe the
--    other's access to shared correspondence (and their evidence of it). A DM
--    is therefore hidden per member instead; it returns to the sidebar as soon
--    as a newer message arrives, and the other side is never affected.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

-- 3. One LIVE discussion room per entity. The 019 indexes did not exclude
--    archived rows, so an archived entity room permanently blocked its own
--    re-creation: the insert hit a unique violation and the retry path handed
--    back the archived (sidebar-invisible) room — a zombie everyone could post
--    into but nobody could navigate to. Scope all of them to live rows.
DROP INDEX IF EXISTS uq_conv_task;
DROP INDEX IF EXISTS uq_conv_project;
DROP INDEX IF EXISTS uq_conv_request;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_task    ON conversations (task_id)    WHERE task_id    IS NOT NULL AND type = 'task'    AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_project ON conversations (project_id) WHERE project_id IS NOT NULL AND type = 'project' AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_request ON conversations (request_id) WHERE request_id IS NOT NULL AND type = 'request' AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_plan    ON conversations (plan_id)    WHERE plan_id    IS NOT NULL AND type = 'plan'    AND archived_at IS NULL;

-- 4. File entity discussions under their client in the sidebar. New rooms get
--    client_id stamped at creation; these backfill the ones already created.
UPDATE conversations c SET client_id = t.client_id
  FROM tasks t          WHERE c.task_id    = t.id AND c.type = 'task'    AND c.client_id IS NULL AND t.client_id IS NOT NULL;
UPDATE conversations c SET client_id = r.client_id
  FROM task_requests r  WHERE c.request_id = r.id AND c.type = 'request' AND c.client_id IS NULL AND r.client_id IS NOT NULL;
UPDATE conversations c SET client_id = p.client_id
  FROM ad_projects p    WHERE c.project_id = p.id AND c.type = 'project' AND c.client_id IS NULL AND p.client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_client ON conversations (client_id) WHERE client_id IS NOT NULL;
