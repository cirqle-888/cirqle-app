-- Chat upgrade: pinned chats that follow the person, starred messages, polls,
-- scheduled messages, department channels, and admin rules for who may chat
-- with whom.
--
-- Every table here is reached through server actions with the service role, so
-- RLS is switched on with NO policies: nothing is readable or writable from a
-- browser session directly. Pinned messages, poll tallies and link previews
-- ride on messages.metadata, which the existing realtime UPDATE already carries.
--
-- Rollback: supabase/rollbacks/20261124100000_chat_upgrade_down.sql

-- 1. Pin a chat to the top of my list — per member, so it follows me to every device.
alter table public.conversation_members
  add column if not exists pinned_at timestamptz;

-- 2. A channel that belongs to one department: only that department sees and joins it.
alter table public.conversations
  add column if not exists department_id uuid references public.service_categories(id) on delete set null;
create index if not exists conversations_department_idx
  on public.conversations (department_id) where department_id is not null;

-- 3. Starred messages — private to the person who starred them.
create table if not exists public.message_stars (
  message_id      uuid not null references public.messages(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (message_id, employee_id)
);
create index if not exists message_stars_employee_idx
  on public.message_stars (employee_id, created_at desc);
alter table public.message_stars enable row level security;

-- 4. Poll votes. The poll itself (question, options) lives in the message's
--    metadata; the tally is written back there after every vote.
create table if not exists public.message_poll_votes (
  message_id  uuid not null references public.messages(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  option_id   text not null check (char_length(option_id) between 1 and 40),
  created_at  timestamptz not null default now(),
  primary key (message_id, employee_id, option_id)
);
alter table public.message_poll_votes enable row level security;

-- 5. Messages written now, sent later.
create table if not exists public.chat_scheduled_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references public.employees(id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 8000),
  send_at         timestamptz not null,
  sent_at         timestamptz,
  sent_message_id uuid references public.messages(id) on delete set null,
  cancelled_at    timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists chat_scheduled_due_idx
  on public.chat_scheduled_messages (send_at)
  where sent_at is null and cancelled_at is null;
create index if not exists chat_scheduled_sender_idx
  on public.chat_scheduled_messages (sender_id, send_at);
alter table public.chat_scheduled_messages enable row level security;

-- 6. Who may chat with whom. One row per department or per person; a person's
--    own row wins over their departments' rows. No row at all keeps today's
--    behaviour (people who share work can reach each other).
--      everyone        – can reach anyone
--      own_department  – only people in a department they are in
--      custom          – own department, plus the listed departments and people
--      none            – cannot start or continue direct chats at all
create table if not exists public.chat_access_rules (
  id             uuid primary key default gen_random_uuid(),
  subject_type   text not null check (subject_type in ('department', 'employee')),
  subject_id     uuid not null,
  mode           text not null check (mode in ('everyone', 'own_department', 'custom', 'none')),
  department_ids uuid[] not null default '{}',
  employee_ids   uuid[] not null default '{}',
  updated_by     uuid references public.employees(id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (subject_type, subject_id)
);
alter table public.chat_access_rules enable row level security;
