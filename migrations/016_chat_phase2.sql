-- ============================================================================
-- 016 — Chat Phase 2: attachments bucket (mentions/threads/reactions need no
-- schema — they ride the tables from 015: messages.parent_id, metadata,
-- message_reactions, message_attachments).
-- ============================================================================

-- Private storage bucket for chat files & (later) voice notes.
-- All access via short-lived signed URLs issued by server actions —
-- no RLS storage policies for authenticated users on purpose.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-attachments',
  'chat-attachments',
  false,
  10485760,               -- 10 MB per file
  NULL                    -- any type; server action validates
)
ON CONFLICT (id) DO NOTHING;
