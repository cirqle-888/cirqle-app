-- WhatsApp chat log: the messages behind the read-only chat view
-- (/dashboard/requests/whatsapp).
--
-- The WhatsApp listener (lib/whatsapp-listener, docs/WHATSAPP_LISTENER.md)
-- already files requests from allow-listed chats, but keeps only the request.
-- This table keeps the conversation itself, so staff can read a client's chat
-- next to their requests without opening WhatsApp.
--
-- Only messages from chats on the listener's allow-list are ever written here.
-- Voice notes and photos live in the private chat-attachments bucket; this
-- table holds their storage path, never the bytes.
--
-- Read and written only by the server (service role): the listener webhook
-- writes, the chat page reads after its own permission check. RLS is on with
-- no policies, so nothing is reachable with a browser key.
--
-- Until this is applied the listener keeps filing requests exactly as before
-- and the chat page says the table is missing.

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_chat_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- WhatsApp's own id for the message: a gateway retry must not store it twice.
  message_id    text NOT NULL UNIQUE,
  chat_id       text NOT NULL,
  is_group      boolean NOT NULL DEFAULT false,
  sender_id     text,
  sender_name   text,
  -- Last 10 digits when the gateway knows the number, else null.
  sender_phone  text,
  -- Sent by Cirqle: the listener number itself, a listed Cirqle number, or an employee's phone.
  from_cirqle   boolean NOT NULL DEFAULT false,
  type          text NOT NULL DEFAULT 'text',
  body          text,
  -- Storage path in the chat-attachments bucket, for a voice note or photo that was kept.
  media_path    text,
  media_mime    text,
  -- Why there is no file when one was sent (too large, not passed on).
  media_note    text,
  -- The request this message was filed as or added to, when it was.
  request_id    uuid REFERENCES public.task_requests(id) ON DELETE SET NULL,
  sent_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_chat_messages_chat_idx ON public.whatsapp_chat_messages (chat_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_chat_messages_sent_idx ON public.whatsapp_chat_messages (sent_at DESC);

ALTER TABLE public.whatsapp_chat_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.whatsapp_chat_messages IS
  'Messages from WhatsApp chats on the listener allow-list, for the read-only chat view. Server-only: RLS on, no policies.';

COMMIT;
