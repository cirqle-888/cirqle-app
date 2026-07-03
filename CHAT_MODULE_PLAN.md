# Cirqle Connect — Team Chat & Collaboration Module

Architecture and implementation plan for a Slack/Google Chat-style collaboration module built **inside cirqle-app**, deeply integrated with the CRM (projects, tasks, clients, employees, permissions), running at **₹0/month** on the existing free-tier stack, with a clear upgrade path.

Status: **PLAN — approved for phased implementation**
Author: Claude session, 2026-07-03

---

## 1. Goals

- Channels (team-wide + topic), direct messages, group DMs
- Project discussion rooms auto-linked to CRM advertising projects / campaigns
- Task comment threads (chat attached to a task, visible in task views)
- Client conversations (via the existing tokenized intake/portal system — clients never log in)
- @mentions, notifications (in-app bell + email fallback), unread counts
- File sharing (Supabase Storage), reactions, message search
- Presence ("online now") and typing indicators
- Future: 1:1 voice/video calls
- Zero monthly cost initially; graceful upgrade path when the team grows

## 2. Why Supabase Realtime (already in the stack)

The app already runs Next.js on Vercel Hobby + Supabase free tier. Vercel serverless functions **cannot hold websockets**, but that doesn't matter: browsers connect **directly to Supabase Realtime** (wss://<project>.supabase.co) using the existing anon key + RLS. No new infrastructure, no new vendor, no cost.

### Free-tier limits that matter (Supabase, as of mid-2026 — re-verify before Phase 1)

| Resource | Free limit | Our mitigation |
|---|---|---|
| Concurrent Realtime connections | 200 | One multiplexed socket per browser tab; a 15-person team uses ~15–30 |
| Realtime messages/month | 2 million | A busy 15-person team ≈ 100–300k/mo. Headroom ~7–20× |
| Realtime message rate | 500/sec | Never reached at this team size |
| Database size | 500 MB | Text messages ≈ 1KB/row → millions of messages fit; archive cron if needed |
| Storage | 1 GB | 10 MB/file cap + client-side image compression; cleanup cron for orphans (pattern already exists: `cleanup-product-images`) |
| Egress | 5 GB/mo | Signed URLs, thumbnails for images, lazy-load attachments |
| Resend email | 100/day free | Email only for mention-while-offline digests, not every message |

**When to pay:** the first real trigger will be DB size or connections — that's Supabase Pro at **$25/mo**, which also removes the 1-week inactivity pause. Nothing in this design changes at that point; it's a billing toggle.

### Rejected alternatives

- **Self-hosted socket server (fly.io/railway free)** — new deploy target, cold starts, ops burden. Not worth it while Supabase Realtime is free.
- **Firebase/Firestore** — second database, second auth system, data split from CRM. Kills the deep-integration goal.
- **Third-party chat SDKs (Stream, Sendbird)** — free tiers are trial-grade; $99+/mo after. Data lives outside the CRM.

## 3. Architecture overview

```
Browser (dashboard)
 ├── HTTP → Next.js server actions  → Postgres  (writes: send message, create channel…)
 ├── WSS  → Supabase Realtime       ← Postgres  (reads: new-message events, presence, typing)
 └── HTTP → Supabase Storage        (attachments via signed URLs)
```

- **Writes go through Next.js server actions** (same pattern as the rest of the app): permission check via `loadCurrentUser()` → insert with admin client → `revalidatePath` where needed. This keeps business rules (mention parsing, notification fan-out, task linking) server-side.
- **Reads/live updates come from Supabase Realtime**: clients subscribe to `postgres_changes` on `messages` filtered by conversation, authorized by RLS. Presence + typing use Realtime's built-in `presence` and `broadcast` (ephemeral, never hits the DB — free and fast).
- **One socket, many subscriptions**: supabase-js multiplexes all channel subscriptions over a single websocket per tab.

## 4. Data model (migration `0xx_chat_module.sql`)

```sql
-- Conversation container: channels, DMs, and CRM-linked rooms
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('channel','dm','group','project','task','client')),
  name        text,                          -- null for DMs (derived from members)
  topic       text,
  is_private  boolean not null default false,
  -- CRM links (exactly one set for type='project'|'task'|'client')
  project_id  uuid references ad_projects(id) on delete cascade,
  task_id     uuid references tasks(id) on delete cascade,
  client_id   uuid references clients(id) on delete cascade,
  portal_token text,                         -- for client conversations via portal
  created_by  uuid references employees(id),
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

create table conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner','moderator','member')),
  last_read_at    timestamptz not null default now(),   -- unread counts
  notify_level    text not null default 'all' check (notify_level in ('all','mentions','none')),
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, employee_id)
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid references employees(id),          -- null = client (via portal) or system
  sender_portal   text,                                   -- portal token for client senders
  parent_id       uuid references messages(id) on delete cascade,  -- threads
  body            text not null default '',
  body_search     tsvector generated always as (to_tsvector('english', body)) stored,
  kind            text not null default 'text' check (kind in ('text','file','system')),
  metadata        jsonb not null default '{}',            -- mentions[], link previews, system-event payload
  edited_at       timestamptz,
  deleted_at      timestamptz,                            -- soft delete
  created_at      timestamptz not null default now()
);
create index idx_messages_conv_created on messages (conversation_id, created_at desc);
create index idx_messages_search on messages using gin (body_search);
create index idx_messages_parent on messages (parent_id) where parent_id is not null;

create table message_reactions (
  message_id  uuid not null references messages(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  emoji       text not null,
  created_at  timestamptz not null default now(),
  primary key (message_id, employee_id, emoji)
);

create table message_attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references messages(id) on delete cascade,
  storage_path text not null,               -- bucket: chat-attachments
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);
```

**Notifications reuse the existing `notifications` table + bell component** — a new `chat_mention` / `chat_message` notification type, created server-side in the send-message action.

**Activity feed**: channel/room lifecycle events (created, member added, task linked) log to the existing `activity_logs` via `lib/activity/log.ts`; the in-conversation system messages use `kind='system'`.

### RLS (all four tables)

- `select/insert`: member of the conversation (`exists` check against `conversation_members` on `auth_id`) OR public (non-private) channel member of staff.
- `update/delete` on `messages`: sender only (soft delete); moderators can soft-delete any.
- Client portal access does **not** use RLS/auth — it goes through the existing tokenized server-rendered portal pages (server actions with admin client + token validation), same as `/intake/[token]` today.

## 5. Realtime design

| Concern | Mechanism | Notes |
|---|---|---|
| New/edited/deleted messages | `postgres_changes` on `messages`, filter `conversation_id=eq.<id>` | RLS-authorized; only subscribed to the *open* conversation |
| Conversation-list updates (badges) | one `postgres_changes` sub on `messages` for member conversations, or lightweight poll every 30s | start with the poll — cheaper than N subscriptions; optimize later |
| Presence (online) | Realtime `presence` on a single `team` channel | ephemeral, no DB writes |
| Typing indicator | Realtime `broadcast` on the open conversation channel | throttled to 1 event/2s |
| Unread counts | `last_read_at` on `conversation_members`; update on scroll-to-bottom | single `update` per conversation view |

## 6. Deep CRM integration (the differentiator)

- **Project rooms** (`type='project'`): auto-created when an advertising project is created; members = project team. Sidebar shows them under the project. Report-ready/sync-failed events post system messages into the room (hook into existing workers).
- **Task threads** (`type='task'`): "Discuss" button on task rows/modals opens the task's conversation; comment count badge on the task. Assignment/status changes post system messages.
- **Client conversations** (`type='client'`): a chat block on the existing client portal pages (`/portal/[token]`, `/intake/[token]`). Client sends as `sender_portal=<token>`; team replies from the dashboard. This turns the portal into two-way communication without client accounts.
- **Mentions**: `@name` (and `@cqid`) autocomplete from `employees`; parsed server-side into `metadata.mentions[]` → notification fan-out; respects `notify_level`.
- **Permissions**: new keys seeded into `permissions`: `chat.access`, `chat.create_channels`, `chat.moderate`, `chat.client_conversations`. Route gate `/dashboard/chat → chat.access` added to `ROUTE_PERMS` in `src/lib/supabase/middleware.ts`.
- **Search**: Postgres FTS on `body_search`, scoped to the user's conversations; surfaced in the existing command palette (`⌘K`) as a "Messages" section.

## 7. UI plan

- New sidebar section **Chat** → `/dashboard/chat` (3-pane: conversation list / thread / details).
- Reuse existing UI kit: Radix primitives, `employee-avatar`, `command-palette`, toast system, dark mode tokens.
- Message list: virtualized (react-window ~2KB) + cursor pagination (50/page) — keeps payloads tiny and egress low.
- Composer: textarea with @mention popover, file button (10MB cap, client-side image compression), Enter-to-send.
- Mobile: conversation list ↔ thread as stacked views (the dashboard already has a mobile bottom-nav pattern for employees).

## 8. Voice / video (future, still ₹0 to start)

1. **Phase A (free, P2P)**: 1:1 calls via native WebRTC; signaling over Supabase Realtime `broadcast` (offer/answer/ICE). STUN: free Google/Cloudflare servers. Works for 1:1 on most networks; no TURN = some strict-NAT failures.
2. **Phase B (small cost)**: group calls / reliability → LiveKit Cloud (free tier, then usage-based) or self-hosted LiveKit (~$5–10/mo VPS). Decide only when 1:1 P2P proves insufficient.

## 9. Phased implementation

| Phase | Scope | Est. effort |
|---|---|---|
| **1 — Core messaging** | Migration + RLS, channels & DMs, send/receive realtime, unread badges, permission keys, sidebar page | 3–5 sessions |
| **2 — Rich messaging** | Threads, mentions + notifications (bell + email digest), reactions, file attachments + storage bucket + cleanup cron, FTS search in ⌘K | 3–4 sessions |
| **3 — CRM integration** | Project rooms, task threads, client portal conversations, system messages from workers, activity-log hooks | 3–4 sessions |
| **4 — Presence & polish** | Presence, typing, message edit/delete UI, virtualized list perf pass, mobile polish, web-push (VAPID, free) | 2–3 sessions |
| **5 — Calls (optional)** | P2P 1:1 WebRTC via Realtime signaling | 2–3 sessions |

Each phase ships usable value independently; stop or pause at any boundary.

## 10. Cost summary

| Stage | Monthly cost |
|---|---|
| Launch → small team (≤ ~30 active users) | **₹0** (existing Supabase + Vercel free tiers) |
| Growth trigger: DB > 500MB, storage > 1GB, or > 200 concurrent connections | Supabase Pro **$25/mo** (~₹2,100) — flip a switch, zero code changes |
| Optional group video | LiveKit Cloud free tier → usage-based, or ~$10/mo VPS |

## 11. Risks & mitigations

- **Free-tier inactivity pause** (project pauses after 1 week without traffic): the CRM is used daily + Vercel crons hit the DB daily — effectively moot; Pro removes it entirely.
- **Realtime `postgres_changes` and RLS**: verify per-row authorization behavior on the current Supabase version during Phase 1 spike; if filtering proves unreliable for private rooms, switch to Realtime **broadcast-from-database** (private channels with explicit authorization RPC), which is the Supabase-recommended pattern for chat.
- **Egress creep from attachments**: thumbnails + signed URL expiry + size caps from day one.
- **Message volume in DB**: soft-archive conversations idle > 12 months via a cron (pattern exists).
