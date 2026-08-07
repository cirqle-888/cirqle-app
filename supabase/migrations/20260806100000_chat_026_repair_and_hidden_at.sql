-- ─────────────────────────────────────────────────────────────────────────────
-- Chat schema repair — reconciles migration 026 with per-item discussion rooms.
--
-- WHY THIS EXISTS
-- 026_chat_plan_discussions.sql was applied to production but never committed,
-- so the repo could not rebuild it. Re-running it now FAILS:
--
--     ERROR 23514: check constraint "conversations_type_check"
--                  of relation "conversations" is violated by some row
--
-- because 026 rewrites the type CHECK with a list that predates 'plan_item',
-- while a plan_item room already exists. 026 also DROPs the constraint before
-- re-adding it, so a partial run can leave the table with no CHECK at all.
--
-- This script is the reconciled end state. It is idempotent and additive:
-- everything 026 still owes is applied, the CHECK becomes the full superset,
-- and the pieces already present become no-ops.
--
-- SAFE TO RUN ON THE CURRENT DATABASE. Verified beforehand:
--   • conversations.plan_id        already present  → no-op
--   • conversations.plan_item_id   already present  → no-op
--   • conversation_members.hidden_at MISSING        → added here
--   • 1 row with type='plan_item'                   → allowed by the new CHECK
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Per-member DM hide ------------------------------------------------------
-- Archiving a DM would be a GLOBAL delete: one participant could wipe the other
-- side's access to shared correspondence. A DM is therefore hidden per member
-- and returns to the sidebar as soon as a newer message arrives.
-- This column is what "Delete chat" on a DM writes; without it that action
-- fails at runtime.
ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

-- Sidebar reads "my hidden conversations" on every load.
CREATE INDEX IF NOT EXISTS conversation_members_hidden_at_idx
  ON public.conversation_members (employee_id, hidden_at)
  WHERE hidden_at IS NOT NULL;

-- 2. Entity link columns (no-ops if 026 / the plan_item migration ran) --------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS plan_id uuid
  REFERENCES public.social_calendars(id) ON DELETE CASCADE;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS plan_item_id uuid
  REFERENCES public.social_calendar_items(id) ON DELETE CASCADE;

-- 3. The type CHECK — full superset, applied last ----------------------------
-- Every value the application can write. Keep this list in sync with
-- ChatConversation['type'] in dashboard/chat/actions.ts. Dropping and re-adding
-- in one statement pair inside a single migration keeps the window closed.
ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_type_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_type_check
  CHECK (type IN ('channel', 'dm', 'group', 'project', 'task', 'client', 'request', 'plan', 'plan_item'));

-- 4. ONE LIVE room per entity ------------------------------------------------
-- Partial (archived_at IS NULL): the 019 indexes covered archived rows too, so
-- reviving a deleted room was impossible — the insert collided with the zombie
-- and the retry handed back a room no sidebar could reach.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_plan_unique_live
  ON public.conversations (plan_id)
  WHERE plan_id IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_plan_item_unique_live
  ON public.conversations (plan_item_id)
  WHERE plan_item_id IS NOT NULL AND archived_at IS NULL;
