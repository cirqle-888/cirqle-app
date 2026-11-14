-- WhatsApp chat reports: the daily summary and the open "pending" items the
-- AI works out from each allow-listed chat, plus the words of voice notes and
-- photos so they can be read, searched and summarised like text.
--
-- 1. whatsapp_chat_messages.media_text — what a voice note says / what is
--    written in a photo, filled by the listener webhook when it can.
-- 2. whatsapp_chat_reports — one row per chat per day (India time):
--      summary       what happened in the chat that day, in plain English
--      items         the open items after that day: who is waiting on whom
--      covered_until the newest message already taken into account
--    The newest row for a chat holds its current pending list.
--
-- Server-only, like whatsapp_chat_messages: RLS on, no policies. The pages
-- check who may see which chat (Settings → WhatsApp Listener → who can see)
-- before reading with the service role.
--
-- Until this is applied the chat view keeps working; the Pending and Daily
-- report pages say the table is missing.

BEGIN;

ALTER TABLE public.whatsapp_chat_messages ADD COLUMN IF NOT EXISTS media_text text;

CREATE TABLE IF NOT EXISTS public.whatsapp_chat_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id        text NOT NULL,
  report_day     date NOT NULL,
  summary        text NOT NULL DEFAULT '',
  items          jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_count  integer NOT NULL DEFAULT 0,
  covered_until  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, report_day)
);

CREATE INDEX IF NOT EXISTS whatsapp_chat_reports_day_idx ON public.whatsapp_chat_reports (report_day DESC);

ALTER TABLE public.whatsapp_chat_reports ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.whatsapp_chat_reports IS
  'Daily AI summary and open pending items per allow-listed WhatsApp chat. Server-only: RLS on, no policies.';

COMMIT;
