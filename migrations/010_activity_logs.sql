-- ============================================================
-- Migration 010: Activity Logs
-- ============================================================
-- Lightweight audit / activity timeline for the internal portal.
-- Logs are WRITE-ONLY from the app — nothing ever updates or deletes a row.
-- Fire-and-forget from server actions (non-blocking), so a log failure
-- never breaks the main operation.
--
-- Indexed for three common query shapes:
--   1. "all activity by employee X"     → idx_activity_actor
--   2. "activity about employee X"      → idx_activity_subject
--   3. "all activity on task/entity Y"  → idx_activity_entity
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_logs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who performed the action (null = system / scheduled job)
  actor_id     uuid        REFERENCES employees(id) ON DELETE SET NULL,
  -- The employee this activity is primarily ABOUT (null when not employee-specific)
  subject_id   uuid        REFERENCES employees(id) ON DELETE SET NULL,
  -- Entity the action was performed on
  entity_type  text        NOT NULL CHECK (entity_type IN (
                             'task', 'contribution', 'employee', 'payroll',
                             'invoice', 'cashbook', 'score', 'note'
                           )),
  entity_id    text,       -- uuid stored as text so it works for all entity types
  -- What happened
  action       text        NOT NULL,  -- e.g. 'created', 'edited', 'deleted', 'scored', 'note'
  -- Optional structured diff: [{ field, from, to }] or any context
  detail       jsonb,
  -- Free-text note (only for action = 'note' added manually by admin)
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Indexes: cover the three query shapes described above
CREATE INDEX IF NOT EXISTS idx_activity_actor    ON activity_logs (actor_id,   created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_subject  ON activity_logs (subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_entity   ON activity_logs (entity_type, entity_id, created_at DESC);

-- Auto-purge old rows: keep last 12 months. Prevents unbounded growth.
-- If you want permanent history, change the interval or remove the cron.
-- (This is a comment — run manually or via pg_cron if available)
-- DELETE FROM activity_logs WHERE created_at < now() - interval '12 months';

COMMENT ON TABLE activity_logs IS
  'Append-only audit log. Written fire-and-forget from server actions. '
  'Never updated or deleted by app code. Auto-purge policy: 12 months.';
