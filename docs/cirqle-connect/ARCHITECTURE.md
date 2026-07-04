# Cirqle Connect Phase 2+ — Architecture

Extends the approved `CHAT_MODULE_PLAN.md` with six enterprise collaboration features, designed as **native parts of the CRM**, not bolt-on modules. Same principles: Supabase-first, RLS everywhere, server actions for writes, Realtime for reads, ₹0/month on the current stack.

Documents in this set: `ARCHITECTURE.md` (this file) · `DATABASE_SCHEMA.md` · `API_DESIGN.md` · `UI_FLOW.md` · `IMPLEMENTATION_PLAN.md` · `COST_ANALYSIS.md` · `SECURITY_REVIEW.md` · `FUTURE_ROADMAP.md`

Status: **DESIGN — awaiting review. No implementation yet.**

---

## 1. The reuse map (analysis result)

The CRM already contains five production systems these features must build on. **No duplicate tables, no duplicate notification paths, no second permission system.**

| Existing system | Location | Reused by |
|---|---|---|
| `activity_logs` + `logActivity()` (fire-and-forget, indexed by actor/subject/entity) | `migrations/010`, `src/lib/activity/log.ts` | **Universal Timeline** — extended, not replaced |
| `notifications` + `createNotification()`/`notifyAdmins()` (idempotency via `source_key`) | `src/lib/notifications/create.ts` | Approvals, mentions, AI results, reminders |
| **AI provider registry** — `AIProvider` interface with Groq/OpenAI/Gemini/Anthropic/Ollama adapters + `ad_ai_usage` token tracking | `src/lib/advertising/ai/registry/` | **AI Assistant, Knowledge Base, transcription** — promoted from advertising-scoped to app-wide |
| **Jobs engine** — priorities, retries, DAG deps, dead-letter, `process-jobs` cron | `src/lib/jobs/engine.ts` | Voice transcription, AI summaries, KB indexing — all async work |
| Permissions catalog + `PERMS` constants + middleware route gates + `hasPermission()` | `src/lib/permissions/` | Every new surface gets keys in the same catalog |

Also reused: storage bucket + cleanup-cron pattern (`product-images` → new `chat-attachments`, `voice-notes` buckets), the ⌘K command palette (KB + workspace search sections), `employee-avatar`, toast, Radix UI kit, tokenized client portals for anything client-facing.

## 2. System overview

```
                        ┌────────────────────────────────────────────┐
                        │              EVENT BACKBONE                │
   server actions ────▶ │  logActivity() ──▶ activity_logs (extended)│ ──▶ Timeline tabs (client/project/task/employee)
   workers/crons  ────▶ │  createNotification() ──▶ notifications    │ ──▶ Bell, email digest
                        └────────────────────────────────────────────┘
                                          │
        ┌─────────────┬──────────────────┼──────────────────┬─────────────────┐
        ▼             ▼                  ▼                  ▼                 ▼
   CHAT (Phase 1) APPROVALS         AI ASSISTANT       KNOWLEDGE BASE   PERSONAL WORKSPACE
   conversations  approvals         context builders   kb_documents     workspace_items
   messages       approval_events   (permission-       kb_chunks        (self-scoped RLS)
   attachments    (immutable)        filtered RAG)     (pgvector-ready)
        │             │                  │                  ▲
        ▼             ▼                  ▼                  │
   voice notes    chat approval     jobs engine ───────────┘
   (attachments+  cards (message    (transcribe, summarize, index)
   transcripts)   kind='approval')
```

**One backbone, many consumers.** Every feature *emits* into `activity_logs` and `notifications`; every feature *reads* through RLS-scoped queries. The AI layer never touches raw tables directly — it goes through permission-filtered context builders.

## 3. Feature designs (summary — full schema in DATABASE_SCHEMA.md)

### 3.1 Universal Activity Timeline

**Decision: extend `activity_logs`, do not create a new table.** Migration widens it:

- Drop the narrow `entity_type` CHECK; move to an unconstrained `text` + registry constant in code (same pattern the `action` column already uses).
- Add `category text` — the 8 filter groups (`tasks, billing, chat, files, advertising, crm, employees, finance`), set by the writer.
- Add nullable **scope columns**: `client_id`, `project_id`, `task_id`, `conversation_id` — denormalized so "timeline of client X" is one indexed query instead of N entity-type joins.
- Add composite indexes per scope column (see DATABASE_SCHEMA.md §1).
- Backfill: existing rows get `category` derived from `entity_type` in the migration.

`logActivity()` gains optional `category` + scope fields (backward compatible — every existing call site keeps working). New call sites are added inside existing server actions (client CRUD, invoice lifecycle, file upload, login via auth hook, settings changes) — **~30 one-line `void logActivity(...)` insertions**, no new write path.

A single `<TimelineTab scope={{clientId}}/>` React component renders on client, project, task and employee pages: icon (by category), avatar (actor), relative timestamp, action sentence, deep link built from `entity_type + entity_id`. System events render with a gear avatar. Cursor pagination (30/page), category filter chips.

*Pros*: one table, one writer, indexes already proven, zero new infra. *Cons*: very hot table over years → mitigated by month-range partitioning option (documented, not needed below ~5M rows) and a 24-month archive cron.

### 3.2 AI Assistant inside chat

**Decision: promote the existing advertising AI registry to app-wide** (`src/lib/ai/registry/` re-exporting the adapters), keep Groq free tier as default provider, keep per-call token/cost tracking (generalized `ai_usage` table replacing the advertising-only one via a view).

Core concept: **Context Builders** — the security boundary.

```
user prompt ─▶ intent detection (cheap heuristic or 1 Groq call)
            ─▶ context builders (ONLY these read the DB):
                 buildConversationContext(convId, me)   — last N msgs, RLS-checked membership
                 buildTaskContext(taskId, me)           — task + comments, perm-checked
                 buildClientContext(clientId, me)       — profile + recent invoices IF billing perms
                 buildProjectContext(projectId, me)     — project + campaign stats IF advertising perms
            ─▶ prompt assembly (system prompt + bounded context ≤ ~8k tokens)
            ─▶ AIProvider.generate() (Groq default)
            ─▶ post-actions: create task / draft reply / post summary message
```

Rules: context builders run **as the requesting user's permission set** (`loadCurrentUser()` + `hasPermission()`), never as raw admin scans; every builder has a hard row/token budget; the assistant only sees what the human asking could already see. Output actions (e.g. "create task from discussion") go through the **same server actions** the UI uses — so permission checks, activity logging and notifications happen for free.

Assistant surfaces: a `/ai` slash-command + right-side panel in any conversation; canned actions (Summarize, Minutes, Extract action items/decisions/deadlines, Draft reply, Rewrite, Translate, Create task, Generate checklist/SOP/follow-up/invoice note). Long jobs (big summaries) run through the jobs engine and post the result as a `kind='ai'` message.

*Pros*: provider-agnostic (5 adapters already written), free on Groq, auditable (every call in `ai_usage`), permission-safe by construction. *Cons*: Groq free tier has rate limits (~30 req/min) → per-employee rate limit + queueing; quality below GPT-4/Claude class → provider is a per-workspace setting when they want to pay.

### 3.3 Voice notes

**Decision: no new tables.** A voice note is a `message` with `kind='voice'` + one row in `message_attachments` (bucket `voice-notes`) + metadata `{durationMs, peaks[], transcript?}`.

- **Recording**: MediaRecorder → Opus/WebM at 32 kbps mono (voice-optimized). 1 minute ≈ **240 KB**. Hold-to-record with slide-to-cancel (pointer events), tap-to-lock for long messages.
- **Waveform**: 64 amplitude peaks computed client-side during recording (Web Audio AnalyserNode), stored in message metadata — playback renders instantly with zero server work, no wavesurfer dependency needed for display.
- **Upload**: Supabase Storage resumable (TUS) upload starts while recording finishes; falls back to standard upload < 6 MB.
- **Playback**: signed URL, native `<audio>` + custom UI, speeds 1×/1.5×/2×, download button.
- **Transcription (free)**: jobs-engine job calls **Groq Whisper** (`whisper-large-v3-turbo`, included in Groq free tier). Transcript stored on the message (`metadata.transcript` + appended into `body_search` tsvector) → voice notes become **searchable text**. Failure = graceful (note still playable, "transcript unavailable").
- **Cost control**: 5-minute max duration, bucket cleanup cron for messages deleted > 30 days, storage math in COST_ANALYSIS.md (≈ 1 GB ≈ 70 hours of audio).

### 3.4 Approval workflow

**Decision: one polymorphic, reusable approval engine.** Two tables: `approvals` (the request: entity ref, current status, required approver rule) and `approval_events` (**append-only** history: requested / approved / rejected / changes_requested / commented / version_added / cancelled). Versions are events pointing at attachments — v1, v2, v3 of a design live in the same approval's history.

Approvable anything: `entity_type + entity_id` covers designs (files), posters, invoices, campaigns, quotations, purchases, expenses (cashbook entries), task completions, chat attachments.

**Chat-native**: creating an approval posts a `kind='approval'` message into the chosen conversation. The message renders as a card with Approve / Reject / Request changes / Comment buttons — the buttons call the approval server actions, the card re-renders live via the existing Realtime message-update subscription. Approvals also have a standalone `/dashboard/approvals` inbox (My requests / Awaiting me).

Approver rules v1: a named employee, a designation ("any admin"), or a permission key ("anyone with `billing.edit`"). Sequential multi-step chains are a documented v2 (schema supports it via `step` column — unused in v1).

Integration hooks: on `approved`, an optional per-entity-type callback fires (e.g. invoice → mark ready-to-send; task completion → close task) — registered in one `approvalEffects` map, not scattered.

*Pros*: one engine for 10+ use cases, immutable audit trail, chat-native = it actually gets used. *Cons*: polymorphic FK can't use real foreign keys → mitigated by integrity check in the weekly cron + delete-guards in entity delete actions.

### 3.5 Internal Knowledge Base

**Decision: architecture now, embeddings later — no AI cost today.**

Two layers:

1. **Curated KB** (`kb_documents`): SOPs, policies, meeting notes, how-tos. Markdown editor, folder tree + tags, versioned (edit history in `kb_document_revisions`), permission-scoped (`kb.view` / private-to-designation flags). This is where "How do we generate Meta reports?" gets a written answer.
2. **Federated search index** (`kb_chunks`): every searchable object in the CRM — messages, task titles+descriptions, KB docs, invoice notes, client notes, file names/transcripts — is chunked into rows with `source_type`, `source_id`, `content`, `tsv` (FTS now) and a **nullable `embedding vector(768)`** column (pgvector is enabled and free on Supabase — the column stays empty until the embeddings phase, costing nothing).

Indexing is **incremental via the jobs engine**: writers enqueue `kb.index` jobs (message sent, doc saved, transcript ready); a nightly reconcile cron catches drift. Search today = Postgres FTS with rank + recency boost, filtered by the caller's permissions (chunks carry the same scope columns as the timeline: `client_id`, `project_id`, `conversation_id`). Ask-style questions ("how was this client handled before?") = FTS retrieval → top-K chunks → AI Assistant answer with citations. That is RAG with zero embedding cost; swapping FTS→pgvector similarity later changes **one retrieval function**.

### 3.6 Personal Workspace

**Decision: one flexible table, hard-private RLS.** `workspace_items(owner_id, kind, title, body, metadata, entity refs, planned_for, remind_at, position, tsv)` where `kind ∈ {note, quick_note, draft, bookmark, saved_message, saved_file, reminder, checklist, link, pin, scratchpad, ai_note}`.

- RLS: `owner_id = my employee id` on ALL operations — even admins cannot read another employee's workspace (explicitly no admin bypass policy).
- Pins reference entities (`entity_type`+`entity_id`) → pinned tasks/clients/projects render live cards.
- Daily planner = same rows with `planned_for` date; Today / Tomorrow / This Week are date-range views. Reminders reuse the notification system via the existing daily cron (a light `remind_at <= now()` sweep).
- Checklists = `metadata.items[]`; drafts = `kind='draft'` + `metadata.targetConversationId`; "Saved messages" = bookmark rows pointing at message ids (like Slack's Saved Items).
- Searchable via its own `tsv` + surfaced in ⌘K under a "Personal" section (and indexed into `kb_chunks` **only** with `owner_id` scoping so it never leaks into team search).

## 4. Cross-cutting decisions

- **Every write is a server action** with `loadCurrentUser()` + `hasPermission()` + `logActivity()` — identical to the current codebase style (`enforce.ts` pattern).
- **New permission keys** (added to the catalog, same seeding pattern): `timeline.view_all`, `timeline.view_finance`, `ai.use`, `ai.configure`, `approvals.request`, `approvals.decide_all`, `kb.view`, `kb.edit`, `kb.admin`, `chat.voice`, plus Phase-1 chat keys. Personal workspace needs **no key** (self-scoped).
- **No duplicate notifications**: mention fan-out, approval decisions, reminders, AI-job completions all go through `createNotification()` with `source_key` idempotency.
- **Realtime budget**: no new always-on subscriptions; approval cards and AI messages ride the existing per-open-conversation subscription; timeline tabs are plain paginated queries (no live tail in v1).

## 5. Scalability summary

| Component | Comfortable up to | Then |
|---|---|---|
| activity_logs | ~5M rows on free tier | monthly partitions / archive cron (designed, §DATABASE_SCHEMA 1.4) |
| kb_chunks FTS | ~1–2M chunks | pgvector + HNSW index (column already there) |
| Voice storage | ~70 h audio / 1 GB | Supabase Pro 100 GB, or shorter retention |
| AI (Groq free) | ~1k assisted actions/day (rate-limited) | paid provider toggle, per-workspace setting |
| Jobs engine | already handles advertising sync | unchanged |

Full pros/cons, risks and phased rollout: see the companion documents.
