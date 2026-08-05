# HANDOFF — Cirqle Connect (continue in new chat)

Paste this whole document as the first message in a new session. It contains everything needed to continue without re-analysis.

---

## WHO / WHAT

I'm Farooq (farooq@cirqle.work), running Cirqle, a Kerala-based creative design agency. Two projects in `~/Projects`:

1. **cirqle-app** — the CRM (Next.js 16.2.6, React 19, Supabase, Tailwind 4, Vercel Hobby, region sin1). Live at https://app.cirqle.work. ~95k lines. This is where all current work happens.
2. **cirqle-portfolio-final-main** — marketing site (Vite + React SPA). Live at https://www.cirqle.work. A careers page was added at `/careers` (commit may still be pending; repo showed "bad object HEAD" from a sandbox mount — verify `git status` locally).

**Business model**: contribution/commission-based pay (no fixed salaries). Employees have CQIDs (CQID001…). Tables: employees, clients, tasks, task_requests, ad_projects, invoices, cashbook_entries, quotations, designations, permissions (key-based, seeded via migrations), notifications, activity_logs, system_jobs (job queue with cron worker), company_settings.

## NON-NEGOTIABLE CONVENTIONS (follow exactly)

1. **Privacy rule (critical)**: CQID-first everywhere. Real names show ONLY to admins with the reveal toggle on. Use `displayEmployee({name, cqid}, {revealNames, canReveal: true})` from `src/lib/utils/employee-display.ts` with `revealNames` from `usePermissions()` (context already combines admin+toggle). Never put real names into stored message bodies (mentions insert `@CQID`). DM conversation names arrive as `"CQID||Name"` strings — split and mask client-side. Approval `approverLabel` for a named person also arrives as `"CQID||Name"`.
2. **Server action pattern**: every mutation = `loadCurrentUser()` / `hasPermission()` (from `src/lib/permissions/check.ts`) or `requirePermission()` (from `src/lib/auth/enforce.ts`) → admin client write (`createAdminClient` from `src/lib/supabase/admin`) → `void logActivity(...)` (fire-and-forget, `src/lib/activity/log.ts`) → `createNotification()` where relevant (`src/lib/notifications/create.ts`, idempotent via sourceKey).
3. **RLS**: reads authorized by RLS (browser realtime relies on it); writes server-action-only (REVOKE on authenticated). Helper fns `current_employee_id()`, `is_conversation_member()` exist in DB.
4. **Graceful pre-migration degradation**: code must tolerate a migration not being applied (see `safeQuery` pattern in `src/lib/supabase/server.ts`, and PGRST204 fallbacks in `logActivity`).
5. **Verification gate before claiming done**: `npx tsc --noEmit` clean, `npx eslint` clean on touched files, `npm test` (vitest, 170 tests) green. React-compiler lint rules apply: no setState synchronously in effects (defer with setTimeout 0), no ref reads during render.
6. Root scratch files go to `_archive/dev-scripts/` (gitignored).

## WHAT IS BUILT (all code complete, tsc/lint/tests green)

**Design docs**: `docs/cirqle-connect/` (8 files: ARCHITECTURE, DATABASE_SCHEMA, API_DESIGN, UI_FLOW, IMPLEMENTATION_PLAN, COST_ANALYSIS, SECURITY_REVIEW, FUTURE_ROADMAP) + `CHAT_MODULE_PLAN.md` (approved chat plan).

**Migrations created (run in Supabase SQL editor, in order — ask me which are applied!)**:
- `014_timeline_extension.sql` — activity_logs: category + client/project/task/conversation scope cols, indexes, perms `timeline.view_all`/`timeline.view_finance`
- `015_chat_module.sql` — conversations, conversation_members, messages (FTS incl. voice transcript), message_reactions, message_attachments, RLS, realtime publication, perms `chat.*`
- `016_chat_phase2.sql` — `chat-attachments` private bucket (10MB)
- `017_approvals.sql` — approvals + append-only approval_events, RLS, perms `approvals.request`/`approvals.decide_all`
- `018_chat_read_receipts.sql` — message_reads (denormalized conversation_id for realtime filters), publication
- `019_chat_categories_entities.sql` — conversations.category, type 'request' + request_id (FK task_requests), unique per-entity room indexes, REPLICA IDENTITY FULL on messages/message_reads

**Features (key files)**:
- **Universal Timeline (Wave A)**: `src/lib/activity/{log,timeline,timeline-copy}.ts`, `src/components/activity/timeline-tab.tsx`, `/dashboard/activity` page, Timeline tab on advertising project detail. ~15 writer call sites added (clients/invoices/cashbook/settings/ad projects/login).
- **Chat (Phases 1+2 + extensions)**: `src/app/(dashboard)/dashboard/chat/{page.tsx,chat-client.tsx,actions.ts}`. Channels/groups/DMs, ONE workspace-wide realtime subscription (INSERT/UPDATE messages + INSERT message_reads, RLS-scoped), optimistic text send, mentions (@CQID, server-parsed, bell notifications, deep link `?c=<convId>`), reply threads (parent_id, ThreadPanel), WhatsApp quote replies (metadata.replyTo snapshot w/ mini-waveform, jump-to-original, "unavailable" when deleted), reactions, file attachments (signed URLs, image previews), FTS search, read receipts (✓✓ ticks, group "read by" popover w/ designation+time, sender-only detail via getReadReceipts), incoming alerts (beep + toast + system Notification when hidden), unread badges, grouped sidebar (Channels/Departments/Clients/Discussions/DMs), channel dialog with category tabs + client dropdown (auto-names channel, links client_id).
- **Approvals (Wave B)**: `src/lib/approvals/{actions,effects}.ts`, `src/components/approvals/{approval-card,request-approval-dialog}.tsx`, `/dashboard/approvals` inbox. Polymorphic, 3 approver rules (person/designation/permission, default any-admin), never-decide-own, decided-exactly-once, chat cards (kind='approval', live via metadata updates), task_completion effect closes task.
- **Voice notes (Wave C)**: `src/components/chat/voice.tsx` (hold/slide-cancel/slide-up-lock recorder, 64-peak waveform, 1/1.5/2× playback), Groq Whisper transcription via `src/lib/ai/transcribe.ts` + `after()` in sendVoiceMessage; transcripts searchable.
- **Discuss buttons**: `src/components/chat/discuss-button.tsx` + `getOrCreateEntityConversation` (task/project/request/client; one room per entity; auto-join). Wired: request detail action bar, task-edit-modal, advertising project header.
- **Desktop (Electron, `desktop/`)**: mic permission fixed in `desktop/src/main.js` (setPermissionRequestHandler + askForMediaAccess) + `NSMicrophoneUsageDescription` in electron-builder.yml. Needs `npm run dist` rebuild.

**Security state**: cron routes fail closed on CRON_SECRET (must exist in Vercel env, exists in .env.local); advertising APIs permission-checked; security headers in next.config.ts; admin-fallback bug fixed in dashboard layout. Known repo issue: website repo remote URL embeds a GitHub PAT — MUST be rotated + remote switched to SSH.

## CURRENT STATE / IMMEDIATE TODOS

- Last session's changes (privacy masking, alerts, optimistic send, global realtime, categories, discuss buttons, Electron mic, migration 019) are **uncommitted** — commit + push (Vercel auto-deploys). Sandbox cannot write to .git (a stale `.git/index.lock` may exist — `rm -f .git/index.lock` first).
- Run any unapplied migrations 014→019 in Supabase; verify `messages` + `message_reads` appear in Database → Replication.
- Grant new permission keys to designations (Settings → Designations): chat.access, chat.create_channels, chat.moderate, chat.voice*, approvals.request, timeline.view_all/finance. (*chat.voice key was designed but check if seeded — voice currently gates on chat.access only.)
- Rebuild desktop app for mic. Test realtime speed with two accounts after 019.
- Website: verify git repo health locally, push careers page, set VITE_CAREERS_APPLY_URL, rotate leaked PAT.

## PENDING ROADMAP (in recommended order, from docs/cirqle-connect/IMPLEMENTATION_PLAN.md)

1. **Wave D — AI Assistant in chat** (~6-8 sessions): promote `src/lib/advertising/ai/registry/` (5 provider adapters exist: groq/openai/gemini/anthropic/ollama) to `src/lib/ai/registry`; permission-filtered context builders (conversation/task/client/project — run AS the requesting user's perms, hard token budgets); `runAssistant` with canned actions (summarize/minutes/extract actions-decisions-deadlines/draft reply/translate/create-task PROPOSALS that route through existing server actions — AI never writes directly); ✨ panel + /ai command; generalized `ai_usage` table + per-employee rate limits; Groq free default.
2. **Wave E — Knowledge Base**: kb_documents + revisions, kb_chunks federated FTS index (pgvector column empty until later), jobs-engine indexing, Ask bar with citations, ⌘K integration. Search permission-filter matrix is the highest-risk code — table-driven tests required.
3. **Wave F — Personal Workspace**: workspace_items, owner-only RLS (NO admin bypass — write the test first), planner Today/Tomorrow/Week, ⌘J quick-add, saved messages, pins, reminders via daily cron.
4. Chat polish: presence, typing indicators, web push (VAPID), message edit UI.
5. Small deferred: approval entry-point buttons on invoice/quotation pages (dialog accepts defaults), sequential approval chains, voice "played" status, timeline archive cron.
6. FUTURE_ROADMAP.md extras: automation rules engine, client approval portals, embeddings, digest emails, website prerender SEO.

## COST GUARDRAILS

Everything must stay ₹0/month on existing free tiers (Supabase free, Vercel Hobby, Groq free, Resend free) until DB >500MB → Supabase Pro $25/mo is the accepted first cost. No new paid services without asking me.

## HOW TO WORK

Analyze existing code before writing; reuse the systems above (no duplicate tables/notifications/permissions); create migrations as `migrations/0XX_*.sql` (never auto-apply to the live DB — I run them in Supabase SQL editor); keep everything mobile-responsive and dark-mode compatible (Tailwind tokens: bg-background, text-muted-foreground, border-border, bg-muted); verify with tsc/eslint/vitest before claiming completion; and give me terminal commands for anything requiring git or my machine.

**First task for the new session**: ask me what state deploy/migrations are in, then continue with whatever I report broken from live testing, or start Wave D.
