# Cirqle Connect Phase 2+ — API Design

Convention (matches the existing codebase): **mutations = server actions** in `actions.ts` files colocated with pages; **cross-page reads = lib functions**; **HTTP routes only** for cron, webhooks, streaming and portal (tokenized) access. Every action starts with `loadCurrentUser()` → `hasPermission()` → work → `void logActivity()` → optional `createNotification()` → `revalidatePath()`.

---

## 1. Timeline

`src/lib/activity/` (extends existing module)

```ts
// log.ts — extended input (backward compatible)
logActivity({
  actorId?, subjectId?, entityType, entityId?, action, detail?, note?,
  category?,                                  // one of the 8 filters; derived from entityType if omitted
  clientId?, projectId?, taskId?, conversationId?,   // scope for entity timelines
})

// query.ts — NEW single read path (one enforcement point for perms)
getTimeline(scope: { clientId?|projectId?|taskId?|employeeId?|global: true },
            opts: { categories?: Category[], cursor?: string, limit = 30 })
  → { items: TimelineItem[], nextCursor }
// Rules: global requires 'timeline.view_all'
//        finance/billing categories stripped unless 'timeline.view_finance' (or admin)
//        employee scope: self always allowed; others require 'employees.view'
// TimelineItem = { id, icon, category, actor:{id,name,avatar}|null(system),
//                  action, sentence, entityType, entityId, href, detail, createdAt }
```

Writer coverage (~30 insertion points in existing actions — full checklist in IMPLEMENTATION_PLAN.md): client CRUD, project lifecycle, task lifecycle (already done), file upload/delete, invoice generate/send/paid, payment received, expense added, leave requests, employee join/login (via auth callback), settings changes, chat lifecycle + mentions, approvals, KB publishes.

## 2. AI Assistant

`src/lib/ai/` (promotes `advertising/ai/registry` → app-wide; advertising re-imports from here)

```ts
// registry (moved, unchanged interface): getAIProvider(id) → AIProvider.generate(prompt, payload, opts)

// context/ — THE security boundary. Each builder enforces perms itself.
buildConversationContext(conversationId, me, { messageLimit = 100 })  // requires membership
buildTaskContext(taskId, me)                                          // tasks.view_own/all
buildClientContext(clientId, me)          // profile always; invoices only with billing.view_invoices
buildProjectContext(projectId, me)        // advertising.view; stats with advertising.view_reports
buildEmployeeContext(me)                  // self only
// Every builder returns { text, tokensEstimate, sources[] } and truncates to a hard budget.

// assistant.ts
runAssistant({
  conversationId, action:            // canned action id or 'freeform'
    'summarize_today'|'summarize_unread'|'meeting_minutes'|'extract_actions'|'extract_decisions'
   |'extract_deadlines'|'create_task'|'create_project'|'draft_reply'|'rewrite'|'translate'
   |'generate_checklist'|'generate_sop'|'generate_followup'|'invoice_note'|'suggest_next'|'freeform',
  prompt?, targetLanguage?, entityRefs?  // explicit extra context: taskIds, clientId…
}) → { kind:'text', content } | { kind:'proposal', proposal } | { kind:'job', jobId }
// Guards: 'ai.use' perm; per-employee rate limit (default 20/hr, from company_settings);
//         daily token budget check against ai_usage; every call recorded in ai_usage.
```

**Proposals, not silent writes:** `create_task` / `create_project` return a structured proposal the user confirms in UI; confirmation calls the **existing** task/project server actions (perms + activity + notifications fire exactly as if created manually). The AI never mutates CRM data directly.

Long-running actions enqueue `{job_type:'ai.assist'}`; the worker posts the result as a `kind='ai'` message (visible to the whole conversation, marked with the requesting user + action).

HTTP: `POST /api/ai/assist` (thin wrapper for the chat panel; streaming Groq responses via SSE when `sync=true` and context is small).

## 3. Voice notes

```ts
// src/app/(dashboard)/dashboard/chat/actions.ts (Phase-1 file, extended)
createVoiceUploadUrl({ conversationId, durationMs, sizeBytes })
  → { signedUploadUrl, storagePath }        // membership + 'chat.voice' + caps (≤5 min, ≤6 MB)
sendVoiceMessage({ conversationId, storagePath, durationMs, peaks: number[64] })
  → messages insert kind='voice' → enqueue {job_type:'voice.transcribe'} → realtime delivers
getAttachmentUrl({ attachmentId })          // membership-checked signed URL (60 min)

// jobs worker: voice.transcribe
// download from storage → Groq Whisper (whisper-large-v3-turbo, free) →
// update message.metadata.transcript(+Status) → kb.index job → done.
// Retry ×3 then transcriptStatus='failed' (note remains playable).
```

## 4. Approval engine

`src/lib/approvals/`

```ts
requestApproval({
  entityType, entityId, title, description?,
  approver: { employeeId } | { designationId } | { permission },
  conversationId?,             // post card into this conversation (default: entity's room)
  attachmentId?, dueAt?, clientId?, projectId?, taskId?,
}) → { approvalId, messageId }
// 'approvals.request' • inserts approval + 'requested' event + kind='approval' message
// • notifies eligible approvers (source_key = approval:<id>:requested)

decideApproval({ approvalId, decision: 'approved'|'rejected'|'changes_requested', comment? })
// eligibility: named approver, designation member, permission holder, or 'approvals.decide_all'
// • updates status + decided_by/at • appends event • notifies requester
// • fires approvalEffects[entityType]?.(decision, entity) — e.g. task_completion→close task
// • logs to timeline with the entity's scope

commentOnApproval({ approvalId, comment })
addApprovalVersion({ approvalId, attachmentId })     // version_no auto-increments; reopens if changes_requested
cancelApproval({ approvalId })                        // requester or admin
getApprovals({ view: 'awaiting_me'|'my_requests'|'entity', entityType?, entityId?, cursor? })
getApprovalHistory(approvalId) → events with actors  // renders history + version list
```

`approvalEffects` map (one file, `src/lib/approvals/effects.ts`) is the only place entity-specific behavior lives.

## 5. Knowledge base

```ts
// src/lib/kb/
createDocument({ title, body, folder, tags, docType, restrictedToDesignation?, clientId?, projectId? }) // kb.edit
updateDocument({ id, ...fields })     // kb.edit • snapshots previous body into kb_document_revisions
publishDocument({ id }) / archiveDocument({ id })   // kb.edit / kb.admin
getDocument / listDocuments({ folder?, tag?, q?, status? })   // kb.view + designation scoping

searchKb({ q, types?: SourceType[], clientId?, projectId?, limit = 20 })
  → { hits: { sourceType, sourceId, title, snippet, href, rank, date }[] }
// FTS with rank + recency boost. Permission filter applied per hit type:
//   requires_perm column checked against caller's set; owner_id chunks only for owner;
//   conversation chunks require membership (batched check).

askKb({ q, clientId?, projectId? })   // 'ai.use' + 'kb.view'
  → { answer, citations: Hit[] }
// = searchKb top-K → buildKbAnswerContext (bounded) → AIProvider → answer with citations.
// This is the "How do we generate Meta reports?" endpoint. Zero embedding cost (FTS retrieval).

// jobs: kb.index {sourceType, sourceId} upserts chunks; kb.reconcile nightly sweep.
```

⌘K palette gains two sections backed by `searchKb` (team) and workspace search (personal).

## 6. Personal workspace

```ts
// src/app/(dashboard)/dashboard/workspace/actions.ts — all owner-scoped; RLS enforces even if code slips
createItem({ kind, title?, body?, metadata?, entityType?, entityId?, plannedFor?, remindAt? })
updateItem({ id, ...fields }) / toggleDone({ id }) / reorderItems({ ids }) / deleteItem({ id })
getWorkspace({ view: 'today'|'tomorrow'|'week'|'notes'|'drafts'|'saved'|'pins'|'reminders'|'all', q? })
saveMessageToWorkspace({ messageId })        // membership check → kind='saved_message'
pinEntity({ entityType, entityId })          // entity-visibility check → kind='pin'

// cron sweep (rides existing daily cron): remind_at <= now() and reminded_at is null
//   → createNotification(owner, type:'workspace_reminder', source_key:'ws:<id>') → set reminded_at
```

## 7. Realtime & routes summary

| Surface | Mechanism |
|---|---|
| Approval card updates, AI messages, voice messages | existing per-open-conversation `postgres_changes` sub (they're just messages) |
| Timeline tabs | plain paginated queries (no live tail v1) |
| Workspace | plain queries (single-user data) |
| New crons | none required — reminder sweep + kb.reconcile ride existing daily crons; voice cleanup joins `cleanup-reports` |
| New HTTP routes | `POST /api/ai/assist` (SSE streaming) only |

## 8. New permission keys (seeded like migrations/005)

```
timeline.view_all        timeline.view_finance
ai.use                   ai.configure
approvals.request        approvals.decide_all
kb.view                  kb.edit        kb.admin
chat.voice               (+ Phase-1: chat.access, chat.create_channels, chat.moderate, chat.client_conversations)
```

Middleware `ROUTE_PERMS` additions: `/dashboard/workspace` → none (self), `/dashboard/kb` → `kb.view`, `/dashboard/approvals` → none (own inbox), `/dashboard/chat` → `chat.access`.
