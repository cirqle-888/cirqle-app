# Cirqle — External Request Portal
### Architecture & Workflow Design Document (for approval)

**Status:** Proposal — no code written yet. **Revision 2** (owner-approved decisions folded in).
**Author:** Design phase
**Decisions locked in by owner:**
- Attachments = **Google Drive / external links only** for v1 (real uploads later).
- Share links = **both** per-client links **and** a generic intake link.
- Promotion = **Start → open Add Task prefilled** (never auto-create).
- **Agencies = a real, required entity** (`agencies` table in v1).
- **Full status system** (the complete set in §3).
- **Basic notifications only** in v1 — and **no noisy in-app notification system** (see §10).
- **"Track My Requests"** included in v1 for clients and agencies.

**Two principles added in Rev 2 (override anything that conflicts below):**
1. **Timeline-first.** The **request activity timeline is the source of truth**
   and the primary communication/review surface. We do **not** build an
   app-wide popup/alert notification system. Staff awareness comes from
   **inbox row indicators** (unread/new-external-activity), not popups.
2. **Strict external visibility.** Every timeline entry carries a **visibility
   level** (`internal` / `client` / `agency`). Clients and agencies see **only
   external-facing** entries and statuses — never internal operations
   (assignments, employee names, contributions, pricing, billing, payroll,
   internal notes/status). Default for any entry is **`internal`**.

**Non-negotiable principle:** This is a **separate, additive module**. Until a
request is intentionally promoted into a real task, it must **not** appear in or
affect Tasks, Contributions, Payroll, Invoices, or Reports. The current system
stays exactly as it is.

---

## 0. Executive Summary

External users (clients, agencies, marketing partners) submit work requests
through a **public, login-free, tokenized portal**. Submissions land in a
**Requests Inbox** that is completely isolated from the live task system. An
admin reviews, then clicks **Start**, which opens the existing **Add Task**
modal pre-filled from the request. Only when **Create Task** is pressed is a
**task number assigned** and the item enters the normal Cirqle workflow.

The build reuses three things Cirqle already has:
1. The **`portal/[token]`** public-route pattern (no auth, token-validated, data-isolated).
2. The **permissions catalog** (`permissions` + `designation_permissions`).
3. **Resend** email (already wired for payslips) for the **few** v1 emails.

**Communication model (Rev 2):** the **request activity timeline is the source
of truth and the primary review surface.** There is **no** app-wide notification
system, no popups, and no dashboard alert cards — staff awareness comes from
**inbox row indicators** + a single **sidebar Requests badge**. Every timeline
entry has a **visibility level** (`internal`/`client`/`agency`) so clients and
agencies see only external-facing updates, never internal operations.

Nothing in this module touches existing tables' behaviour; it only **reads**
clients/services for convenience and **writes** a brand-new task at promotion
time via the existing Add Task path.

---

## 1. Client Portal Flow

**Public URL:** `app.cirqle.work/intake/{token}`
(separate route segment `src/app/intake/[token]/` — outside `(dashboard)`, no sidebar, no auth)

A client opens their link and sees a clean, Cirqle-branded page with two areas:

**A. Submit a request** (form):
- Title *(required)*
- Description
- Remarks
- Design plan (free text)
- Priority — Low / Normal / High / Urgent
- Due date
- **Links** (Drive-first):
  - Content folder link
  - Reference folder link
  - Final deliverables link *(usually filled later)*
  - Additional links (repeatable list)
- Service *(optional — a simple picker of active services, so you can pre-route)*

**B. Track my requests** (list — see §3):
- The token resolves to one client → the page shows **only that client's** requests with live status chips. No other client's data is queryable on this page.

**What the client never sees:** tasks, payroll, pricing, employees, invoices,
reports, or any other client. The page only ever queries `task_requests`
filtered by the token's `client_id`.

---

## 2. Agency / Partner Portal Flow

Same public pattern, different token **type** (`agency`). Reuses the identical
route and form with agency-oriented copy.

An agency/partner can:
- Submit requests **and future / planned campaigns** (a "planned" toggle + a target date — planned items simply sit in the inbox until you start them; they never enter Tasks early).
- Submit content, references, design plans, and **revision requests** against an existing request.
- See only **their own** submissions (token scoped to `agency_id`).

**Isolation:** an agency token can never see another agency's items, nor any
internal data. Enforced server-side: every read/write is filtered by the
token's resolved `agency_id`; there is no cross-tenant query on the public page.

---

## 3. Client / Agency Status Tracking

A **client-facing status model** (what the external user sees), mapped from the
internal status. Recommended set and meaning:

| Client-facing label | Internal status | When it shows |
|---|---|---|
| Request Submitted | `submitted` | On submit |
| Under Review | `under_review` | Admin opened/triaged it |
| Approved | `approved` | Admin accepted it (pre-start) |
| Started | `started` | Admin clicked Start (task being created) |
| In Progress | `in_progress` | Promoted task is in progress (mirrored from task) |
| Waiting for Content | `waiting_for_content` | Admin is blocked on the client |
| Revision Requested | `revision_requested` | A revision was raised |
| Completed | `completed` | Promoted task done |
| Delivered | `delivered` | Final delivered |
| *(internal only)* | `rejected`, `archived` | Not shown as active to client |

**Recommendation:** keep **one** `status` column on `task_requests` with the
above enum. After promotion, `in_progress / completed / delivered` are **mirrored
from the linked task's status** (a tiny sync on task status change) so the client
always sees the truth without you double-updating. `waiting_for_content` and
`revision_requested` are **request-only** states you set manually.

Each request also carries a short **public reference** (e.g. `REQ-0042`) shown to
the client for support/tracking. Generic-link submitters (who aren't tied to a
client record) get a **per-request tracking link** (`/intake/track/{ref-token}`)
emailed to them, so they can still follow status without exposing the client list.

### What clients/agencies see vs. what stays internal  *(Rev 2)*

**Confirmed: the full status system is used internally.** But only the
**external-facing** subset is ever shown on the tracking portal:

| Shown to client/agency | Hidden (internal only) |
|---|---|
| Request Submitted | Employee assigned / changed |
| Under Review | Contribution / scoring activity |
| Waiting for Content | Internal remarks & discussions |
| Started | Internal status changes / task management |
| In Progress | Pricing / billing / payroll actions |
| Revision Requested | Internal notes (`internal_notes`) |
| Completed | Any employee names |
| Delivered | Any financial data |

The portal renders status from a **`client_status`** projection — a clean map of
the internal `status` onto the labels above. Internal-only transitions (e.g.
"assigned to CQID002", "billing set", "contribution scored") **never** change
`client_status` and **never** produce a client-visible timeline entry. They live
in the internal timeline at `visibility = internal` (see §8).

---

## 4. Requests Inbox

**Recommended UX:** a dedicated nav item **"Requests"** (with an unread-count
badge) **plus** a **"Requests" button on the Tasks page header** — both open the
same inbox. The sidebar item is the primary home; the Tasks-page button is the
quick jump you asked for. Label: **"Requests"** (shorter than "External
Requests"; the page subtitle clarifies "External submissions").

The inbox is a separate page (`/dashboard/requests`) with tabs:

| Tab | Internal statuses included |
|---|---|
| **New** | `submitted` |
| **Reviewed** | `under_review` |
| **Approved** | `approved` |
| **Started** | `started`, `in_progress`, `waiting_for_content`, `revision_requested`, `completed`, `delivered` |
| **Rejected** | `rejected` |
| **Archived** | `archived` |

Each row: ref, title, client/agency, priority, due date, source link, age,
status chip, and actions (Open · Review · Approve · **Start** · Reject ·
Archive). Opening a request shows full details, the **links**, and the
**activity timeline** (§8).

**New-external-activity indicator (Rev 2 — replaces popups).** Because we do
**not** push app-wide notifications, each inbox row signals when a client/agency
has acted since staff last looked:
- a **● dot + "New Client Update" / "New Agency Update"** label, and/or
- an **unread activity count** (e.g. `▲ 3`), and
- **"Last update: Client"** vs **"Last update: Staff"** on the row.

This is computed per request from the timeline:
`has_new_external = last_external_activity_at > last_staff_viewed_at`
(fields defined in §11). Opening the request clears it (updates
`last_staff_viewed_at`). The sidebar **"Requests"** badge counts requests with
new external activity — that is the *only* global indicator; no toasts, no
dashboard alert cards.

**Crucially:** this page reads **only** `task_requests` — it is not a filter on
the Tasks list, so planned/future requests can never leak into Tasks,
Contributions, Payroll, Reports, or Invoices.

---

## 5. Request → Task Promotion Flow

**Start does NOT create a task.** It opens the existing **Add Task** modal,
**pre-filled** from the request:

| Request field | Pre-fills Add Task |
|---|---|
| Client | Client |
| Title | Title |
| Description | Description |
| Remarks | Appended to Description (or internal note) |
| Due date | Task Date *(or a separate due field if added later)* |
| Links (content/reference/deliverables/extra) | Carried into Description as a "Reference Links" block *(future: a structured `task_links` table)* |
| Priority | Carried as a note *(tasks have no priority field today; future-optional)* |
| Service *(if the client picked one)* | Service |

You review/adjust (service, billing, qty — billing still follows the Pricing
Matrix exactly as today). **Only on Create Task:**
1. Next **task number** is assigned (existing logic).
2. Task is created through the **existing Add Task path** (no new task logic).
3. `task_requests.promoted_task_id` is set; status → `started`; `promoted_at` /
   `promoted_by` recorded; activity logged.
4. Optional client notification ("Your request has started").

### Workflow diagram

```
 EXTERNAL USER (no login)
        │  opens /intake/{token}
        ▼
 ┌─────────────────────┐
 │  Submit Request     │  title, desc, remarks, plan, links, due, priority
 └─────────┬───────────┘
           ▼
 task_requests (status = submitted)         ← NOT in Tasks/Contributions/Payroll
           │
           ▼
 ┌─────────────────────┐
 │  REQUESTS INBOX      │  admin reviews
 │  New→Reviewed→Approved│
 └─────────┬───────────┘
           │ click  ▼  "Start"
 ┌─────────────────────────────┐
 │ Add Task modal (PRE-FILLED) │  admin edits service / billing / qty
 └─────────┬───────────────────┘
           │ click  ▼  "Create Task"
   ┌───────────────────────────┐
   │  Task number assigned      │
   │  Real task created         │ ──► enters EXISTING workflow
   │  request.promoted_task_id  │      (Contributions, Payroll, Invoices…)
   │  request.status = started  │
   └───────────────────────────┘
```

---

## 6. Attachments Strategy (v1 = links only)

No file uploads in v1. The request stores **link fields**:
- `content_link`
- `reference_link`
- `deliverables_link`
- `drive_folder_link` (the per-client Drive folder, §7)
- `extra_links` (JSON array of `{label, url}`)

**Primary method:** Google Drive links. The same fields accept **WeTransfer /
Dropbox / OneDrive** URLs with zero schema change — they're just URLs. A small
helper can detect the provider from the URL to show the right icon.

**Future (no redesign needed):** add a `request_attachments` table + Supabase
Storage bucket; uploaded files become an *additional* source alongside the link
fields. See §14.

---

## 7. Dedicated Google Drive Folder Structure

**Convention (per client → per project):**
```
Clients/
 ├── 015 Sea Star Supermarket/
 │    ├── 2026-06-15 Weekend Sale/
 │    │     ├── Content/
 │    │     ├── References/
 │    │     └── Deliverables/
 │    └── 2026-06-22 Summer Offer/
 └── 020 B.N. Mart Supermarket/
      └── 2026-06-08 Fresh Harvest/
```
- Folder name = `{client-code} {client-name}` at the top level (code disambiguates same-name clients, matching the app).
- Project folder = `{YYYY-MM-DD} {request/task title}`.
- Three subfolders: **Content** (client uploads), **References**, **Deliverables** (you upload finals).

**Where the link lives:** store **only** the folder URL — on the **client**
(`clients.drive_folder_link`, the per-client root) and/or on the **request**
(`task_requests.drive_folder_link`, the project folder). The app is the index;
no files in the DB.

**Security recommendations:**
- Prefer **per-client root folders** (never one shared root) so a client link
  exposes only their own projects.
- "Anyone with the link can **edit**" is convenient for the **Content** subfolder
  — but treat the link as a **secret**. If it leaks, anyone with it can edit.
- Keep **Deliverables** as **view-only** (or a separate share) so finals can't be
  altered by the client.
- No PII or pricing in folder names.

**Long-term archive strategy:**
- On `delivered`, move the project folder to `Archive/{year}/{client}/…` and set
  it **view-only**. Keep the stored link (it survives the move within the same
  Drive).
- Quarterly: review and archive stale "Content" folders.

**Best practices:** one naming convention enforced by the app (it can *suggest*
the folder name from client + date + title); a single owning Google account /
Shared Drive; the app holds the canonical link so nobody hunts through Drive.

**Future:** a Google Drive **service account** can auto-create the project folder
at promotion time and write the link back — additive, no schema change.

---

## 8. Activity Timeline — the primary review & communication surface  *(critical)*

**This is the heart of the module (Rev 2).** Every external or internal action
writes an immutable row to **`request_activity`**. Because actors can be
**non-employees**, this is a **dedicated** audit table (separate from the
internal `activity_log`). The timeline is the **source of truth** for what
happened, who did it, and what's externally visible — and it replaces a
notification system, not supplements one.

**Every entry carries a `visibility` level:** `internal` | `client` | `agency`.
- **`internal`** — staff-only. The **default for every entry.**
- **`client`** — shown on that client's tracking portal.
- **`agency`** — shown on that agency's tracking portal.

Staff can flip an entry's visibility, or post a deliberately **client-/agency-
visible** update (e.g. "Waiting for your content"). Nothing reaches an external
user unless its visibility is set to their type.

**Default visibility by action:**

| Action | Default visibility |
|---|---|
| Client/agency submitted the request | `client` / `agency` |
| Client/agency added/changed link, remark, due date, content | `client` / `agency` *(their own action, echoed back to them)* |
| Client/agency requested a revision | `client` / `agency` |
| Status → Under Review / Waiting for Content / Started / In Progress / Revision Requested / Completed / Delivered | `client` / `agency` *(external-facing milestones)* |
| Employee assigned/changed, contribution scored, billing/pricing set, internal note, internal status, promotion details, task linkage | **`internal`** |

**Internal full timeline view** (staff, in the inbox detail) shows **all** entries:
```
12-Jun 10:15  [client]    Client added content link
12-Jun 11:22  [client]    Client changed due date  (15 Jun → 18 Jun)
12-Jun 14:05  [internal]  Assigned to CQID002            ← hidden from client
12-Jun 14:40  [internal]  Billing set ₹750 (Pricing Matrix) ← hidden from client
13-Jun 09:10  [internal]  Started → Task #1745
13-Jun 09:11  [client]    Status: Started
```
**Client tracking view** of the same request shows only the `client` rows:
```
12-Jun 10:15  You added a content link
12-Jun 11:22  You changed the due date to 18 Jun
13-Jun 09:11  Status: Started
```

**Every client/agency action creates an entry** (added link, updated remarks,
changed links, changed due date, submitted a revision, updated details) — and
also bumps `task_requests.last_external_activity_at`, which drives the inbox
"new update" indicator (§4). No popups anywhere.

**Revisions** are first-class: a `revision_requested` activity **plus** the
**`request_revisions`** table (`note`, `link`, `status` open/addressed) so each
revision item is tracked to closure, not just seen in the stream.

**Change-tracking strategy:** each row carries a `detail` JSON with
`{ field, from, to }` (or a small structured payload), so the timeline renders
human sentences and keeps a full, queryable audit trail.

---

## 9. Permissions

New catalog keys (added to the existing `permissions` table; assigned via
Settings → Designations exactly like today). Admins get all automatically.

| Key | Allows |
|---|---|
| `requests.view` | See the Requests inbox and request details |
| `requests.review` | Move New → Under Review; Approve / Reject |
| `requests.start` | Promote (open Add Task prefilled & create the task) |
| `requests.manage` | Edit request fields, set Waiting/Revision, archive |
| `requests.activity.view` | See the full activity/audit timeline |
| `intake_links.manage` | Create / revoke / regenerate **client** links |
| `agency_links.manage` | Create / revoke / regenerate **agency** links |

**Recommended grouping (defaults):**
- **Admin / Accounts** → all of the above.
- **Team Lead** → `requests.view`, `requests.review`, `requests.start`, `requests.activity.view`.
- **Employee** → none by default (or `requests.view` if you want them to see incoming work).

`requests.start` is intentionally separate from `tasks.create` so you can let
someone triage without letting them mint tasks (and vice-versa). The promotion
step still also requires `tasks.create` to actually create the task.

---

## 10. Notifications — basic only, timeline-first, **no popup system**  *(Rev 2)*

**Explicit owner direction: do not build a noisy notification system.** No
app-wide toasts, no notification center, no dashboard alert cards. Awareness
comes from the **timeline** + **inbox indicators** (§4, §8). Email is used
sparingly for the few moments that genuinely warrant leaving the app.

**In-app awareness (no popups):**
- **Inbox row indicator** — "● New Client/Agency Update" + unread count, cleared on open (§4).
- **Sidebar "Requests" badge** — count of requests with new external activity. *This is the only global indicator.*
- Everything else is read from the **timeline** when staff open the request.

**Email — minimal v1 set (via Resend, already integrated):**

| Trigger | Recipient | Channel |
|---|---|---|
| New request submitted | Admin / `requests.view` holders | Email (one, "you have a new request") |
| Request **Started** | Client/agency | Email + tracking link |
| Status → **Completed / Delivered** | Client/agency | Email |

That's it for v1. **No** email on internal actions, assignments, contribution,
pricing, billing, or routine client edits — those live silently in the timeline
and surface via the inbox indicator only.

**Architecture (kept minimal but pluggable):** server actions emit
`notify(event, payload)`; a tiny dispatcher decides recipients and sends the
**few** v1 emails. Additional channels (**WhatsApp**, richer email) and more
events can be added later **without schema change** — but v1 deliberately ships
the smallest set.

---

## 11. Database Design (proposal only — no migrations yet)

> All new tables. **Zero changes** to existing tables except **two optional,
> additive, nullable** columns noted at the end.

### `intake_links` — tokenized share links
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| token | text unique | unguessable (uuid/nanoid); used in the URL |
| type | text | `client` \| `agency` \| `generic` |
| client_id | uuid FK clients | null unless type=client |
| agency_id | uuid FK agencies | null unless type=agency |
| label | text | e.g. "Sea Star — main" |
| is_active | bool | revoke = false |
| expires_at | timestamptz null | optional expiry |
| created_by | uuid FK employees | |
| created_at / revoked_at / last_used_at | timestamptz | |

### `agencies` — external partners  *(REQUIRED in v1 — owner-approved)*
| id, name, contact_name, email, phone, is_active, created_at |
A first-class entity (parallel to `clients`). Agency intake links resolve to an
`agency_id`; agency requests, tasks, and timelines are scoped to it. Generic
links may still capture a typed-in name for one-off submitters.

### `task_requests` — the inbox (core)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| public_ref | text unique | `REQ-0042` for client tracking |
| link_id | uuid FK intake_links | which link it came from |
| source | text | `client` \| `agency` \| `generic` \| `manual` |
| client_id | uuid FK clients null | |
| agency_id | uuid FK agencies null | |
| submitter_name / submitter_email / submitter_phone | text | for generic links |
| title | text | required |
| description / remarks / design_plan | text | |
| priority | text | `low\|normal\|high\|urgent` |
| due_date | date null | |
| is_planned | bool | agency "future campaign" flag |
| status | text | full internal enum (§3) |
| client_status | text | external-facing projection of `status` (§3); the only status shown on the portal |
| last_external_activity_at | timestamptz null | bumped on any client/agency action — drives the inbox "new update" indicator (§4) |
| last_staff_viewed_at | timestamptz null | set when staff open the request; clears the indicator |
| content_link / reference_link / deliverables_link / drive_folder_link | text null | |
| extra_links | jsonb | `[{label,url}]` |
| service_id | uuid FK services null | optional pre-route |
| assigned_employee_id | uuid FK employees null | who's handling |
| promoted_task_id | uuid FK tasks null | set at Create Task |
| promoted_at / promoted_by | timestamptz / uuid | |
| internal_notes | text | admin-only |
| created_at / updated_at / status_updated_at / archived_at | timestamptz | |

### `request_activity` — audit timeline (external + internal)  *(source of truth)*
| id, request_id FK, actor_type (`client\|agency\|admin\|system`), actor_id (uuid null), actor_label (text), action (text), **visibility (`internal\|client\|agency`, default `internal`)**, detail (jsonb `{field,from,to}`), created_at |
- `visibility` controls whether an entry appears on the client/agency tracking
  portal (§8). Default `internal`. Indexed by `(request_id, visibility, created_at)`.

### `request_revisions` — structured revisions
| id, request_id FK, requested_by_type, note, link, status (`open\|addressed`), created_at, resolved_at |

### ~~`request_notifications`~~ — **dropped in v1**
No in-app notification table. Awareness is timeline + inbox indicators (§4, §8);
the handful of v1 emails (§10) are fire-and-forget via Resend. An **optional**
`request_email_log` (request_id, event, recipient, sent_at) may be added purely
for audit if desired — not required.

### `request_views` *(future — per-staff read state)*
v1 uses a single per-request `last_staff_viewed_at`. If you later want *per-user*
unread state, add `request_views(request_id, employee_id, viewed_at)`. Additive,
no redesign.

### Relationships
```
clients 1───* intake_links *───1 (token)
agencies 1───* intake_links
intake_links 1───* task_requests
task_requests 1───* request_activity
task_requests 1───* request_revisions
task_requests 0..1───1 tasks   (promoted_task_id)
```

### Optional additive columns (nullable, safe — only if you want them)
- `clients.drive_folder_link text` — the per-client Drive root.
- `clients.intake_token text` / `agencies.intake_token` — *(or keep all tokens in `intake_links`; recommended to keep them in `intake_links` only.)*

**No existing table's behaviour changes.** `tasks` is only **inserted into** at
promotion via the current Add Task path.

---

## 12. UI Locations

| Location | What appears |
|---|---|
| **Sidebar** | New **"Requests"** item (near Tasks) with an unread **count badge**. Gated by `requests.view`. |
| **Tasks page header** | A **"Requests" button** (badge) that jumps to the inbox — the "separate window" you wanted. |
| **Requests Inbox** (`/dashboard/requests`) | Tabs (New/Reviewed/Approved/Started/Rejected/Archived), **new-external-activity indicators on rows** (§4), row actions, detail drawer. |
| **Request detail drawer** | Full fields, link list, **Activity Timeline panel — the primary review area**, revisions, visibility toggles, and the **Start** button → Add Task prefilled. |
| **Settings → "Client & Agency Links"** | Generate / label / revoke / regenerate tokens; copy share URL; per-client + generic + agency. Gated by `intake_links.manage` / `agency_links.manage`. |
| **Settings → Client / Agency detail** | "Intake link" + that requester's recent requests + Drive folder link. |
| **Dashboard** | **No alert card** (owner direction: avoid dashboard alerts). Awareness is the sidebar Requests badge only. |
| **Public** `/intake/{token}` | Branded submit form + **"Track my requests"** list (client-visible timeline only). No app chrome. |

**Primary review area:** the **Request Detail → Activity Timeline panel** is
where staff read client/agency updates and decide what to do — not a
notification feed. Each timeline entry shows its actor and a small
visibility chip (`internal` / `client` / `agency`).

Wireframe-level (inbox):
```
┌ Requests ───────────────────────────── [New 3] [Reviewed][Approved][Started][Rejected][Archived] ┐
│ REQ-0042 · Weekend Sale          Sea Star 015   ⚑High  due 18 Jun   2h ago   [Submitted]  ⋯ Start │
│ REQ-0041 · Summer Campaign(plan) Agency: BrightAds       due 01 Jul  1d ago   [Submitted]  ⋯ Start │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Security Review

- **Tokens:** long, random, unguessable (uuid/nanoid) stored in `intake_links`.
  The URL carries only the token; the server resolves it to a client/agency.
- **Access isolation:** the public route (`src/app/intake/[token]/`) lives
  **outside** `(dashboard)` — no app shell, no session. Every read/write on that
  page and its server actions is **filtered by the token's resolved
  `client_id`/`agency_id`**. There is **no query** for tasks, payroll, pricing,
  employees, invoices, or other clients on the public side.
- **Clients can't reach dashboard data:** the public page imports none of the
  dashboard data loaders; it can only (a) insert a `task_requests` row, (b)
  update its own request's editable fields, (c) read its own requests' statuses.
- **Agencies can't see other agencies:** token → single `agency_id`; all queries
  scoped to it; no cross-tenant path exists.
- **Revoke:** set `intake_links.is_active = false` (and/or `revoked_at`). The
  page then shows "link expired".
- **Regenerate:** create a new token row, deactivate the old — old link dies, new
  one issued. Optional `expires_at` for time-boxed links.
- **Abuse controls:** honeypot field on the form; optional per-token submit
  throttle; optional lightweight CAPTCHA later. Submissions are write-only into
  the isolated table, so worst case is spam in the inbox (reject/archive), never
  data exposure.
- **Service role stays server-side** (as in the existing portal) — never shipped
  to the browser.

### Client / Agency visibility rules  *(Rev 2 — enforced, not cosmetic)*

The tracking portal may render **only customer-facing information**. The
following are **never** sent to the public side (not in the page payload, not in
any server action response):
- Internal notes / internal discussions (`internal_notes`)
- Internal assignments and **employee names**
- Contribution / scoring data
- Pricing, billing, payroll data
- Internal status changes and internal timeline entries
- Any other request's data; any other client's or agency's data

**How it's enforced:** the public tracking query returns only the request's
**external fields** + its **`client_status`** + timeline entries **WHERE
`visibility = <requester type>`**. There is no code path on the public route that
selects internal columns or other tenants' rows. Agencies are scoped to their
`agency_id`; clients to their `client_id`; generic submitters to a single request
via its ref-token.

---

## 14. Future Expansion (no redesign required)

| Future capability | How it slots in |
|---|---|
| **Real file uploads** | Add `request_attachments` (request_id, path, name, mime, size) + a Supabase Storage bucket. Link fields stay; uploads are an extra source. |
| **Supabase Storage** | Public form uploads via a signed/secured server action (service role) into `intake/{request_id}/…`. |
| **Google Drive API** | Service account auto-creates the §7 folder at promotion and writes `drive_folder_link`. No schema change. |
| **Approval workflows** | Status enum already supports stages; add a `request_approvals` table for multi-step sign-off if needed. |
| **Client comments** | Add `request_comments` (request_id, author_type, body, created_at). Renders in the same timeline. |
| **WhatsApp / Email** | New channel in the §10 notification dispatcher — additive. |
| **Tasks: priority / structured links** | Optional future `tasks.priority` + `task_links` table; promotion maps to them when present. |

Because the inbox (`task_requests`) and the audit (`request_activity`) are the
stable core, every item above is a **bolt-on**, not a migration of existing data.

---

## Implementation Roadmap (phased — for when approved)

1. **Phase 1 — Foundation (read-only safe):** tables (`intake_links`,
   `task_requests`, `request_activity`, `agencies`), permission keys, Settings →
   Links generator. *No public page yet.*
2. **Phase 2 — Public intake:** `/intake/[token]` submit form (links-only) +
   submit action + activity logging. Per-client + generic + agency tokens.
3. **Phase 3 — Requests Inbox:** `/dashboard/requests` + sidebar item (with the
   new-external-activity badge) + Tasks-page button + detail drawer + **Activity
   Timeline panel with visibility levels** + status actions + per-request
   `last_staff_viewed_at` clearing.
4. **Phase 4 — Promotion:** Start → Add Task prefilled → Create Task links the
   request; `client_status` mirrors the task's status.
5. **Phase 5 — Tracking + minimal email:** "Track my requests" (client + agency,
   external-visible timeline + `client_status`), per-request tracking link, and
   the **three** v1 emails only (§10). No in-app notification system.
6. **Phase 6 — Polish:** revisions table, Drive folder conventions/links,
   abuse controls. **No dashboard alert card.**
7. **Later (optional):** uploads (Supabase Storage), Drive API, comments,
   WhatsApp.

---

### Approved decisions (Rev 2 — signed off)
1. **Agencies** = a first-class **required** `agencies` table in v1. ✅
2. **Full status system** retained internally; clients/agencies see only the
   external-facing subset via `client_status` (§3). ✅
3. **Basic notifications only** — minimal email set in §10, **no in-app popup/
   notification system**, **no dashboard alerts**. Timeline + inbox indicators
   are the awareness mechanism. ✅
4. **"Track my requests"** included in v1 for clients and agencies, showing only
   their own external-visible timeline and `client_status`. ✅

---

## 15. V1 Scope & Non-Goals  *(Rev 2)*

**Build in v1 (focus):**
1. Request **submission** (public `/intake/{token}`, client + agency + generic).
2. Request **tracking** ("Track my requests" — external-visible status & timeline).
3. Request **Inbox** (`/dashboard/requests`) with new-external-activity indicators.
4. **Activity Timeline** with `internal/client/agency` visibility — the primary
   communication & audit surface.
5. **Request → Task promotion** (Start → Add Task prefilled → Create Task).
6. **Google Drive link** workflow (link fields + per-client folder convention).

**Explicitly NOT in v1 (non-goals):**
- ❌ App-wide notification system / notification center.
- ❌ Popup/toast alerts for request activity.
- ❌ Dashboard alert cards for requests.
- ❌ Real file uploads / Supabase Storage (links only).
- ❌ WhatsApp, multi-step approvals, client comments (all §14 future).

**The request timeline is the primary communication and audit mechanism.**
Everything else stays quiet and on-demand.
