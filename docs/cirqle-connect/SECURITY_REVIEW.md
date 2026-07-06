# Cirqle Connect Phase 2+ — Security Review

Threat-model pass over the six features. Baseline security model (unchanged): Supabase Auth + middleware session gate, permission catalog checked in every server action, RLS on user-reachable tables, service-role client only server-side, tokenized portals for clients, security headers, fail-closed crons.

---

## 1. Universal Timeline

**Threats**: (a) information leakage across permission boundaries — a timeline aggregates data from modules the viewer may not be allowed to see; (b) audit-trail tampering.

**Controls**
- Single read path (`getTimeline()`); no client-side query against `activity_logs` and no anon/authenticated RLS read policy on the table at all (service-role only). One enforcement point = auditable.
- Category-level filtering: `finance`/`billing` rows require `timeline.view_finance`; global feed requires `timeline.view_all`; employee timelines other than self require `employees.view`. `detail` diffs for settings changes are admin-only (may contain sensitive values).
- Sentence templates render from structured fields — never raw user HTML → no stored-XSS path.
- Tamper resistance: writes are fire-and-forget inserts via service role; no update/delete API exists. For true append-only, the migration adds **no UPDATE/DELETE policies** and revokes those from `authenticated` — only a manual service-role operation (or the retention cron) can remove rows.
- Login events log metadata only (time, user) — never IPs/user-agents into a broadly visible timeline; those stay in Supabase Auth logs.

**Residual risk**: a writer passing the wrong scope (e.g. wrong client_id) leaks an event title cross-client. Mitigation: scope params are typed and derived from the entity row inside the action (not caller-supplied), plus review checklist in Wave A3.

## 2. AI Assistant

**Threats**: (a) data exfiltration to a third-party model; (b) permission bypass via AI ("summarize client X" by someone who can't open client X); (c) prompt injection from chat content; (d) cost abuse; (e) AI-initiated destructive writes.

**Controls**
- **Context builders are the boundary**: they run with the *requester's* permission set (`loadCurrentUser()` + `hasPermission()` inside each builder), hard row/token budgets, and an allowlist of fields (e.g. client context includes name/notes/status — never bank details or portal tokens). No builder = no data path. The model can only echo what the asking human could already read.
- **No direct writes**: assistant output that creates things returns a *proposal*; confirmation goes through the same server actions as manual creation (perms, activity log, notifications all apply). Worst-case injection outcome = a weird draft the user sees, not a mutation.
- Prompt injection: system prompt instructs the model to treat conversation content as data; but the real defense is structural (read-only + proposals) — we assume the model *can* be jailbroken and make that harmless.
- Every call recorded in `ai_usage` (who, feature, tokens, cost) → per-employee rate limit (default 20/hr) + daily token budget, both configurable in company_settings. `ai.use` permission can exclude roles entirely; `ai.configure` (provider/model/budgets) is admin-only.
- Provider keys live in env vars server-side only; Groq default. If the org later demands data-processing guarantees, the provider abstraction allows Ollama (self-hosted, data never leaves) with zero code change.
- Client-portal surfaces get **no AI access** in this design (assistant is dashboard-only).

## 3. Voice notes

**Threats**: audio disclosure to non-members; unbounded uploads; malicious file substitution.

**Controls**
- Bucket `voice-notes` is private; both upload and playback URLs are short-lived signed URLs issued by server actions that check conversation membership first. No public objects.
- Upload URL constrained: path is server-generated (no caller-chosen keys), size ≤ 6 MB, `chat.voice` permission, per-conversation rate sanity check.
- `sendVoiceMessage` verifies the object exists and its size/MIME before creating the message (prevents claiming someone else's path).
- Transcripts inherit message visibility (they live on the message row; kb_chunks carry `conversation_id` scoping). Transcription sends audio to Groq — same third-party consideration as §2; documented, and disableable per-workspace (`transcription_enabled` setting) for teams that object.
- Deletion: soft-deleted message → cleanup cron removes the storage object after 30 days (real erasure, not just hidden).

## 4. Approval engine

**Threats**: unauthorized decisions; history falsification; decision spoofing via chat card; orphaned approvals after entity deletion.

**Controls**
- Eligibility computed server-side per decision call (named employee / designation membership / permission key / `approvals.decide_all`), never trusted from the card UI. Requester can never approve their own request (explicit check, admins included — override requires a second admin).
- `approval_events` is append-only **at the database level**: no UPDATE/DELETE grants or policies for any role except service inserts. The decision on `approvals` (status, decided_by, decided_at) is written in the same transaction as its event row.
- Chat card buttons call the server action with the approval id; the action re-checks status (`pending` → decided once; concurrent decisions resolved by optimistic `where status='pending'` update — second writer gets a friendly "already decided").
- Entity deletion: delete actions for approvable entities check for open approvals (block or cascade-cancel with event); weekly integrity job flags orphans.
- `approvalEffects` callbacks run under service role — each effect re-validates entity state before acting (e.g. task must still be in `review` to close).

## 5. Knowledge base

**Threats**: the search index becoming a permission-bypass oracle (the classic federated-search failure); private workspace content leaking into team search; stale chunks exposing deleted content.

**Controls**
- Every chunk carries its scoping columns (`conversation_id`, `client_id`, `project_id`, `owner_id`, `requires_perm`). `searchKb` applies the filter matrix **per source type** before ranking: conversation chunks → membership check (batched); invoice chunks → `billing.view_invoices`; workspace chunks → `owner_id = me` (and excluded entirely from team-wide queries); restricted kb_documents → designation check. This matrix is the highest-risk code in the whole design → table-driven tests are a Wave E gate (IMPLEMENTATION_PLAN §risks).
- `askKb` builds its AI context ONLY from hits that already passed the search filter — the RAG path cannot see more than search does.
- Deletion propagation: source delete → `kb.index` job removes chunks (synchronous best-effort + nightly reconcile as backstop). Revisions of unpublished/archived docs drop out of the index on status change.
- kb_documents RLS: `kb.view` for published; drafts visible to author + `kb.admin`; `restricted_to_designation` enforced in both RLS and search filter (defense in depth).

## 6. Personal workspace

**Threats**: any visibility to anyone other than the owner — including admins (explicit requirement).

**Controls**
- RLS `owner_id = my employee id` on ALL commands, **deliberately no admin-bypass policy**; server actions also filter by owner (belt and braces). A dedicated test asserts an admin session cannot select another employee's rows even via the API layer.
- Workspace chunks in kb_chunks carry `owner_id` and are excluded from every non-owner query path; they exist only so the owner's own ⌘K search works.
- Saved messages store the message id, not a copy — if the source message is later deleted or the employee loses conversation membership, the saved item renders as "no longer available" (visibility re-checked at read time, not at save time).
- Reminders fire through `createNotification()` addressed only to the owner.
- Offboarding: archiving an employee leaves workspace rows in place (cascade delete on employee delete); they are unreachable by anyone. A documented service-role wipe script covers "delete my data" requests.

## 7. Cross-cutting

- **New attack surface** is almost entirely authenticated-dashboard-side; the only unauthenticated surface added is none (client portals gain nothing in this phase; portal chat from the Phase-1 plan keeps its token model).
- **SSE route** `/api/ai/assist`: session-checked like every dashboard route (middleware), plus `ai.use`; no token in URL.
- **Audit**: approvals, AI usage, and timeline give the org three independent audit trails; SECURITY events themselves (setting changed, employee archived, login) land in the timeline with admin-only detail.
- **Secrets**: no new client-exposed env vars (all provider keys server-side; `NEXT_PUBLIC_*` unchanged).
- **Dependency budget**: features add ~zero new runtime deps (MediaRecorder/Web Audio are browser APIs; waveforms are CSS; markdown rendering uses the existing pipeline) — no new supply-chain exposure.

**Sign-off checklist before build** (repeated in IMPLEMENTATION_PLAN): workspace-privacy test, search filter matrix tests, context-builder budget tests, approval eligibility tests, append-only verification on `approval_events` and `activity_logs`.
