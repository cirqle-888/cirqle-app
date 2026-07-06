-- ============================================================================
-- 018 — Chat read receipts (Cirqle Connect)
-- Normalized per-message read tracking. Complements (does NOT replace)
-- conversation_members.last_read_at, which keeps powering unread counts.
--
-- conversation_id is denormalized on purpose: Supabase Realtime
-- postgres_changes filters can only match columns on the table itself, and
-- clients subscribe per open conversation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_reads (
  message_id      uuid NOT NULL REFERENCES messages(id)      ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id)     ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, employee_id)          -- = UNIQUE(message_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_message_reads_message ON message_reads (message_id);
CREATE INDEX IF NOT EXISTS idx_message_reads_conv    ON message_reads (conversation_id, read_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Reads: conversation members receive realtime events / may select rows
-- (needed for live ✓✓ updates). The DETAILED receipt list (who + when +
-- designation) is additionally gated sender-only in the server action —
-- defense in depth, one enforcement point for the privacy rule.
-- Writes: server actions only (service role).

ALTER TABLE message_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_reads_select ON message_reads;
CREATE POLICY message_reads_select ON message_reads FOR SELECT
  USING (is_conversation_member(conversation_id));

REVOKE INSERT, UPDATE, DELETE ON message_reads FROM authenticated, anon;

-- ── Realtime ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE message_reads;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
