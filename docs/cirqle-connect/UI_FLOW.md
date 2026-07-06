# Cirqle Connect Phase 2+ — UI Flows

All UI reuses the existing kit: Radix primitives, `employee-avatar`, toasts, ⌘K palette, dark-mode tokens, `page-shell`, mobile bottom-nav pattern. New shared components are listed in §7.

---

## 1. Universal Timeline

**Where it appears** — a `Timeline` tab added to four existing detail surfaces:

- Client detail page → tab strip: Overview · Tasks · Billing · **Timeline**
- Project detail (`/dashboard/advertising/[id]`) → existing tab row + **Timeline**
- Task edit modal → footer accordion "Activity" (compact variant, reuses same component)
- Employee profile (`/dashboard/employees/[id]`) → **Timeline** tab (self-view allowed for every employee)
- Plus a global feed at `/dashboard/activity` (admins / `timeline.view_all`)

**Row anatomy** (one line, 44 px, hover reveals actions):

```
[category icon] [avatar|gear] Farooq changed status of Task #T-1042 to Done   · 2h ago
                              └─ blue link → opens task modal
```

- Icon = category (tasks ✓, billing ₹, chat 💬, files 📎, advertising 📣, crm 👥, employees 🧑, finance 🏦) using lucide icons already in the bundle.
- Sentence templates per `entity_type+action` live in one `timelineCopy.ts` map; `detail` diffs render as an expandable "what changed" section (field · from → to).
- Click target = deep link (`href` from API). Deleted targets render struck-through, non-clickable.

**Filters**: horizontal chip row (All · Tasks · Billing · Chat · Files · Advertising · CRM · Employees · Finance). Chips the viewer lacks permission for (Finance without `timeline.view_finance`) are hidden entirely, not disabled. Infinite scroll, 30/page, "Today / Yesterday / date" section headers.

## 2. AI Assistant in chat

**Entry points** (inside any conversation):

1. **✨ button** in the composer toolbar → opens right-side panel (dashboard 3-pane becomes 4th pane on ≥1280px; sheet overlay below).
2. **`/ai` slash command** → inline autocomplete listing canned actions.
3. **Message context menu** → "Summarize thread", "Create task from this", "Draft reply".

**Panel layout**:

```
┌─ AI Assistant ────────────── ✕ ─┐
│ Context: #seastar-project ⓘ     │  ⓘ popover = exactly what the AI can see
│ ┌ quick actions grid ─────────┐ │  (transparency = trust)
│ │ Summarize today  Minutes    │ │
│ │ Action items     Decisions  │ │
│ │ Draft reply      Translate  │ │
│ └─────────────────────────────┘ │
│ [streamed answer area]          │
│ ┌ proposal card (if any) ─────┐ │
│ │ 📋 New task: "Send Ramadan  │ │
│ │ flyer v2 to client"         │ │
│ │ due: Thu · client: Sea Star │ │
│ │ [Create task] [Edit] [✕]    │ │  ← Create calls the normal task action
│ └─────────────────────────────┘ │
│ [Ask anything about this chat…] │
└─────────────────────────────────┘
```

- Answers stream token-by-token (SSE). "Insert into composer" and "Post to conversation" buttons on every answer; posting creates a `kind='ai'` message rendered with a subtle ✨ border + "AI · requested by Farooq" caption so nobody mistakes it for a human.
- Long jobs show a progress toast; result arrives as an ai-message via Realtime.
- Rate-limit hit → friendly inline notice with reset time.

## 3. Voice notes

**Composer**: mic button right of the text field.

- **Hold** → recording starts: composer morphs into `● 0:12 ── waveform growing ──  ‹ slide to cancel`
- **Slide left** past threshold → cancel (haptic on mobile).
- **Release** → instant send (upload already streaming in background).
- **Slide up / tap lock icon** → hands-free mode with pause + Send/Delete buttons (max 5:00, countdown at 4:30).

**Message bubble**:

```
▶ ▮▮▂▂▅▅▇▇▅▂▮▮▂▅▇▅▂  0:47   1.5×  ⤓
   "…client said the flyer colors should be…"  [show transcript]
```

- 64-bar waveform from stored peaks (pure CSS bars — no audio decode needed to render), progress fill during playback, scrub by drag.
- Speed toggle 1× → 1.5× → 2×. Download via signed URL. Transcript collapsed by default; "Transcribing…" shimmer while the job runs; searchable once done (search hits deep-link to the message and auto-expand the transcript).

## 4. Approvals

**Chat card** (`kind='approval'` message):

```
┌ 🟡 Approval requested ─────────────────────┐
│ Ramadan flyer v3 — Sea Star                │
│ requested by Fathima · due Thu             │
│ [🖼 preview thumbnail]         v3 · history │
│ ┌───────────┬──────────┬─────────────────┐ │
│ │ ✓ Approve │ ✕ Reject │ ✎ Request changes│ │
│ └───────────┴──────────┴─────────────────┘ │
│ 💬 Add comment                             │
└────────────────────────────────────────────┘
```

- Buttons visible only to eligible approvers (everyone else sees status + history link).
- Decision → card flips to 🟢 Approved by Farooq · 2m ago (live via Realtime); comment thread renders under the card as normal thread replies.
- "history" → sheet with the full immutable event list + version gallery (v1/v2/v3 side-by-side for designs).

**Approvals inbox** `/dashboard/approvals`: two tabs (Awaiting me · My requests), each a table with status pill, entity link, age, due date; row click opens the same card in a sheet. Badge count on the sidebar item = pending awaiting-me.

**Requesting**: "Request approval" appears in file lightbox, invoice actions menu, quotation actions, task complete flow (optional per-settings), campaign detail, expense form, and chat attachment context menu — all opening one shared `RequestApprovalDialog` (entity pre-filled, pick approver rule + conversation + due date).

## 5. Knowledge base

`/dashboard/kb` — two-pane:

- **Left**: folder tree (materialized paths) + tag cloud + type filter (Doc/SOP/Policy/Meeting notes/Template) + New doc button (`kb.edit`).
- **Right**: document view (rendered markdown, author/updated meta, revision history dropdown with diff view) or editor (plain markdown textarea + preview toggle — no heavy WYSIWYG dependency).

**Ask bar** at the top (the differentiator):

```
🔍  Ask anything… "How do we generate Meta reports?"
     ├─ Answer (AI, with confidence caveat)
     │   "Meta reports are generated from Advertising → Reports…  [1][2]"
     │   sources: [1] SOP: Monthly Meta reports  [2] #advertising 12 Mar
     └─ Matches (plain search hits grouped by type: Docs · Chats · Tasks · Files · Invoices)
```

Plain hits are instant (FTS); the AI answer streams in after (skippable). Same search embedded in ⌘K under "Knowledge".

## 6. Personal workspace

`/dashboard/workspace` — sidebar item "My Space" (always visible, no permission).

Layout: personal three-column board (responsive → stacked):

```
┌ Today ─────────────┐ ┌ Notes & Drafts ────┐ ┌ Pinned ───────────┐
│ ☐ Send flyer v2    │ │ 📝 Scratchpad      │ │ ⭐ Task T-1042     │
│ ☐ Call Mezza 4pm ⏰ │ │ 📝 Ramadan ideas   │ │ ⭐ Sea Star (client)│
│ ☐ Review approval  │ │ ✉ Draft: reply to… │ │ ⭐ #seastar-project │
│ + add              │ │ + new note         │ │ 🔖 Saved messages 7 │
└────────────────────┘ └────────────────────┘ └───────────────────┘
   tabs: Today · Tomorrow · This Week · All
```

- Quick-add everywhere: `⌘J` global shortcut opens a quick-note popover from any page (saves to workspace).
- Reminders: any item gets a ⏰ (date-time picker) → bell notification via the daily sweep; overdue items float to top in red.
- Saved messages: bookmark icon on hover of any chat message ("Save for later") — Slack-style.
- Pins: star icon on task rows, client header, project header → appears in Pinned column as a live mini-card (status, next due).
- Scratchpad: one always-existing markdown pad, autosaved, ⌘J⌘J opens it.
- Drafts: composer "save as draft" → resumes with one click; drafts listed here.
- Everything searchable in the page's search field and in ⌘K under "Personal".

## 7. New shared components

| Component | Used by |
|---|---|
| `<TimelineTab scope filters variant>` | client/project/task/employee pages + global feed |
| `<ApprovalCard>` / `<RequestApprovalDialog>` / `<ApprovalHistorySheet>` | chat, inbox, entity pages |
| `<VoiceRecorderButton>` / `<VoiceBubble>` | chat composer / message list |
| `<AiPanel>` / `<AiProposalCard>` / `<AiMessage>` | chat |
| `<KbSearchBar>` (with AI answer slot) | KB page, ⌘K |
| `<WorkspaceQuickAdd>` (⌘J) | global |
| `<EntityPinButton>` | task rows, client/project headers |

**Mobile**: chat panes stack (list ↔ thread ↔ AI sheet); voice recording is the flagship mobile interaction (hold mic); workspace board becomes swipeable tabs; approval buttons are thumb-reach at card bottom; employee bottom-nav gains My Space.
