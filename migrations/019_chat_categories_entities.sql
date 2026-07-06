-- ============================================================================
-- 019 — Chat: channel categories, request discussions, realtime reliability
-- ============================================================================

-- 1. Channel categories: general | department | client (grouped sidebar).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS category text;

-- 2. Request discussions: allow type='request' + link column.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_type_check
  CHECK (type IN ('channel','dm','group','project','task','client','request'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES task_requests(id) ON DELETE CASCADE;

-- One discussion room per entity (partial unique indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_task    ON conversations (task_id)    WHERE task_id    IS NOT NULL AND type = 'task';
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_project ON conversations (project_id) WHERE project_id IS NOT NULL AND type = 'project';
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_request ON conversations (request_id) WHERE request_id IS NOT NULL AND type = 'request';

-- 3. Realtime reliability: FULL replica identity so UPDATE events always
--    carry complete rows through RLS-authorized postgres_changes (fixes
--    approval-card / transcript / read-tick live updates in some setups).
ALTER TABLE messages      REPLICA IDENTITY FULL;
ALTER TABLE message_reads REPLICA IDENTITY FULL;
