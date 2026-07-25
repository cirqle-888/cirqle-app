# Client Agreements — Architecture & Implementation Plan

**Status:** APPROVED v2 (2026-07-22) — Phase 1 implementation authorized. Final decisions: nav = immediately after Quotations, before Invoices/Billing; Elara Luxe logo = **AED 150** (confirmed); milestone `visibility` default = `internal`.
**Date:** 2026-07-22 (v2 — revised after senior-architect review and adversarial verification pass)
**Author:** Claude (lead-architect pass over the full codebase; two exploration sweeps, ~1M tokens of subsystem mapping with adversarial verification; v2 incorporates the architectural review)

> **v2 changelog** — every change is also marked `(v2)` at the section it lands in:
> - **C1 Temporal agreement terms** (§2, §2.3, §3.1): items carry `effective_from/effective_to`; term changes close-and-replace rows, never overwrite. One agreement identity forever. *(review #1 — highest priority)*
> - **C2 Renewals as term operations** (§2.3, §5): extend `end_date` for period-only renewals; new term rows for renegotiations; never a new agreement. *(review #2)*
> - **C3 Explicit counting rules** (§3.1–§3.3): units, variants, task quantities, dedup/attribution, `deleted_at` filters, proration for partial months/pauses, monthly-only cycle in Phase 1. *(review #3)*
> - **C4 Extra-work billing guards** R1–R5 (§4.2): no double billing, no currency mixing, idempotent lines. *(review #4)*
> - **C5 Commitment-only pricing rows** (§2.1): the ensured `client_service_pricing` row is price-less, so it can never arm flat retainer re-billing. *(review #5)*
> - **C6 Schema amendments only** (§2): reserved `pending_approval` status; milestone `due_date` + `visibility`; events vocabulary fixed; permission band corrected to 85–87 (80–81 are taken by the social calendar — verified). *(review #6, #10)*
> - **C7 Composite task index + scale notes** (§2 §9, §9.1). *(review #7)*
> - **C8 Health score design** (§6.6, Phase 2, design only). *(review #8)*
> - **C9 Template design** (§5.1, Phase 2, single JSONB-payload table). *(review #9)*
> - **C10 Approvals**: reuse the existing polymorphic engine; status reserved now, workflow later (§5.2). *(review #10)*
> - **C11 Portal**: milestone visibility + token rotation only; no speculative fields (§8). *(review #11)*
> - **C12 AI readiness**: documented as already-satisfied by existing jobs/queue architecture; nothing to build (§8.1). *(review #12)*
> - **C13 Phase plan**: architecture-critical items moved into Phase 1; templates moved to Phase 2; manual carry hidden until Phase 2 (§11). *(review #13)*
>
> **Review recommendations rejected (with reasoning):** narrowing the `cycle` CHECK to `'monthly'` — kept all three values because CHECK-only edits are invisible to the REST probe script and the report-template CHECK drift bug (`20260714120000`, its own migration comment) is the documented failure mode; the engine and UI restrict to monthly instead (§3.2 rule 6). A pause-history table — rejected; pause/resume are modeled as term-row closure/reopen, which records history with zero new machinery (§2.3). Dropping `items.committed_quantity` in favor of mandatory deliverables — rejected; the simple "15 posts" case shouldn't require deliverable ceremony, so the field stays as an explicit fallback with a precedence rule (§3.2 rule 2).

---

## 0. Executive summary

Cirqle already has the entire *delivery* spine — plan (Social Calendar) → request → task → monthly draft invoice — and an explicit doctrine that live progress is **never stored, always derived** (`supabase/migrations/20260716120000_social_calendar.sql`, in-file comment). What it lacks is the *promise*: nothing can store "15 posts per month" or "logo package, one-time, AED 150", so nothing can compute remaining/extra/renewal.

This plan introduces **Client Agreements as the parent commercial object**:

```
Client
  └─ Agreement (AGR-2607-004, status, term, renewal)   ← NEW  ┐
       └─ Items — temporal term rows (service, one_time/      │ the promise
          retainer, qty, cycle, effective window)         NEW │
            └─ Deliverables (15 Posts, 10 Stories, …)     NEW ┘
                  ⇣ measured against (read-through, never stored)
Social Calendar items ──► Requests ──► Tasks ──► Draft Invoice ──► Monthly Report
```

Six new tables, one additive migration + rollback, one pure progress engine (`src/lib/agreements/progress.ts`), and four surfaces: an Agreements dashboard, an agreement detail page with timeline, a quota meter in the Social Calendar header, and an Agreements card on the client page. **(v2)** Agreement items are *temporal*: terms carry `effective_from/effective_to` and are closed-and-replaced rather than edited, so a September renegotiation can never rewrite July's numbers — the same effective-dating pattern `employee_commission_agreements` already uses. Everything else — counting, billing, notifications, reports, portal — reuses an existing, verified pattern (each is cited by file:line below).

---

## 1. Architecture review

### 1.1 The delivery spine (verified)

| Stage | Table / code | Key facts |
|---|---|---|
| Plan | `social_calendars` UNIQUE(client_id, month); `social_calendar_items` | Items store *authored* state only: `'planned'│'requested'│'cancelled'`. 12 content types after `20260718090000`: `post, reel, story, carousel, video, flyer, poster, blog, seo, ad, email, other` (mirrored in `CONTENT_TYPES`, `src/lib/social/plan.ts:14`). `service_id` auto-resolved per item from the `social_content_type_services` map. |
| Live progress | `resolveItemProgress(itemStatus, request)` — `src/lib/social/plan.ts:520` | Derives `planned│requested│in_progress│delivered│done│cancelled` through item → `request_id` → `task_requests` → `promoted_task_id` → `tasks`. **Never stored.** |
| Work | `tasks` | `client_id, service_id, task_date, quantity, status ∈ pending→in_progress→delivered→done→invoiced/paid/cancelled`, soft-delete `deleted_at`. |
| Billing | trigger `auto_attach_task_to_invoice` (`20260701120000`) + `syncDraftInvoices` (`src/lib/sync/integrity.ts:249`) | Task hits `done` → auto-attached to the per-client-month draft invoice (`find_or_create_client_month_draft`). Invoice YYMM = **issue** month = task month + 1 (`nextMonthBilling` default true, `src/lib/invoices/numbering.ts:116`). |

### 1.2 What exists on the "promise" side today

- `client_service_pricing` — formally declared the commitment record (`20260720100000`: *"committed ⇔ row exists AND is_active IS NOT FALSE"*), but **binary**: price only, no quantity, no term, no cadence.
- `services.pricing_type='retainer'` + `retainer_cycle` — exists but decorative; the only effect is flat task billing (`serverFillTaskBilling`, `tasks/actions.ts:344`).
- `quotations` + `quotation_items` (service_id, quantity, unit_price; `draft→sent→approved→converted`) — closest thing to a signed proposal; the trail dies at `converted`.
- `employee_commission_agreements` — the implemented in-house *agreement table shape* (scoped FKs, type, value, effective_from/to, is_active) with UI at `/dashboard/employees/[id]/agreements`. Client Agreements mirrors this on the client side.

### 1.3 House patterns this plan reuses (no new architecture)

| Need | Existing pattern reused | Source |
|---|---|---|
| Module migration shape | BEGIN/COMMIT, `IF NOT EXISTS`, RLS DO-block "authenticated all", permission INSERT + admin auto-grant, soft delete | `20260628120000_advertising_module.sql` |
| Agreement ↔ task linking | Composite-PK join table, never duplicating tasks | `ad_project_tasks` (`20260628120000:106`) |
| Timeline / audit | `request_activity` shape: actor_type/actor_id/actor_label/action/**visibility**/detail JSONB | `20260610120000:90` |
| Client-safe projection | `projectClientStatus()` internal→external status softening | `src/lib/requests/core.ts:82` |
| Status/label/chip vocabulary | `STATUSES` option list + `STATUS_LABEL` + `*_CHIP` Tailwind map in a pure lib file | `src/lib/advertising/types.ts:66` |
| Notifications + dedup | `notifyAdmins/createNotification` with `sourceKey`; partial unique index `(type, source_key, employee_id)` | `src/lib/notifications/create.ts`, `20260623080000` |
| Cron route | inline `authorized()` CRON_SECRET Bearer check, `logCronRun` awaited, errors array, daily-or-slower | `/api/cron/recurring-tasks/route.ts` |
| Permission guards | `requirePermission` (`src/lib/auth/enforce.ts:121`), `PERMS` keys, server-side financial stripping (`strip.ts`) | permissions module |
| Defensive reads pre-migration | try/catch fetch with `[]` fallback; `withPatchColumnFallback` column retry | employee-agreements `page.tsx`; social-calendar `actions.ts:220` |
| **(v2)** Temporal terms | `effective_from/effective_to` windows + date-window resolver (string-compare, inclusive, NULL `effective_to` = open); historical reads must never filter on current-state flags | `20260609140000` + `src/lib/calculations/agreements.ts:42`; "HISTORICAL READER CONTRACT" comment, `src/lib/payroll/compute.ts` |
| **(v2)** Approval engine (reserved) | polymorphic approvals: `entity_type/entity_id`, approver by employee/designation/permission, multi-step chains, post-decision effects registry | `migrations/017_approvals.sql`, `approval_steps` (`021`), `src/lib/approvals/effects.ts` |
| **(v2)** Health-score shape (Phase 2) | weighted factors that renormalize over available inputs; `Unknown` at 50; label bands | `src/lib/advertising/health.ts` |
| **(v2)** Background/AI jobs | generic `system_jobs` queue (DAG deps, dead-letter) + worker-registry handlers | `src/lib/jobs/engine.ts`, `src/lib/jobs/worker.ts` |
| Numbering | `formatInvoiceNumber`-style `{PREFIX}-{YYMM}-{clientCode}` with dup suffix | `src/lib/invoices/numbering.ts:88` |
| Kill switch | `company_settings` key, value `'off'` disables, fail-open | `service-scope.ts:126` (`scope_client_services`) |
| Client portal auth | unguessable token IS the auth, service-role fetch | `clients.hub_token` → `/start/[token]`; `invoices.public_token` → `/i/[token]` |

### 1.4 Non-negotiable doctrines adopted

1. **Never store progress.** All committed-vs-planned-vs-delivered numbers are computed live through the same joins the calendar already uses. (One narrow, documented exception: manually-checked milestones — §3.4.)
2. **RLS is a formality; authorization is app-level** via `requirePermission` in server actions and `loadCurrentUser` in pages. New tables follow the same DO-block policy.
3. **Migrations are applied by hand** to hosted Supabase (files on disk ≠ live schema). All SQL idempotent, rollback file provided, probe registered in `scripts/check-pending-migrations.mjs`, all app reads defensive.
4. **This Next.js is not the trained-on Next.js** (`AGENTS.md`): `params`/`searchParams` are Promises; consult `node_modules/next/dist/docs/` before page/server-action code.
5. **(v2) Past months are immutable.** Committed terms are temporal rows; a change closes the current row and opens a successor, and every historical computation resolves the row in effect for *that* month. Historical resolution never filters on current-state flags — the payroll module's documented contract (*"is_active governs what a client may be SOLD today; it must never govern what was EARNED"*, `src/lib/payroll/compute.ts` / `src/lib/sync/integrity.ts`).

---

## 2. Database design (Phase 1, one migration)

`supabase/migrations/20260722120000_client_agreements.sql` — additive only, nothing existing is altered. Six tables.

> **Deliberate deviations from the requested field list** (flagged for approval, §12):
> `auto_renew` boolean is folded into `renewal_type ∈ ('none','manual','auto')` — two columns encoding one fact invites drift. `signed_document` is `signed_document_url TEXT` (Drive-link precedent: `clients.drive_folder_link`); file upload to a storage bucket is Phase 3. `public_token` is added now for portal-readiness (mirrors `invoices.public_token`).
>
> **(v2) Schema amendments from the architectural review** — same six tables, fields only:
> items gain `effective_from/effective_to` (temporal terms, C1); `status` reserves `'pending_approval'` now because CHECK-only edits can't be probed remotely and the report-template CHECK drift (`20260714120000`) is the documented failure mode; milestones gain `due_date` (health score input) and `visibility` (portal safety); the events `action` vocabulary gains `updated`, `term_changed`, `expired`; the permission band moves to **85–87** (80–81 are already taken by `social.view`/`social.manage` — verified at `20260716120000:100-104`); and the migration adds the missing composite index on `tasks`.

```sql
BEGIN;

-- ── 1. Agreements (the parent commercial object) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_agreements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_number    TEXT NOT NULL UNIQUE,        -- AGR-{YYMM}-{clientCode}, dup suffix A/-2/-3
  client_id           UUID NOT NULL REFERENCES public.clients(id)    ON DELETE CASCADE,
  quotation_id        UUID          REFERENCES public.quotations(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft'   -- (v2) 'pending_approval' reserved now (C10)
                      CHECK (status IN ('draft','pending_approval','active','paused',
                                        'completed','cancelled','expired')),
  start_date          DATE NOT NULL,
  end_date            DATE,                        -- NULL = open-ended (month-to-month)
  renewal_type        TEXT NOT NULL DEFAULT 'manual'
                      CHECK (renewal_type IN ('none','manual','auto')),
  signed_document_url TEXT,
  public_token        UUID UNIQUE DEFAULT gen_random_uuid(),   -- future client portal
  notes               TEXT,
  created_by          UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ                  -- soft delete (house norm)
);
CREATE INDEX IF NOT EXISTS client_agreements_client_idx
  ON public.client_agreements (client_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS client_agreements_expiry_idx
  ON public.client_agreements (end_date) WHERE deleted_at IS NULL AND status = 'active';

-- ── 2. Items — TEMPORAL term rows (v2, C1) ───────────────────────────────────
--     A row is ONE TERM WINDOW of a committed service package. Terms are never
--     UPDATEd once the agreement is active: a change CLOSES the row
--     (effective_to) and INSERTs a successor (with its deliverables re-created).
--     Same effective-dating pattern as employee_commission_agreements
--     (20260609140000; resolver src/lib/calculations/agreements.ts:42).
CREATE TABLE IF NOT EXISTS public.client_agreement_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id        UUID NOT NULL REFERENCES public.client_agreements(id) ON DELETE CASCADE,
  service_id          UUID          REFERENCES public.services(id)          ON DELETE SET NULL,
  commitment_type     TEXT NOT NULL DEFAULT 'retainer'
                      CHECK (commitment_type IN ('one_time','retainer')),
  committed_quantity  NUMERIC(10,2),               -- headline fallback; when deliverables exist,
                                                   -- THEY are the committed source (§3.2 rule 2)
  cycle               TEXT CHECK (cycle IN ('monthly','quarterly','yearly')),
                      -- (v2) Phase 1 engine + UI ship 'monthly' ONLY; the other values are
                      -- reserved so no CHECK migration is needed later (§3.2 rule 6)
  effective_from      DATE NOT NULL,               -- (v2) term window start
  effective_to        DATE,                        -- (v2) NULL = current term
  unit_price          NUMERIC(14,2),               -- package fee (one_time) / fee per cycle (retainer)
  currency            TEXT NOT NULL DEFAULT 'INR', -- UI defaults to the client's default_currency
  carry_forward_rule  TEXT NOT NULL DEFAULT 'expire'
                      CHECK (carry_forward_rule IN ('expire','carry_forward','manual')),
  extra_unit_price    NUMERIC(14,2),               -- NULL = extra work is not auto-billable
  display_order       INT  NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_items_agreement_idx
  ON public.client_agreement_items (agreement_id);
CREATE INDEX IF NOT EXISTS client_agreement_items_service_idx
  ON public.client_agreement_items (service_id);
CREATE INDEX IF NOT EXISTS client_agreement_items_term_idx          -- (v2) term resolution
  ON public.client_agreement_items (agreement_id, effective_from);

-- ── 3. Deliverables (typed quota lines under an item) ────────────────────────
CREATE TABLE IF NOT EXISTS public.client_agreement_deliverables (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,               -- "Feed Posts", "Stories", "Monthly Report"
  content_types       TEXT[] NOT NULL DEFAULT '{}',-- maps to social calendar vocabulary; '{}' = count by service only
  committed_quantity  NUMERIC(10,2) NOT NULL DEFAULT 0,  -- per cycle (retainer) / absolute (one_time)
  display_order       INT NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_deliverables_item_idx
  ON public.client_agreement_deliverables (item_id);

-- ── 4. Milestones (one-time projects: Research → Concept → … → Final Files) ──
CREATE TABLE IF NOT EXISTS public.client_agreement_milestones (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  display_order       INT NOT NULL DEFAULT 0,
  due_date            DATE,                                                     -- (v2) health-score input (§6.6)
  visibility          TEXT NOT NULL DEFAULT 'internal'
                      CHECK (visibility IN ('internal','client')),              -- (v2) portal safety (§8)
  task_id             UUID REFERENCES public.tasks(id)     ON DELETE SET NULL,  -- linked ⇒ status derives from task
  completed_at        TIMESTAMPTZ,                                              -- unlinked ⇒ manual check-off
  completed_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_milestones_item_idx
  ON public.client_agreement_milestones (item_id);

-- ── 5. Task link (reuse the existing tasks table; never duplicate it) ────────
--     Direct copy of ad_project_tasks (20260628120000:106).
CREATE TABLE IF NOT EXISTS public.client_agreement_tasks (
  item_id     UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES public.tasks(id)                  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, task_id)
);
CREATE INDEX IF NOT EXISTS client_agreement_tasks_task_idx
  ON public.client_agreement_tasks (task_id);

-- ── 6. Events (timeline; direct copy of request_activity's shape) ────────────
CREATE TABLE IF NOT EXISTS public.client_agreement_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID NOT NULL REFERENCES public.client_agreements(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('client','admin','system')),
  actor_id      UUID,                              -- employee id when actor_type = 'admin'
  actor_label   TEXT,
  action        TEXT NOT NULL,                     -- created | updated | quotation_linked | activated
                                                   -- | item_added | item_updated | item_removed
                                                   -- | term_changed | renewed | paused | resumed
                                                   -- | completed | cancelled | expired | adjustment | note
                                                   -- (v2: added updated, term_changed, expired)
  visibility    TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','client')),
  detail        JSONB,                             -- {field,from,to} | {message} | {month,qty} …
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_events_agreement_idx
  ON public.client_agreement_events (agreement_id, visibility, created_at);

-- ── 7. RLS (house pattern: permissive; real authz is app-level guards) ───────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client_agreements','client_agreement_items','client_agreement_deliverables',
    'client_agreement_milestones','client_agreement_tasks','client_agreement_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_authenticated_all', t);
  END LOOP;
END $$;

-- ── 8. Permissions (v2: band 85-87 — requests use 60-66, ads 70-77, and the
--     social calendar already took 80-81, verified 20260716120000:100-104) ────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('agreements', 'view',         'agreements.view',         'View Agreements',
    'See client agreements, deliverables and progress',                        85),
  ('agreements', 'manage',       'agreements.manage',       'Manage Agreements',
    'Create and edit client agreements, items, deliverables and milestones',   86),
  ('agreements', 'view_pricing', 'agreements.view_pricing', 'View Agreement Pricing',
    'See fees and prices on client agreements',                                87)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('agreements.view','agreements.manage','agreements.view_pricing')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- ── 9. (v2, C7) Missing composite index on the engine's hottest read path ────
--     Verified: tasks carries only single-column indexes on client_id /
--     service_id / task_date today (20260528090000_performance_indexes.sql:32-34);
--     the only composite is (scope, task_date). Additive; safe on a live table.
CREATE INDEX IF NOT EXISTS idx_tasks_client_service_date
  ON public.tasks (client_id, service_id, task_date) WHERE deleted_at IS NULL;

COMMIT;
```

**Rollback** — `supabase/rollbacks/20260722120000_client_agreements_rollback.sql`:

```sql
BEGIN;
DELETE FROM public.designation_permissions WHERE permission_id IN
  (SELECT id FROM public.permissions
    WHERE key IN ('agreements.view','agreements.manage','agreements.view_pricing'));
DELETE FROM public.permissions
  WHERE key IN ('agreements.view','agreements.manage','agreements.view_pricing');
DROP TABLE IF EXISTS public.client_agreement_events;
DROP TABLE IF EXISTS public.client_agreement_tasks;
DROP TABLE IF EXISTS public.client_agreement_milestones;
DROP TABLE IF EXISTS public.client_agreement_deliverables;
DROP TABLE IF EXISTS public.client_agreement_items;
DROP TABLE IF EXISTS public.client_agreements;
DROP INDEX IF EXISTS public.idx_tasks_client_service_date;   -- (v2)
COMMIT;
```

**Probe** added to `scripts/check-pending-migrations.mjs`:

```js
{ m: '20260722120000_client_agreements', kind: 'table', table: 'client_agreements', col: 'id' },
```

### 2.1 Relationship to `client_service_pricing` (no dual source of truth) *(revised in v2, C5)*

`client_service_pricing` stays what `20260720100000` declared it: *the binary "this client buys this service" record plus the unit price* that drives task billing and intake derivation. Agreements add the **terms** on top. To keep the invariant true, activating an agreement item ensures an active `client_service_pricing` row exists for `(client_id, service_id)` — but **(v2) the ensured row is commitment-only: `price` and `currency` are left NULL.** A NULL price is explicitly legal and meaningful in that migration (*"price optional so a service can be committed before a rate is agreed"*), and `serverFillTaskBilling` returns without writing anything when the resolved unit price is NULL (`tasks/actions.ts:344`) — so the ensured row can mark commitment without ever arming the flat retainer re-bill trap §4.1 describes. If a priced row already exists, it is left untouched. The sync stays one-way (agreement → pricing), and deactivating an agreement never deactivates the pricing row (other work may rely on it). Actual rates remain the Pricing Matrix's job, entered there deliberately.

### 2.2 Why the timeline table ships in Phase 1 (though its UI is Phase 2)

Migrations are pasted into the Supabase SQL editor by hand. Shipping all six tables in one migration means one manual apply, and Phase 1's server actions can start recording events from day one — so when the Phase 2 timeline UI arrives, history already exists.

### 2.3 Temporal terms — how history stays correct *(new in v2, C1/C2)*

- **One identity, forever.** The `client_agreements` row, its `agreement_number`, `public_token`, and timeline never change or clone. "v1 / v2 / v3" in the UI is the *derived ordinal* of a term window, not a database object. No agreement clones, no parent/child agreements, no snapshot-as-source — snapshots appear only as `detail` payloads on events, audit-grade not query-grade.
- **Draft grace period.** While an agreement is `draft` (or `pending_approval`), items are freely editable in place — no history exists yet. Temporal discipline begins at activation.
- **Changing terms** (active agreement): `changeAgreementItemTerms(itemId, changes, effectiveDate)` sets the current row's `effective_to = effectiveDate − 1 day`, inserts a successor row (deliverables re-created under it, with edits applied), and logs `term_changed` with `{from_item_id, to_item_id}`. Nothing is overwritten; July resolves July's row no matter what September does.
- **Renewals (C2):** period-only renewal (same terms) = extend `end_date` + `renewed` event. Renegotiated renewal = the term-change flow above, effective on the renewal date, + `renewed` event. Never a new agreement.
- **Pause/resume are term operations:** pausing closes all open term rows at the pause date and sets status `paused`; resuming inserts successor rows (same terms) from the resume date and sets `active`. Pause history is thereby recorded in real columns — no pause-log table needed — and proration (§3.1) handles paused spans with zero extra machinery. Both log events.
- **Resolution rule:** for month M, the engine selects an item's rows whose `[effective_from, effective_to]` window overlaps M — the same inclusive string-compare date-window filter the commission resolver uses (`src/lib/calculations/agreements.ts:42`). Historical resolution never filters on current-state flags (doctrine 5).
- **Phase 2 additive migration (defined now, shipped with manual carry):**

```sql
CREATE TABLE IF NOT EXISTS public.client_agreement_adjustments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  month       DATE NOT NULL,                -- first of month
  qty         NUMERIC(10,2) NOT NULL,       -- signed carry-in adjustment
  reason      TEXT,
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_adjustments_item_idx
  ON public.client_agreement_adjustments (item_id, month);
```

  Manual carry-forward quantities are **computation input** and live in this real table with a real FK — not in `client_agreement_events.detail`, whose writer never throws and may silently drop a row (fine for audit, disqualifying for arithmetic).

---

## 3. Progress engine — never stored, always derived

New pure module `src/lib/agreements/progress.ts` (no `'use server'`/`'use client'`, importable from pages, actions, exports, and the cron — same pattern as `src/lib/advertising/types.ts` and `src/lib/clients/scoring.ts`). It **imports** `resolveItemProgress`, `ItemProgress`, `CONTENT_TYPES` from `@/lib/social/plan` — it must not re-declare status vocabularies.

### 3.1 The five numbers *(revised in v2, C1/C3)*

Every computation starts with **term resolution**: for month `M` (a `YYYY-MM` **task/plan month** — never the invoice's YYMM, which is the issue month = M+1), the engine selects the item term rows whose `[effective_from, effective_to]` window overlaps M (§2.3). All five numbers are then derived from *those rows'* quantities — a September renegotiation can never change July's output.

| Number | Source | Rule |
|---|---|---|
| **Committed** | agreement (term rows) | **Prorated by active days:** `committed(M) = Σ over resolved term rows r of qty_r × activeDays_r(M) / daysInMonth(M)`, rounded half-up, where `activeDays` clips the row's window by the agreement's `[start_date, end_date]`. One formula covers mid-month starts (Appendix A: a 15/mo retainer starting 22 July commits 15 × 10/31 = 4.84 → 5 in July), mid-month term changes, pauses (closed rows contribute only their active days), and final months. Plus carry-in (§3.3). |
| **Planned** | Social Calendar | count of matched units (§3.2) on calendar items whose **resolved progress** (`resolveItemProgress`) is not `cancelled` — the *same* population as the header chips (`progressCounts`, `social-calendar-client.tsx:696`). (v2: the v1 rule filtered on *authored* status, which diverged from the chips whenever a linked request was rejected — resolved progress is the single population everywhere.) Includes undated Idea-Board items. |
| **Delivered** | completed Tasks | matched units on calendar items whose resolved progress ∈ `{delivered, done}`, **plus** explicitly linked tasks (`client_agreement_tasks`) with `tasks.status ∈ {delivered, done, invoiced, paid}`, **`deleted_at IS NULL`** (v2 — soft-deleted tasks never count), and `task_date` in M — de-duplicated by task id (a linked task that is also a counted item's promoted task counts once). |
| **Remaining** | derived | `max(0, committed − delivered)` |
| **Extra** | derived | `max(0, delivered − committed)` |

### 3.2 Units and attribution — the counting rules *(rewritten in v2, C3)*

**Rule 1 — What a unit is.** A calendar item is **1 unit** of its `content_type`, and each value in its `variants[]` array is **1 additional unit** of that type — variants use the same vocabulary as `content_type` and represent the same creative shipped in another format (`20260717110000_social_calendar_item_variants.sql`), so a post with a story variant delivers 1 Feed Post *and* 1 Story. A task counted **directly** (explicitly linked, or via the safety net) contributes `tasks.quantity` (≥ 1) units — bulk entries count fully. A task reached *through* a calendar item contributes nothing beyond the item's units; the two paths never double-count (dedup by task id).

**Rule 2 — Committed source precedence.** When an item has deliverables, **they** are the committed source and the item-level number is their sum; `items.committed_quantity` is used *only* when no deliverables exist (implicit single deliverable over `service_id`). The editor keeps the two consistent by construction — the headline field is hidden once deliverables are added.

**Rule 3 — Every unit attributes to exactly one deliverable.** Precedence: an explicit `client_agreement_tasks` link wins; otherwise the first match in `(agreement.start_date, item.display_order, deliverable.display_order)` order, where a deliverable matches a unit when the unit's type ∈ `content_types`, or — for `content_types = '{}'` — when the calendar item's `service_id` equals the item's `service_id`. Overlapping matchers (two deliverables, items, or concurrently active agreements matching the same type for one client) are legal for the engine (deterministic first-match) but flagged as **save-time editor warnings**, copying the employee-agreements client-side warning pattern (`agreements-client.tsx` warnings `useMemo`).

**Rule 4 — One-time items have no month window.** Their deliverable matching scans the agreement's whole `[start_date, ∞)`; they are primarily tracked through linked tasks and the milestone strip (§3.4). The month parameter is ignored for them.

**Rule 5 — Safety net (out-of-calendar work).** For retainer items the engine also computes `SUM(tasks.quantity)` over `(client_id, service_id, month(task_date), status ∈ delivered/done/invoiced/paid, deleted_at IS NULL)`, **excluding** tasks already counted (promoted tasks of matched items; linked tasks). The excess shows as a "+N outside calendar" hint and is included in the *item-level* Delivered rollup — real work is never silently ignored — but cannot be placed on a typed deliverable bar (no content type exists for it).

**Rule 6 — Cycles: monthly only in Phase 1.** The engine v1 implements `cycle='monthly'` exclusively and the UI offers only it; `quarterly`/`yearly` stay in the CHECK (see rejected-recommendations note, header) but are inert. Future semantics, sketched for the record: windows anchored at the term row's `effective_from` anniversary, committed applies per window, the meter shows window-to-date — shipped only once specified to this level.

**Rule 7 — Defensive reads.** `social_calendar_items.service_id` and `variants` are PATCH_COLUMNS the calendar itself treats as possibly absent from the live schema (`actions.ts:194`); the agreement loaders read them with the same optional-column tolerance, degrading to content-type-only matching when absent.

### 3.3 Carry-forward (`carry_forward_rule`) *(revised in v2, C3)*

- `expire` (default): carry-in is always 0.
- `carry_forward`: carry-in for month M = previous months' `remaining`, computed iteratively from `max(current term chain start, M − 24 months)` — bounded, live, nothing stored. Temporal rows shrink the recursion further: iteration never crosses into months before the item's first term window.
- `manual`: carry-in = `SUM(qty)` from `client_agreement_adjustments` rows for (item, ≤ M) — a real table with a real FK (§2.3), **not** events (v2: the never-throws event log is audit-only and must not feed arithmetic). The UI hides this rule until Phase 2 ships `recordCarryAdjustment` — v1 selectable-but-unrecordable was a trap.

### 3.4 Milestones — the one documented exception to "never store"

A milestone linked to a task (`task_id`) derives its state from the task (`done/invoiced/paid` ⇒ complete; `delivered` ⇒ under review) — nothing stored. **(v2)** A linked task that has been soft-deleted (`deleted_at` set — the FK only clears on hard delete) derives as *incomplete* with a "task deleted" flag in the UI. An **unlinked** milestone ("Research", "Client call") has no pipeline object to derive from, so checking it off stores `completed_at/completed_by`. This is stored *input* (like an approval), not derived progress, and it's the same trade `request_revisions` already makes. **(v2)** Milestones also carry an optional `due_date` (feeds the health score, §6.6, and overdue display) and a `visibility` flag (`internal` by default) so internal steps never leak to the future portal (§8).

### 3.5 Code layout

```
src/lib/agreements/
  types.ts       pure: STATUSES/{value,label}[], STATUS_LABEL, AGREEMENT_STATUS_CHIP
                 (chip recipe bg-{c}-500/12 text-{c}-700 border-{c}-500/25 dark:text-{c}-400),
                 COMMITMENT_TYPES, CYCLES, CARRY_RULES, row interfaces, agrRefLabel()
  numbering.ts   generateAgreementNumber(admin, date, clientCode) → 'AGR-{YYMM}-{code}'
                 with the numbering.ts dup strategy (base → 'A' → '-2'); uses formatLocalDate
                 semantics — never toISOString().split('T')[0] (Asia/Calcutta rule,
                 src/lib/invoices/numbering.ts header)
  progress.ts    pure compute: resolveTermRows (v2 — month → applicable term rows,
                 the agreements.ts:42 window-filter pattern) / prorateCommitted (v2) /
                 computeDeliverableProgress / computeItemProgress /
                 computeAgreementSummary — inputs are plain rows, no I/O.
                 Unit-tested on month boundaries (Dec→Jan), mid-month term changes,
                 proration rounding, and variant counting.
  server.ts      loaders (createAdminClient): loadClientMonthProgress(clientId, month),
                 loadAgreementOverview(filters) — batched queries (IN-lists, one query per
                 table, never per-agreement loops); defensive try/catch returning null when
                 tables are missing pre-migration (employee-agreements page.tsx precedent)
  events.ts      logAgreementEvent(admin, input) — never throws (logRequestActivity clone)
```

---

## 4. Billing integration

### 4.1 What Phase 1 does **not** touch (deliberately)

The task-billing cascade (`serverFillTaskBilling` → `recalcTaskCommissions` → `syncDraftInvoices` → payroll recalc) is the most sensitive machinery in the app, and two of its behaviors are traps:

- `pricing_type='retainer'` bills **flat per task, quantity ignored** (`tasks/actions.ts:384`) — so per-post tasks created under a retainer *service* each re-bill the full retainer fee. The correct setup (unchanged by this plan): the retainer **fee** is billed by one monthly recurring task (existing `is_recurring` + `/api/cron/recurring-tasks` machinery), while per-post work rides per-creative services via the calendar's content-type→service map. The agreement editor will warn when a retainer item's service is also the service of its deliverables' content-type mapping — the meter makes today's silent over-billing hazard *visible*; it must not add to it. **(v2, C5)** The §2.1 pricing-row sync reinforces this: the ensured row is price-less, so agreement activation can never arm this trap by itself.
- `is_billable=false` and 0-amount tasks **still attach** to the draft invoice as ₹0 lines (neither the trigger nor `syncDraftInvoices` checks them). No agreements logic may assume otherwise.

Phase 1 therefore reads billing data but writes none.

### 4.2 Extra work → draft invoice (Phase 2, opt-in per item)

When `delivered > committed` and the item has `extra_unit_price` set, the agreement detail and calendar meter show an **"Add extra work to draft invoice"** action:

- Server action `addExtraWorkToDraft(itemId, month)` — guarded by `agreements.manage` + `billing.view_amounts`.
- Finds/creates the client-month draft via the existing `find_or_create_client_month_draft` RPC (same helper the trigger uses; month semantics: invoice issue month = M+1, exactly as `20260701120000:59` computes it).
- Upserts one `invoice_items` line matched by description prefix — the `ilike('description', 'Agency Service Charge%')` precedent from `src/lib/advertising/billing.ts` — as `Extra {deliverable.label} × {N} — {billing_period_label}`, `quantity = N`, `unit_price = extra_unit_price`, **no task_id**; then recalcs totals the way `integrity.ts` does. Draft-status invoices only ("never edit a sent/paid invoice").
Manual-trigger-first keeps a human in the loop for the first billing-adjacent write; automating it can be revisited once trusted.

**(v2, C4) Billing guards** — the adversarial review found two real money bugs in the v1 rule; these five guards are binding on the implementation:

- **R1 — No double billing.** Extra units whose source *tasks already produced a priced line* on the draft (the `done`-trigger attaches every task, `20260701120000`) are **excluded by default**. Billable extra = extra units whose source task billed ₹0 / `is_billable = false`, or which have no task at all (variant units). The action shows the per-unit breakdown — task, its invoice-line amount — and the operator confirms the final count. It never bills the same work twice.
- **R2 — One currency, no conversion.** The line's currency is `item.currency` and the action **aborts with an error** if it differs from the draft invoice's currency — the draft lookup matches by billing period only and the totals recalc sums raw (`integrity.ts:337`), so a mixed-currency line would silently corrupt `total_amount`. No implicit FX, ever.
- **R3 — Idempotent by key.** One line per `(item, deliverable, month)`, matched by its description prefix; re-running replaces quantity/price, never appends.
- **R4 — Draft-only**, then the house totals recalc.
- **R5 — Historically stable.** Extra is computed against the *term row effective for M* (§2.3), so re-running after a later renegotiation cannot change a past month's line.

---

## 5. API changes (server actions + libs)

New module `src/app/(dashboard)/dashboard/agreements/` — all mutations return the house `ActionResult<T>` shape, are guarded by `requirePermission(PERMS.AGREEMENTS_MANAGE)` (`src/lib/auth/enforce.ts` — note: *not* `permissions/check.ts`), call `revalidatePath`, and log a timeline event.

| Action | Notes |
|---|---|
| `createAgreement(input)` | generates `agreement_number`; event `created` |
| `updateAgreement(id, changes)` | event `updated` with `{field, from, to}` detail |
| `setAgreementStatus(id, status)` | validated transitions; events `activated/completed/cancelled`; `renewed` when reactivating with a new end_date. **(v2)** `paused`/`active` transitions go through the dedicated pause/resume actions below |
| **(v2)** `pauseAgreement(id, effectiveDate)` / `resumeAgreement(id, effectiveDate)` | term operations (§2.3): pause closes open term rows + status `paused`; resume inserts successor rows + status `active`; events `paused`/`resumed`. Proration then handles the gap automatically |
| `saveAgreementItem / deleteAgreementItem` | **draft/pending agreements only** (v2 — free in-place editing before activation, §2.3); ensures a **price-less** `client_service_pricing` row on activation (§2.1); events `item_*` |
| **(v2)** `changeAgreementItemTerms(itemId, changes, effectiveDate)` | the only way to change an *active* item's terms: closes the current term row, inserts the successor with its deliverables, event `term_changed` `{from_item_id, to_item_id}` (§2.3) |
| `saveDeliverables(itemId, rows)` | validates `content_types ⊆ CONTENT_TYPES` |
| `saveMilestones(itemId, rows)` / `toggleMilestone(id)` | manual check-off writes `completed_at/by` |
| `linkAgreementTask(itemId, taskId)` / `unlink…` | join-table write |
| `createAgreementFromQuotation(quotationId)` | seeds agreement + items from `quotation_items` (service_id, quantity, unit_price, currency); **(v2)** `commitment_type` defaults per line from the service: `retainer` when `services.pricing_type = 'retainer'`, else `one_time` (resolves the v1 default mismatch); sets `quotation_id`; event `quotation_linked`. Button appears on approved/converted quotations next to `convertToInvoice`. |
| `addAgreementNote(id, text, visibility)` | event `note`, visibility `internal│client` |
| *(Phase 2)* `addExtraWorkToDraft(itemId, month)` | §4.2, guards R1–R5 |
| *(Phase 2)* `recordCarryAdjustment(itemId, month, qty, reason)` | **(v2)** inserts a `client_agreement_adjustments` row (§2.3) + event `adjustment` — the event is the audit trail, the row is the computation input |

**Permission stripping:** `agreements.view` grants quantities and progress (quantities are non-financial — same call the app already makes for `tasks.quantity`); `unit_price/extra_unit_price/currency/fee totals` are stripped server-side without `agreements.view_pricing` via a new `stripAgreementPricing` in `src/lib/permissions/strip.ts`, and `PERMS.AGREEMENTS_VIEW_PRICING` joins `FINANCIAL_VISIBILITY_PERMS` (`keys.ts:175`).

**Nav** *(final decision, §12 #7)*: one `NavItem` placed **immediately after Quotations and before Invoices**: `{ label: 'Agreements', href: '/dashboard/agreements', icon: FileSignature, requiredPerm: 'agreements.view', keywords: ['contract','retainer','commitment','package','promised'] }`.

**Kill switch:** `company_settings` key `client_agreements`, value `'off'` disables all agreement UI surfaces (fail-open, `scope_client_services` grammar).

### 5.1 Agreement templates *(new in v2, C9 — Phase 2, design only)*

Many agreements reuse the same package ("Starter: 15 Posts, 10 Stories, 2 Reels, Monthly Report"). One table, no relational ceremony:

```sql
CREATE TABLE IF NOT EXISTS public.client_agreement_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',   -- { items: [{ service_id, commitment_type, cycle,
                                             --   committed_quantity, unit_price, currency,
                                             --   deliverables: [{ label, content_types, committed_quantity }] }] }
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Instantiation **copies** the payload into real item/deliverable rows and never reads the template again — no live linkage, no drift coupling; a `template_id` may be stamped on the agreement for analytics only. The JSONB-payload choice follows `report_layouts.layout_json` (*"so new layout settings can be added later without a schema migration"*, `migrations/013`); the alternative — code-defined CHECK-enum templates — is the pattern whose own migration documents the drift bug it caused (`20260714120000`: the schedules CHECK "was already stale before this change"). Ships with the Phase 2 migration alongside `client_agreement_adjustments`.

### 5.2 Approval workflow *(new in v2, C10 — status reserved now, workflow future)*

Cirqle already has a reusable, polymorphic approval engine — `migrations/017_approvals.sql` (*"One polymorphic engine for designs, invoices, quotations, expenses…"*): `entity_type/entity_id`, approver by employee / designation / permission, sequential chains via `approval_steps` (`021`), and a post-decision `effects.ts` registry that is explicitly *"the ONE place entity-specific behavior lives"*. **No new approval system will be built.** When the workflow is wanted: entity_type `'client_agreement'`, an effect that flips `pending_approval → active`, and role routing via the existing approver triple (Sales/Manager/Admin map to designations/permissions). Phase 1 only *reserves* `'pending_approval'` in the status CHECK (§2) — reserving it now is one line; adding it later is a CHECK migration, the one change the probe script cannot verify remotely.

---

## 6. UI design (wireframes)

### 6.1 Social Calendar header meter (Phase 1)

New row between the plan header (ends `social-calendar-client.tsx:1028`) and the view toggle (`:1031`), rendered only when the client+month has an active agreement with retainer items. Data arrives as a new optional prop from `page.tsx` (one extra batched query via `loadClientMonthProgress`; prop absent ⇒ nothing renders — un-migrated safe).

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Elara Luxe Perfume · August 2026      [3 Planned] [7 In Progress] [5 …]  │  ← existing chips
├──────────────────────────────────────────────────────────────────────────┤
│ AGR-2607-004 · Social Media Management            Committed 15 · Rem. 8  │
│  Feed Posts   ███████████░░░░░░  7 / 15   (12 planned ⚠ 3 under-planned) │
│  Stories      ████████████████░  9 / 10                                  │
│  Reels        ██████████████████ 2 / 2  +1 extra                         │
└──────────────────────────────────────────────────────────────────────────┘
```

Under-planning (`planned < committed`) tints the row amber; `extra > 0` shows a violet `+N extra` chip. Bars use the existing progress-chip palette. **(v2)** Committed figures are the *prorated* values (§3.1) — a retainer that started on the 22nd shows its prorated first-month quota, not the full 15; Planned/Delivered use the resolved-progress population, so the meter can never disagree with the chips beside it; a `paused` agreement shows a neutral "Paused" chip instead of bars.

### 6.2 Client page — Agreements card (Phase 1)

New `rounded-2xl` card in the **left** column of `client-detail-client.tsx`, above "Recent tasks" (it is workflow-first; fees inside it are gated by `agreements.view_pricing`):

```
┌─ Agreements ──────────────────────────────── View all ─┐
│ AGR-2607-004 · Brand & Social      [Active]  Renews —  │
│   Logo Design (one-time)      ●●●○○  3/5 milestones    │
│   Social Media Mgmt (monthly) ███░░  7/15 this month   │
│     Remaining 8 · Extra 0 ·  ⚠ 3 under-planned         │
└────────────────────────────────────────────────────────┘
```

### 6.3 Agreements dashboard `/dashboard/agreements` (Phase 1)

List page copying the requests/advertising table conventions (search, status filter dropdown from `STATUSES`, client filter, expiry sort):

```
Search [________]  Status [All ▾]  Client [All ▾]        + New Agreement
┌──────────┬──────────────┬──────────────┬──────────┬─────────┬─────────┐
│ Number   │ Client       │ This month   │ Renewal  │ Expiry  │ Status  │
├──────────┼──────────────┼──────────────┼──────────┼─────────┼─────────┤
│ AGR-2607…│ Elara Luxe   │ ███░░ 7/15   │ manual   │ —       │ Active  │
│ AGR-2606…│ Sea Star     │ █████ 20/20  │ auto     │ 31 Aug  │ Active  │
└──────────┴──────────────┴──────────────┴──────────┴─────────┴─────────┘
```

### 6.4 Agreement detail `/dashboard/agreements/[id]` (Phase 1; timeline pane Phase 2)

Header (number, client link, status chip, start/end, renewal, signed-document link, quotation link) · Items with inline deliverable/milestone editors (form styling and Combobox pattern copied from `employees/[id]/agreements/agreements-client.tsx`) · month navigator for progress · right rail: Timeline (Phase 2) rendering `client_agreement_events` like the request activity feed. **(v2)** Active items are edited through a **"Change terms"** flow (effective-date picker → close-and-replace, §2.3), and each item shows a collapsed **term history** accordion — the derived v1/v2/v3 windows with their quantities and prices, read straight from the temporal rows. Save-time overlap warnings (§3.2 rule 3) render in the same warning style as the employee-agreements form.

### 6.5 Monthly Report (Phase 2)

`PlanExportInput` (`src/lib/social/plan-export.ts:78`) gains an optional `commitments?: { label: string; committed: number; delivered: number }[]`; `renderPlanPdf`'s summary block renders a **separate** "Agreement" card — `Feed Posts — Delivered 15 / 15 committed` — never merged with the existing per-type tally (whose keys are display labels like "Post + Story", not raw types). **(v2)** The committed figures come from the term rows effective for the report's month, so re-exporting an old report after a renegotiation reproduces the original numbers.

### 6.6 Agreement health indicator *(new in v2, C8 — Phase 2, design only)*

Structural copy of `src/lib/advertising/health.ts` (verified): a pure function over the already-computed §3.1 numbers, weighted factors that **renormalize over available inputs**, `{score: 50, label: 'Unknown'}` when nothing is computable. Factors:

| Factor | Weight | Score |
|---|---|---|
| Pace | 0.35 | `clamp(100 − |delivered/committed − elapsedMonthFraction| × 100)` — the advertising `pacingScore` mirror |
| Planning coverage | 0.25 | `clamp(planned/committed × 100)` |
| Overload | 0.15 | `100` if extra = 0, else `clamp(100 − extra/committed × 200)` — over-delivery is unpaid work, a warning not a bonus |
| Expiry | 0.15 | `100` if no `end_date` or > 30 days out; linear to `0` at expiry while `renewal_type ≠ 'auto'` |
| Milestone lateness | 0.10 | share of milestones past `due_date` and incomplete, inverted |

Bands: **Healthy ≥ 70 · Warning 40–69 · Critical < 40**. Lives in `progress.ts`; surfaces as a chip column on the §6.3 dashboard and the client-page card. No implementation in Phase 1.


---

## 7. Notifications & cron (Phase 2)

New route `/api/cron/agreement-alerts`, daily `"30 4 * * *"` in `vercel.json` (Vercel Hobby: daily-or-slower only). Inline `authorized()` CRON_SECRET check, `createAdminClient`, per-item error accumulation, **awaited** `logCronRun(admin, 'agreement-alerts', …)` — the `recurring-tasks` template verbatim.

| Alert | Condition | `notifyAdmins` payload |
|---|---|---|
| Expiry | `status='active'`, `end_date` within 14 days (uses `client_agreements_expiry_idx`) | type `agreement_expiry`, sourceKey `agreement_expiry:{id}:{end_date}` — fires once per id+date (auto-renew Phase 3 reuses this window) |
| Under-delivery | day-of-month ≥ 24 (no existing month-end primitive — new code, `formatLocalDate`), any **active** retainer item with `remaining > 0` for the current month. **(v2)** `remaining` uses the *prorated* committed (§3.1) — an agreement that started on the 22nd cannot fire a false full-quota alert on day 2 — and `paused`/`draft` agreements are skipped | type `agreement_underdelivery`, sourceKey `agreement_underdelivery:{itemId}:{YYYY-MM}` — once per item per month. Message: *"Elara Luxe: 8 of 15 Feed Posts pending — 6 days left in August"*, link `/dashboard/agreements/{id}` |
| **(v2)** Expired transition | `status = 'active'`, `end_date < today`, `renewal_type ≠ 'auto'` → set `status = 'expired'` + event `expired` | keeps the reserved status real instead of decorative — the fate `quotations.valid_until` suffered (verified: displayed, never enforced anywhere) |

Both type strings join the `NotificationType` union (advisory — the field accepts ad-hoc strings). **`sourceKey` is mandatory**: the dedup index is partial (`WHERE source_key IS NOT NULL`); omitting it silently disables dedup. The bell UI needs zero changes (renders any type generically).

---

## 8. Client portal readiness (Phase 3, designed now)

- **Token**: `client_agreements.public_token` exists from Phase 1 (mirrors `invoices.public_token` → `/i/[token]`; format-guard + service-role fetch + middleware allowance). Future route: `/a/[token]`.
- **Projection**: a `projectClientAgreementView()` will map internal → client-safe exactly like `projectClientStatus` does for requests (e.g. `paused` shows as `active` until the team decides otherwise); events are pre-filtered by `visibility='client'` — the column exists and is indexed from day one.
- **Hub**: the client hub (`/start/[token]`) already derives visible apps from committed services (`getClientIntakeKinds`); an "Agreement" tab slots into that derivation with no schema change.
- Portal shows: agreement summary, deliverable progress bars, client-visible timeline, links to the public invoice views and monthly report PDFs — all read-through, nothing new stored.
- **(v2, C11)** Only three portal additions survive the "no speculative fields" test: the `visibility` column on **milestones** (in the Phase 1 schema — internal steps like "chase client for photos" must never leak; deliverables are client-facing by nature and need no flag), a **token-rotation** action for `public_token` in Phase 3 (the invoices precedent has no rotation; don't copy the gap), and reuse of the existing **`client_branding`** table for portal styling (verified: `white_label_mode`, colors, logos, one row per client — zero new fields needed).

### 8.1 AI readiness *(new in v2, C12 — nothing to build, and that is the finding)*

The architecture already supports future AI services without redesign, through three properties this plan preserves rather than creates: (1) the **generic `system_jobs` queue** (`20260629080000` + `20260629120000`: DAG dependencies, dead-letter, `requeue_stale_jobs`, worker registry in `src/lib/jobs/worker.ts`) — the advertising module's AI chain (`metrics_collection → forecast → health_score → recommendation`) is a proven in-repo blueprint; (2) the **pure, I/O-free progress engine** — deterministic feature extraction any job handler can call; (3) the **append-only events table** and deduped **notifications** channel for surfacing suggestions. Future features (predict under-delivery, recommend package upgrades, flag clients exceeding commitments, staffing suggestions) are new `JOB_HANDLERS` entries reading the same loaders — no schema change, no new infrastructure.

---

## 9. Migration & rollout plan

1. Add `supabase/migrations/20260722120000_client_agreements.sql` + paired rollback + probe entry. Apply by pasting into the Supabase SQL editor (house workflow); verify with `scripts/check-pending-migrations.mjs`.
2. Ship Phase 1 code. Every read of the new tables is defensive (try/catch → feature hidden), so deploy order vs. migration order cannot break existing screens — same contract the social calendar honors via its column-retry loops.
3. Regenerate `src/types/supabase.ts` after applying.
4. Seed the first real agreement (Elara Luxe) through the UI — it doubles as the acceptance test (§11).
5. Kill switch `client_agreements='off'` available throughout.
6. **(v2)** The Phase 2 additive migration ships `client_agreement_adjustments` + `client_agreement_templates` together (one manual apply), with its own rollback and probe entries.

### 9.1 Performance & scale *(new in v2, C7)*

The engine's hot path — delivered tasks per `(client, service, month)` — gets the composite partial index the migration adds (§2 section 9; verified missing today). With it:

- **100 clients** (multiples of today's scale): every surface is a handful of index range scans over tens of rows per client-month. Nothing else needed.
- **500 clients**: the batched IN-list loaders in `server.ts` (one query per table per page, never per-agreement loops) keep the dashboard at 4–5 set queries — comfortably sub-second in Postgres.
- **2,000 clients**: the only pressure point is the all-agreements dashboard when many items use `carry_forward` (bounded 24-month iteration each). First escape hatch: a plain SQL **view** (`agreement_month_rollup`) consolidating the per-month aggregation server-side — computed on read, doctrine-compliant. Last resort: a materialized view refreshed by the existing cron/jobs machinery — acceptable only as *disposable derived cache*, never as a source of truth.

**No application-level caching** is recommended at any of these scales — it is not justified by the query shapes, and the app's house pattern (`force-dynamic` pages + `router.refresh()`) assumes fresh reads.

---

## 10. Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Files-on-disk ≠ live schema (manual migrations; `biweekly`/`recurring_parent_id` already prove drift) | High | Idempotent SQL, rollback file, probe, defensive reads, types regen after apply |
| Retainer flat-billing hazard: per-post tasks under a retainer service each re-bill the fee (existing behavior the meter will expose) | High (money) | Phase 1 is read-only on billing; **(v2)** the ensured pricing row is price-less (§2.1) so agreement activation cannot arm the trap; editor warns on retainer-service/deliverable-service collision (§4.1) |
| **(v2)** Temporal misuse: an in-place `UPDATE` of an active item's terms would silently corrupt history | High | The actions API exposes no in-place update for active items — only `changeAgreementItemTerms` (close-and-replace); draft-only editing enforced in `saveAgreementItem`; golden test: edit terms in September, assert July output unchanged |
| Extra-work billing: double billing / currency mixing / duplicate lines | High (money) | **(v2)** guards R1–R5 (§4.2): zero-billed-units-only default with operator confirmation, currency-match abort, idempotent description key, draft-only, term-row-stable |
| Attribution gaps: direct tasks bypass the calendar; `social_meta` tag is best-effort | Medium | Item-level task-count safety net + "+N outside calendar" hint + manual link table (§3.2 rule 5) |
| **(v2)** Mid-month starts/changes/pauses make quotas confusing | Medium | One proration formula for all of them (§3.1), surfaced in the meter as the prorated figure; unit tests on rounding and window edges |
| Dashboard progress cost across many agreements/months | Medium | **(v2)** composite task index ships in the Phase 1 migration; batched IN-list queries; carry bounded to the term chain ≤ 24 months; SQL view escape hatch (§9.1) |
| Financial leakage via RSC payloads | Medium | Server-side `stripAgreementPricing` before payloads leave the server (strip.ts rule), perm in `FINANCIAL_VISIBILITY_PERMS` |
| Timezone/month-keying bugs (invoice YYMM is issue month = task month + 1) | Medium | Engine keys exclusively on plan/task month; `formatLocalDate` everywhere; unit tests on month boundaries (Dec→Jan) |
| Meter/chips population divergence | Low | **(v2)** both use the resolved-progress population (`resolveItemProgress`), one rule everywhere (§3.1) |
| Payroll-protected months | Low | Progress only reads task statuses; no earnings writes |
| Giant-component merge risk | Low | New module = new files; calendar/client-page edits are additive blocks |

---

## 11. Phase-wise implementation

**Phase 1 — Database, agreement module, items, calendar meter** *(v2: architecture-critical review items folded in)*
Migration (all 6 tables **with temporal item columns, reserved `pending_approval`, milestone `due_date`/`visibility`, permission band 85–87, composite task index**) · `lib/agreements/*` (types, numbering, progress **with term resolution, proration, and the §3.2 counting rules; monthly cycle only**, server, events) · PERMS + nav + kill switch + stripping · price-less pricing-row sync (§2.1) · `/dashboard/agreements` list + editor + detail (draft editing, change-terms flow, term history; timeline data recorded, pane hidden) · quotation → agreement conversion · client-page card · calendar header meter (prorated).
*Acceptance:* create the Elara Luxe agreement (Appendix A) through the UI; the calendar meter shows the **prorated** July quota (5, not 15 — start date 22 July) and no false under-delivery is possible; planning items moves Planned; pushing→promoting→completing moves Delivered; a post with a story variant counts toward both deliverables; **the golden history test passes — change the retainer to 20/mo effective September, and July/August outputs are byte-identical**; the 16th completed post shows `+1 extra`; a viewer without `agreements.view_pricing` sees progress but no fees; with the migration unapplied (staging), every surface hides cleanly.

**Phase 2 — Reports, notifications, timeline** *(v2: + adjustments, templates, health, expired)*
Phase 2 additive migration (`client_agreement_adjustments` + `client_agreement_templates`, §2.3/§5.1) · Monthly Report "Delivered X / Y committed" block (term-row-stable) · `/api/cron/agreement-alerts` + vercel.json entry (prorated under-delivery, expiry, **`expired` transition**) · timeline pane · `addExtraWorkToDraft` with guards R1–R5 · `recordCarryAdjustment` + un-hide the `manual` carry rule · health-score chip (§6.6) · template picker on agreement creation.
*Acceptance:* report PDF shows the commitments card and reproduces old months after a renegotiation; expiry + under-delivery alerts dedup correctly (re-run cron → no duplicates); an extra-work line never duplicates a task's own billed line, appears once, updates idempotently, and aborts on currency mismatch; an agreement past `end_date` flips to `expired`.

**Phase 3 — Client portal, renewal automation, approvals**
`/a/[token]` public view with client-visibility projection + `public_token` rotation · auto-renew (cron extends `end_date` by cycle for `renewal_type='auto'`, logs `renewed`, notifies) · approval workflow via the existing approvals engine (§5.2) · signed-document upload bucket (social-refs pattern).

---

## 12. Decisions *(revised in v2)*

**Resolved by the architectural review (stand unless Farooq objects):**

1. `auto_renew` folded into `renewal_type` — **stands** (single source of truth).
2. Milestone manual check-off stores `completed_at` — **stands**, now with `due_date` and `visibility` alongside (§3.4).
3. Planned population — **redefined (v2)**: resolved progress (`resolveItemProgress ≠ 'cancelled'`), the exact chips population; still includes Idea-Board items (§3.1).
4. All six tables in the Phase 1 migration — **stands**; the Phase 2 migration adds only `client_agreement_adjustments` + `client_agreement_templates`.
5. Extra-work invoicing manual-trigger per month — **stands**, hardened by guards R1–R5 (§4.2).
6. Terms are temporal from day one; cycle ships monthly-only; `pending_approval` reserved now — **new v2 decisions**, rationale in §2.3, §3.2 rule 6, §5.2.

**Resolved by Farooq (2026-07-22, implementation authorization):**

7. Nav placement: **immediately after Quotations, before Invoices/Billing** — agreements are commercial commitments in the Leads → Enquiries → Quotations → Agreements → … → Invoices flow, not operational work.
8. Elara Luxe logo: **AED 150, one-time** (confirmed; Appendix A updated).
9. Default milestone `visibility`: **`internal`** — client-visible milestones must be explicitly marked `client`.

---

## Appendix A — The Elara Luxe agreement (first real data)

```
client_agreements:   AGR-2607-004 · client 004 (Elara Luxe Perfume) · 'Brand Identity & Social Media'
                     status active · start 2026-07-22 · end NULL (month-to-month) · renewal manual
                     quotation_id → (record the signed proposal as a quotation first)
items (term rows, effective_from 2026-07-22, effective_to NULL):
  1. Logo & Brand Identity · one_time  · unit_price 150 AED (confirmed, §12 #8)
     milestones: Research → Concept 1 → Concept 2 → Revisions (2 rounds) → Brand Chart → Final Files
     (extra concepts beyond 2 = AED 50 each → the existing 'concept' variant-task type)
  2. Social Media Management · retainer · cycle monthly · unit_price 400 AED · carry_forward_rule expire
     extra_unit_price: set if extra posts should be billable
     deliverables: Feed Posts 15 × {post, carousel} ·
                   (optionally: Stories n × {story}, Reels n × {reel}, Monthly Report 1 × {other})

July 2026 committed (v2, prorated §3.1): 15 × 10 active days / 31 = 4.84 → **5** Feed Posts;
full 15/month from August. A later renegotiation (e.g. 20/mo from October) closes term row 2
and inserts its successor — July–September reports stay exactly as they were.
```
