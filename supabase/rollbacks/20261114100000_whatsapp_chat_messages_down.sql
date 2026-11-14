-- Removes the WhatsApp chat log. The stored voice notes and photos stay in the
-- chat-attachments bucket (under whatsapp-chat/); delete that folder too if
-- the conversations themselves should go.
BEGIN;
DROP TABLE IF EXISTS public.whatsapp_chat_messages;
COMMIT;
