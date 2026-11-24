-- Rollback for 20261124100000_chat_upgrade.sql
-- Drops starred messages, poll votes, scheduled messages and chat access rules
-- (their data is lost) and removes the two added columns.
drop table if exists public.chat_access_rules;
drop table if exists public.chat_scheduled_messages;
drop table if exists public.message_poll_votes;
drop table if exists public.message_stars;
drop index if exists public.conversations_department_idx;
alter table public.conversations drop column if exists department_id;
alter table public.conversation_members drop column if exists pinned_at;
