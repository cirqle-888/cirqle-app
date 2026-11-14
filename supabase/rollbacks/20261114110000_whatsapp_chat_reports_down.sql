-- Removes the WhatsApp daily reports and pending items, and the stored words
-- of voice notes and photos. The chat view itself keeps working.
BEGIN;
DROP TABLE IF EXISTS public.whatsapp_chat_reports;
ALTER TABLE public.whatsapp_chat_messages DROP COLUMN IF EXISTS media_text;
COMMIT;
