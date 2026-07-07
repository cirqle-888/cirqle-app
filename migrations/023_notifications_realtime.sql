-- ============================================================================
-- 023 — Publish `notifications` to realtime
-- Lets an always-mounted client listener react to new bell notifications the
-- instant they're inserted (powers native desktop notifications in the Cirqle
-- Desktop app, and could drive live in-browser toasts later). `messages` is
-- already in the publication from 015, so chat needs nothing here.
--
-- Idempotent: safe to re-run. No table/column changes — publication only.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END $$;
