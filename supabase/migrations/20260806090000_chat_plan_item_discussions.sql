-- ─────────────────────────────────────────────────────────────────────────────
-- Per-ITEM discussion rooms for the social calendar.
--
-- Plans already have one room each (conversations.plan_id). This adds the same
-- for a SINGLE item inside a plan, so a debate about one caption doesn't bury
-- the whole month's plan room.
--
-- Mirrors the plan-room shape exactly:
--   • a nullable FK column on conversations
--   • ON DELETE CASCADE — deleting a calendar item removes its room
--   • a PARTIAL unique index (live rooms only), so an archived room can be
--     revived by the app instead of blocking a new one
--
-- Idempotent: safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The link column ---------------------------------------------------------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS plan_item_id uuid
  REFERENCES public.social_calendar_items(id) ON DELETE CASCADE;

-- 2. One LIVE room per item --------------------------------------------------
-- Partial (archived_at IS NULL) so a deleted/archived room does not occupy the
-- slot; getOrCreateEntityConversation revives that row instead of inserting.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_plan_item_unique_live
  ON public.conversations (plan_item_id)
  WHERE plan_item_id IS NOT NULL AND archived_at IS NULL;

-- Sidebar/lookup path: "rooms for this item".
CREATE INDEX IF NOT EXISTS conversations_plan_item_id_idx
  ON public.conversations (plan_item_id)
  WHERE plan_item_id IS NOT NULL;

-- 3. Allow the new conversation type -----------------------------------------
-- `type` may carry a CHECK constraint enumerating allowed values. Find it and
-- widen it to include 'plan_item'; if no such constraint exists, do nothing.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'conversations'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%type%'
    AND pg_get_constraintdef(c.oid) ILIKE '%plan%'
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.conversations DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_type_check
      -- Full superset. 'group' is created by createChannel(type:'channel'|'group')
      -- and MUST stay listed — omitting it here would reject every new group.
      CHECK (type IN ('channel', 'dm', 'group', 'project', 'task', 'client', 'request', 'plan', 'plan_item'));
  END IF;
END $$;
