# Cirqle Connect Phase 2+ — Implementation Plan

Prerequisite: **Chat Phases 1–2 from CHAT_MODULE_PLAN.md** (conversations, messages, attachments, mentions, notifications, FTS). Several Phase-2+ features ride on those tables. Timeline (Wave A) has *no* chat dependency and can start immediately — even before chat ships.

Estimates are in working sessions (a focused half-day). Waves are independently shippable; stop or reorder at any boundary.

---

## Wave A — Universal Timeline (no dependencies) — **4–6 sessions**

| # | Work | Notes |
|---|---|---|
| A1 | Migration: extend `activity_logs` (columns, indexes, backfill) | 0.5 |
| A2 | Extend `logActivity()` + `timelineCopy.ts` sentence map + `getTimeline()` read path with perm filtering | 1 |
| A3 | Writer sweep: ~30 `void logActivity(...)` insertions across existing actions (clients, invoices, files, settings, auth callback, employees, quotations, leave) | 1.5 — checklist below |
| A4 | `<TimelineTab>` component (rows, chips, pagination, detail-diff expander) | 1.5 |
| A5 | Mount on 4 surfaces + global `/dashboard/activity` + perms (`timeline.view_all`, `timeline.view_finance`) seeded | 1 |
| A6 | Verify: unit tests for perm filtering + sentence map; seed-data visual pass | 0.5 |

Writer checklist (A3): clients create/update/archive · invoice generate/send/paid/overdue · payment received (cashbook inflow) · expense added · file upload/delete · quotation lifecycle · leave request/approve · employee created/archived/designation-changed (exists) · login (auth callback) · company_settings change · import runs · advertising project create/assign/status.

## Wave B — Approval engine (needs chat Phase 1 for cards; inbox works without) — **5–7 sessions**

B1 migration (approvals + events + RLS) 0.5 · B2 lib actions + `approvalEffects` map 1.5 · B3 `RequestApprovalDialog` + entry points (files, invoices, quotations, tasks, expenses, campaigns) 1.5 · B4 chat `ApprovalCard` (kind='approval' message + live update) 1 · B5 inbox page + sidebar badge + notifications 1 · B6 version history (version_added events + gallery sheet) 1 · B7 tests (state machine, eligibility matrix) 0.5

## Wave C — Voice notes (needs chat Phase 1) — **4–5 sessions**

C1 bucket + kind='voice' + composer recorder (hold/slide/lock, peaks capture) 2 · C2 `VoiceBubble` playback (waveform, speeds, download) 1 · C3 transcription job (Groq Whisper) + transcript UI + `body_search` redefinition 1 · C4 cleanup cron extension + caps + tests 0.5–1

## Wave D — AI Assistant (needs chat Phase 1; better after Wave A for timeline logging) — **6–8 sessions**

D1 registry promotion (`lib/ai/registry`) + `ai_usage` migration + compatibility view 1 · D2 context builders (conversation, task, client, project) with perm checks + token budgets + unit tests 2 · D3 `runAssistant` + rate limiting + canned actions 1.5 · D4 `AiPanel` UI + slash command + streaming SSE route 1.5 · D5 proposal flow (create task/project through existing actions) 1 · D6 async path via jobs engine + `kind='ai'` messages 0.5–1

## Wave E — Knowledge base (needs jobs engine; AI answer needs Wave D) — **6–8 sessions**

E1 migration (kb_documents, revisions, kb_chunks, pgvector ext) 0.5 · E2 kb.index / kb.reconcile jobs + writer hooks (messages, tasks, docs, transcripts, invoice notes) 1.5 · E3 `searchKb` with per-type perm filtering + tests 1.5 · E4 KB page (tree, editor, revisions) 2 · E5 Ask bar (`askKb` = FTS-RAG with citations) 1 · E6 ⌘K integration 0.5

## Wave F — Personal workspace (independent; saved-messages needs chat) — **4–6 sessions**

F1 migration + RLS (owner-only, verified by test that admin CANNOT read) 0.5 · F2 actions + reminder sweep on daily cron 1 · F3 workspace page (board, planner tabs, scratchpad, drafts) 2 · F4 global ⌘J quick-add + pin buttons + save-message + ⌘K "Personal" 1 · F5 kb_chunks owner-scoped indexing 0.5

---

## Recommended order & combined timeline

```
        ┌ Wave A (Timeline) ────┐                    no chat needed — START HERE
Chat P1 ┤                       ├ Wave B (Approvals) ┐
        └ Chat P2 (mentions…)   ├ Wave C (Voice)     ├ Wave E (KB) → Wave F polish
                                └ Wave D (AI)        ┘
```

1. **Wave A first** — immediate visible value, zero risk, forces the "every action logs" discipline the rest depends on.
2. Chat Phase 1–2 (from the approved plan).
3. **Wave B** (approvals) — highest business value per effort for an agency (client work sign-off).
4. **Wave C** (voice) — high delight, small scope.
5. **Wave D** (AI) then **Wave E** (KB, reuses D) then **Wave F** (workspace — anytime filler between waves).

Total: **29–40 sessions** on top of the chat plan's 13–19. At 3–4 sessions/week ≈ **2.5–3.5 months** for everything. Each wave lands a complete, usable feature.

## Performance impact

- Timeline: fire-and-forget inserts (~1–5 ms, never awaited) — zero hot-path latency; reads are single index scans.
- kb_chunks indexing: async via jobs engine; nightly reconcile is off-peak. GIN index updates add ~ms to the worker, not to users.
- Voice: upload streams in background during recording; transcription async. No render-path cost (peaks precomputed).
- AI: streaming responses; heavy jobs queued. Rate limiter is one indexed count on `ai_usage`.
- The `messages.body_search` redefinition (C3) rewrites the column — run once, off-peak; table will still be small when this lands.
- No new always-on Realtime subscriptions (see API_DESIGN §7) — connection budget unchanged.

## Riskiest items (tackle inside their wave, first)

1. **RLS on workspace privacy** (F1) — write the "admin cannot read" test before the UI exists.
2. **Perm-filtered search** (E3) — the per-hit-type filter matrix is the most subtle logic in the set; test matrix required.
3. **Context builder budgets** (D2) — token truncation correctness prevents both cost surprises and context overflow errors.
4. **Approval eligibility matrix** (B2) — three approver rule types × override perm; table-driven tests.
