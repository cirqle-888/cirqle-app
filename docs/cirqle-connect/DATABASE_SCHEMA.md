# Cirqle Connect Phase 2+ — Database Schema

Draft migration set. Builds on the Phase-1 chat tables from `CHAT_MODULE_PLAN.md` (`conversations`, `conversation_members`, `messages`, `message_reactions`, `message_attachments`). Nothing here duplicates an existing table.

Migration order: `0xx_timeline_extension.sql` → `0xx_approvals.sql` → `0xx_knowledge_base.sql` → `0xx_workspace.sql` → `0xx_ai_usage.sql`. (Voice notes need **no migration** beyond Phase-1 chat + one storage bucket.)

---

## 1. Universal Timeline — extend `activity_logs`

```sql
-- 1.1 Widen entity_type: constraint moves to code (same pattern as `action`)
alter table activity_logs drop constraint if exists activity_logs_entity_type_check;

-- 1.2 Category + scope columns (all nullable — old rows and writers stay valid)
alter table activity_logs
  add column if not exists category        text,   -- tasks|billing|chat|files|advertising|crm|employees|finance
  add column if not exists client_id       uuid references clients(id)       on delete set null,
  add column if not exists project_id      uuid references ad_projects(id)   on delete set null,
  add column if not exists task_id         uuid references tasks(id)         on delete set null,
  add column if not exists conversation_id uuid references conversations(id) on delete set null;

-- 1.3 Scope indexes — each timeline tab is ONE index scan
create index if not exists idx_activity_client   on activity_logs (client_id,       created_at desc) where client_id is not null;
create index if not exists idx_activity_project  on activity_logs (project_id,      created_at desc) where project_id is not null;
create index if not exists idx_activity_task     on activity_logs (task_id,         created_at desc) where task_id is not null;
create index if not exists idx_activity_conv     on activity_logs (conversation_id, created_at desc) where conversation_id is not null;
create index if not exists idx_activity_category on activity_logs (category,        created_at desc);

-- 1.4 Backfill category from entity_type for existing rows
update activity_logs set category = case entity_type
  when 'task'         then 'tasks'
  when 'contribution' then 'tasks'
  when 'score'        then 'tasks'
  when 'invoice'      then 'billing'
  when 'cashbook'     then 'finance'
  when 'payroll'      then 'finance'
  when 'employee'     then 'employees'
  else 'crm' end
where category is null;
```

**New entity_type / category values written by code** (registry constants in `src/lib/activity/log.ts`):

| entity_type (new) | category | example actions |
|---|---|---|
| `client` | crm | created, updated, archived |
| `project` | advertising | created, assigned, status_changed |
| `file` | files | uploaded, deleted, version_added |
| `message` | chat | sent (system-relevant only — see note), mention |
| `approval` | (entity's own) | requested, approved, rejected, changes_requested |
| `kb_document` | crm | created, updated, published |
| `auth` | employees | login, password_reset |
| `setting` | crm | changed (with detail diff) |
| `leave` | employees | requested, approved |
| `quotation` | billing | created, sent, accepted |

> **Chat volume note:** ordinary chat messages do NOT each write an activity row (that would double message volume for no value). Only timeline-worthy chat events do: conversation created, member added, mention of the subject, approval card posted. "Chat" filter on a client timeline shows the client's conversation events, not every message.

**Retention** (Phase T4): monthly cron moves rows older than 24 months into `activity_logs_archive` (same shape, no indexes except PK). Partitioning DDL is documented in the migration file as a commented block — apply only if the live table exceeds ~5M rows.

**RLS**: `activity_logs` keeps service-role-only writes. Reads go through a server action that filters by the caller's permissions (finance rows require `timeline.view_finance`, everything-across-entities requires `timeline.view_all`; otherwise scope-limited to entities the user can already open). RLS-on-table is intentionally NOT used for the finance filter because rows are category-mixed; the read path is a single server function (`getTimeline`) — one enforcement point.

---

## 2. Approval engine

```sql
create table approvals (
  id             uuid primary key default gen_random_uuid(),
  -- What is being approved (polymorphic)
  entity_type    text not null,           -- file|invoice|campaign|quotation|purchase|expense|task_completion|attachment|design|other
  entity_id      text not null,
  title          text not null,           -- human label shown on cards
  description    text,
  -- Who decides: exactly one of the three
  approver_employee_id  uuid references employees(id) on delete set null,
  approver_designation_id uuid references designations(id) on delete set null,
  approver_permission   text,             -- e.g. 'billing.edit' → anyone holding it
  -- State machine
  status         text not null default 'pending'
                 check (status in ('pending','approved','rejected','changes_requested','cancelled')),
  step           int  not null default 1, -- reserved for v2 sequential chains
  -- Context links (denormalized, same as activity_logs)
  client_id      uuid references clients(id)       on delete set null,
  project_id     uuid references ad_projects(id)   on delete set null,
  task_id        uuid references tasks(id)         on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  message_id     uuid references messages(id)      on delete set null,  -- the chat card
  requested_by   uuid not null references employees(id),
  decided_by     uuid references employees(id),
  decided_at     timestamptz,
  due_at         timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index idx_approvals_pending_for on approvals (status, approver_employee_id, approver_designation_id);
create index idx_approvals_entity      on approvals (entity_type, entity_id);
create index idx_approvals_requester   on approvals (requested_by, created_at desc);

-- Append-only history: NEVER updated, NEVER deleted (no update/delete policies at all)
create table approval_events (
  id           uuid primary key default gen_random_uuid(),
  approval_id  uuid not null references approvals(id) on delete cascade,
  actor_id     uuid references employees(id),
  event        text not null check (event in
               ('requested','approved','rejected','changes_requested','commented','version_added','cancelled','reopened')),
  comment      text,
  -- Version support: attachment snapshot for 'version_added' (v1, v2, v3…)
  attachment_id uuid references message_attachments(id) on delete set null,
  version_no   int,
  created_at   timestamptz not null default now()
);
create index idx_approval_events on approval_events (approval_id, created_at);
```

RLS: members of the linked conversation, the requester, and eligible approvers can `select`; `insert/update` only via server actions (checked against the approver rule + `approvals.decide_all` override). `approval_events` has **no update/delete policy for anyone** — immutability enforced at the database, not just convention.

---

## 3. Voice notes — no new table

Reuses Phase-1 `messages` + `message_attachments`:

- `messages.kind` check gains `'voice'` and `'ai'` and `'approval'` values (one-line migration on the Phase-1 check constraint).
- `message_attachments` row → bucket `voice-notes`, `mime_type='audio/webm;codecs=opus'`.
- `messages.metadata` for voice: `{ durationMs, peaks: number[64], transcript: string|null, transcriptStatus: 'pending'|'done'|'failed', language }`.
- Transcript searchability: `body_search` generated column (Phase 1) is redefined once to include the transcript:

```sql
alter table messages drop column body_search;
alter table messages add column body_search tsvector
  generated always as (
    to_tsvector('english', coalesce(body,'') || ' ' || coalesce(metadata->>'transcript',''))
  ) stored;
create index idx_messages_search on messages using gin (body_search);
```

Storage bucket `voice-notes`: private; upload/read via signed URLs from server actions; 6 MB per-object cap (≈ 5 min at 32 kbps + headroom); cleanup cron deletes objects whose message was soft-deleted > 30 days ago (same pattern as `cleanup-product-images`).

---

## 4. Knowledge base

```sql
-- 4.1 Curated documents (SOPs, policies, meeting notes, how-tos)
create table kb_documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  slug         text unique,
  body         text not null default '',          -- markdown
  folder       text not null default '/',         -- materialized path: '/sops/reporting/'
  tags         text[] not null default '{}',
  doc_type     text not null default 'doc' check (doc_type in ('doc','sop','policy','meeting_notes','template')),
  status       text not null default 'draft' check (status in ('draft','published','archived')),
  -- Optional scoping: null = whole team (with kb.view)
  restricted_to_designation uuid references designations(id) on delete set null,
  client_id    uuid references clients(id)     on delete set null,
  project_id   uuid references ad_projects(id) on delete set null,
  created_by   uuid references employees(id),
  updated_by   uuid references employees(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  tsv          tsvector generated always as
               (setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                setweight(to_tsvector('english', coalesce(body,'')),  'B')) stored
);
create index idx_kb_docs_tsv    on kb_documents using gin (tsv);
create index idx_kb_docs_folder on kb_documents (folder, status);

create table kb_document_revisions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references kb_documents(id) on delete cascade,
  body        text not null,
  title       text not null,
  edited_by   uuid references employees(id),
  created_at  timestamptz not null default now()
);
create index idx_kb_revisions on kb_document_revisions (document_id, created_at desc);

-- 4.2 Federated search index (messages, tasks, docs, files, invoices, client notes…)
create extension if not exists vector;  -- pgvector: free on Supabase, column stays empty until embeddings phase

create table kb_chunks (
  id           uuid primary key default gen_random_uuid(),
  source_type  text not null,  -- message|task|kb_document|file|invoice|client_note|transcript|workspace_item
  source_id    text not null,
  chunk_no     int  not null default 0,          -- long sources split into ~1k-token chunks
  content      text not null,
  -- Permission scoping (mirrors activity_logs — filters applied at query time)
  client_id       uuid,
  project_id      uuid,
  conversation_id uuid,
  owner_id        uuid,        -- set ONLY for workspace_item chunks → private to owner
  requires_perm   text,        -- e.g. 'billing.view_invoices' for invoice chunks
  tsv          tsvector generated always as (to_tsvector('english', content)) stored,
  embedding    vector(768),    -- NULL until embeddings phase; then HNSW index added
  indexed_at   timestamptz not null default now(),
  unique (source_type, source_id, chunk_no)
);
create index idx_kb_chunks_tsv    on kb_chunks using gin (tsv);
create index idx_kb_chunks_source on kb_chunks (source_type, source_id);
-- Later (embeddings phase): create index on kb_chunks using hnsw (embedding vector_cosine_ops);
```

Indexing pipeline: writers enqueue `{job_type:'kb.index', payload:{sourceType, sourceId}}` into the existing jobs engine; the worker upserts chunks. Nightly `kb.reconcile` job sweeps for missed/stale sources and deletes chunks of deleted sources. Estimated size: 1 chunk ≈ 1 KB → 100k chunks ≈ 100 MB… fits free tier for years at this team size (math in COST_ANALYSIS.md).

---

## 5. Personal workspace

```sql
create table workspace_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references employees(id) on delete cascade,
  kind        text not null check (kind in
              ('note','quick_note','draft','bookmark','saved_message','saved_file',
               'reminder','checklist','link','pin','scratchpad','ai_note')),
  title       text,
  body        text,                                -- markdown for notes/scratchpad/drafts
  metadata    jsonb not null default '{}',         -- checklist items[], draft target, url, colors…
  -- Entity references (pins, saved messages/files, bookmarks)
  entity_type text,                                -- task|client|project|message|file|invoice|conversation
  entity_id   text,
  -- Planner & reminders
  planned_for date,                                -- Today/Tomorrow/This Week views
  remind_at   timestamptz,                         -- swept by daily cron → createNotification()
  reminded_at timestamptz,
  is_done     boolean not null default false,
  position    int not null default 0,              -- manual ordering within a view
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  tsv         tsvector generated always as
              (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) stored
);
create index idx_ws_owner    on workspace_items (owner_id, kind, updated_at desc);
create index idx_ws_planner  on workspace_items (owner_id, planned_for) where planned_for is not null;
create index idx_ws_reminder on workspace_items (remind_at) where remind_at is not null and reminded_at is null;
create index idx_ws_tsv      on workspace_items using gin (tsv);

alter table workspace_items enable row level security;
-- HARD privacy: owner-only for every operation. Deliberately NO admin-bypass policy.
create policy ws_owner_all on workspace_items
  for all
  using  (owner_id = (select id from employees where auth_id = auth.uid()))
  with check (owner_id = (select id from employees where auth_id = auth.uid()));
```

---

## 6. Generalized AI usage (replaces advertising-only tracking)

```sql
create table ai_usage (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid references employees(id) on delete set null,
  feature       text not null,   -- chat_assistant|kb_answer|transcription|advertising|capture
  provider      text not null,
  model         text not null,
  prompt_tokens int, completion_tokens int, total_tokens int,
  estimated_cost numeric(10,6) not null default 0,
  latency_ms    int,
  -- Optional context
  client_id uuid, project_id uuid, conversation_id uuid,
  created_at    timestamptz not null default now()
);
create index idx_ai_usage_emp  on ai_usage (employee_id, created_at desc);
create index idx_ai_usage_feat on ai_usage (feature, created_at desc);

-- Compatibility: ad_ai_usage becomes a view over ai_usage (feature='advertising')
-- so existing advertising dashboards keep working. Migration copies old rows in.
```

Per-employee daily budget check (`ai.use` limiter) reads this table — one indexed count per request.

---

## 7. Database impact summary

| Change | Rows added/day (15-person team, busy) | Notes |
|---|---|---|
| activity_logs (extended) | ~300–800 | +5 columns, 5 indexes on existing table |
| approvals + events | ~10–40 | tiny |
| voice metadata | 0 new tables | rides messages |
| kb_documents (+revisions) | ~5–20 | tiny |
| kb_chunks | ~500–1500 (mirrors message volume) | biggest new consumer; ~1 KB/row |
| workspace_items | ~30–100 | tiny |
| ai_usage | ~50–200 | tiny |

Projected DB growth: **~2–4 MB/day worst case → ~1 GB/year**, dominated by kb_chunks + messages. Free tier (500 MB) comfortably covers ~4–6 months of heavy use; Supabase Pro ($25/mo, 8 GB) covers years. Retention levers (chunk pruning of old messages, activity archive) can stretch the free tier further — see COST_ANALYSIS.md.
