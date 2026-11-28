-- Reverses 20261128100000_chat_unit_lines.sql: restores the membership check
-- exactly as migration 015 defined it, then drops the unit-line function.
-- The app's own checks (lib/chat/access.ts) keep applying the unit line to
-- everything done through the app; only the database-level guard goes.
BEGIN;

CREATE OR REPLACE FUNCTION public.is_conversation_member(conv_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversation_members
    WHERE conversation_id = conv_id AND employee_id = current_employee_id()
  )
$$;

DROP FUNCTION IF EXISTS public.chat_unit_blocked(uuid, uuid);

COMMIT;
