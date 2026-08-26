-- ============================================================================
-- Chat sidebar summary — collapse the listConversations N+1 into one round-trip
--
-- EGRESS: listConversations() ran two PostgREST requests per conversation (a
-- GET for the last message, a HEAD for the unread count). At ~30 rooms that is
-- ~60 requests every time the sidebar refreshed — and the sidebar refreshes on
-- a 90s timer on the chat page, a 5min timer app-wide via FloatingCommsWidget,
-- and on realtime events. It was the single largest source of API traffic on
-- the project (16,203 requests to /rest/v1/messages in one day, against six
-- users), and it pushed the org past the Free plan's 5 GB monthly egress.
--
-- This function returns the same two facts for every conversation at once, so
-- the sidebar costs one request instead of two per room.
--
-- Semantics deliberately mirror the PostgREST queries they replace:
--   * last message ignores deleted_at (the UI renders "Message deleted")
--   * unread uses `sender_id <> p_employee_id`, NOT `IS DISTINCT FROM` —
--     PostgREST's .neq() drops NULL senders, so system/client messages were
--     never counted as unread and must stay that way.
--   * non-members (public channels not yet joined) get 0, matching the old
--     isMember ternary.
--
-- Service-role only: it takes an employee id as a parameter and is SECURITY
-- DEFINER, so leaving EXECUTE on anon/authenticated would let any signed-in
-- user read every room's last-message preview. The only caller is the chat
-- server action, which uses the admin client after authenticating.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION chat_sidebar_summary(
  p_employee_id      uuid,
  p_conversation_ids uuid[]
)
RETURNS TABLE (
  conversation_id  uuid,
  last_body        text,
  last_kind        text,
  last_deleted_at  timestamptz,
  last_created_at  timestamptz,
  last_sender_name text,
  last_sender_cqid text,
  unread_count     integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH last_msg AS (
    -- Uses idx_messages_conv_created (conversation_id, created_at DESC).
    SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id, m.body, m.kind, m.deleted_at, m.created_at, m.sender_id
      FROM messages m
     WHERE m.conversation_id = ANY (p_conversation_ids)
     ORDER BY m.conversation_id, m.created_at DESC
  ),
  unread AS (
    SELECT cm.conversation_id, COUNT(m.id)::int AS n
      FROM conversation_members cm
      LEFT JOIN messages m
        ON m.conversation_id = cm.conversation_id
       AND m.created_at > cm.last_read_at
       AND m.sender_id <> p_employee_id
       AND m.deleted_at IS NULL
     WHERE cm.employee_id = p_employee_id
       AND cm.conversation_id = ANY (p_conversation_ids)
     GROUP BY cm.conversation_id
  )
  SELECT ids.id,
         lm.body, lm.kind, lm.deleted_at, lm.created_at,
         e.name, e.cqid,
         COALESCE(u.n, 0)
    FROM unnest(p_conversation_ids) AS ids(id)
    LEFT JOIN last_msg  lm ON lm.conversation_id = ids.id
    LEFT JOIN employees e  ON e.id = lm.sender_id
    LEFT JOIN unread    u  ON u.conversation_id = ids.id
$$;

REVOKE ALL ON FUNCTION chat_sidebar_summary(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION chat_sidebar_summary(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION chat_sidebar_summary(uuid, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION chat_sidebar_summary(uuid, uuid[]) TO service_role;

COMMIT;
