# Handoff — Performance Analytics from Group/Parameter Weights

## Who I am & the system

I run **Cirqle Design**, a design agency. We have an internal ERP at `/Users/farooq/cirqle-app`:
- **Stack**: Next.js (App Router, server components), Supabase (Postgres + RLS), Recharts, TypeScript
- **Domain**: tasks, employee contributions, commission calculations, payroll, invoicing
- **Important**: this is NOT the Next.js you know from training. Read `node_modules/next/dist/docs/` before writing Next.js code. Don't trust defaults.

## What I'm trying to do

Build **employee performance analytics** that leverage our existing group/parameter/weight structure to answer:

1. Who is strongest at what skill? (per-parameter strength per employee)
2. Where are our team's skill gaps and bus-factor risks?
3. Who actually produced each task's output? (production-owner inference)
4. Is this employee genuinely improving over time? (trend evidence for promotions/ratings)
5. Which employees fit which client/service types?

Currently we collapse every contribution into a single `score_percentage` and throw away all the granularity. The raw per-parameter data is already in the database — we just never aggregate it for analytics.

## My requirements (non-negotiable)

1. **Don't touch `src/lib/calculations/commission.ts`** — payroll math stays unchanged. We only **read** the same rows it writes from.
2. **Server-side financial gating** — `earnings_inr`, `commission_amount`, `billing_amount` must be stripped in `page.tsx` (server component) before serialising to client. Employee dashboards never receive other employees' financials in the payload.
3. **`!inner` joins + `.gt('score_percentage', 0)`** on every `contribution_scores` query. We just spent a week purging 1,690 phantom 0% rows created by a bad bulk-import recalc. Don't reintroduce the bug.
4. **Window historical analytics by `tasks.task_date`, never by `calculated_at`** — `calculated_at` is the recalc timestamp, not the work date. Using it skews timelines.
5. **Per (task, employee) dedup** keeping newest `calculated_at`. Already enforced by `UNIQUE (task_id, employee_id)` in migration `007_cleanup_contribution_scores.sql`.
6. **Admin vs employee gating** — `loadCurrentUser()` returns `{ isAdmin, employeeId }`. Admin sees team-wide, employee sees only their own row and aggregated team comparisons (never other people's earnings).
7. **No Redis, no new infra** — Postgres + in-memory aggregation. Data is small (<50k contribution rows even at 3-year horizon).
8. **No `suppressHydrationWarning` hacks** — fix root cause for any hydration mismatch.
9. **No generic ERP advice.** If you don't know the schema, read it. If you don't know the commission logic, read `commission.ts` end-to-end.

## Background — the commission model

Every task can be split across employees through a structured contribution system:

- **Contribution Groups** (e.g. "Design", "Variable", "Client") — each has a `weight`.
- **Parameters** (e.g. "Concept", "Execution", "Revisions") — each belongs to a group and has its own `weight`.
- **Master Parameter** — one designated parameter per group that represents the core deliverable. (Schema flag may not exist yet — Phase 1 adds it.)
- **Tools** (e.g. Ideogram, Midjourney) — flat % deductions per group.

Each task must include **at least 1 group and 1 parameter** (hard rule).

When admin saves contributions:
- For each employee × parameter, admin enters a numeric `value` (e.g. # pages, # revisions handled, # concepts)
- `commission.ts` computes a final `score_percentage` per employee for that task
- Earnings = `pool × score% × performance_rating%`

### Key tables

```sql
contributions(task_id, employee_id, parameter_id, value)  -- raw inputs, ALL granularity preserved
contribution_scores(task_id, employee_id, score_percentage, earnings_inr, calculated_at)
parameters(id, group_id, name, weight)                    -- need to add is_master in Phase 1
contribution_groups(id, name, weight)
tasks(id, task_date, billing_amount_inr, quantity, service_id, client_id, ...)
employees(id, name, performance_rating, is_active, ...)
tools(id, group_id, name, fixed_percentage)
```

### Key code

- `src/lib/calculations/commission.ts` — the calculation engine. Read end-to-end before writing aggregation logic. It computes group breakdowns (`groupBreakdown[]`) in memory then discards them.
- `src/lib/permissions/check.ts` — `loadCurrentUser()` for auth
- `src/lib/supabase/server.ts` — `createAdminClient`, `fetchAll`, `stablePaginationQuery`
- `src/app/(dashboard)/dashboard/page.tsx` — admin/employee dashboard server fetch
- `src/app/(dashboard)/dashboard/reports/page.tsx` — reports server fetch
- `src/app/(dashboard)/dashboard/contributions/contributions-client.tsx` — where contributions are saved (lines ~610-715)

## The discovery that drives this plan

The `contributions` table stores raw per-parameter inputs for every task ever recorded:

```
contributions(task_id, employee_id, parameter_id, value)
```

So we have the full breakdown — who scored what on which parameter — for the entire history of the app. We can build deep analytics:
- **Zero data migration** (data is already there)
- **Full historical coverage** (going back to day one)
- **Without touching payroll math** (`calculateCommission` keeps working unchanged)

## The production-owner trick

Each group has a **master parameter** (the one representing the core deliverable — e.g. "Design Execution" in the Design group).

```
production_owner(task) =
  argmax_employee( contributions.value
                   WHERE parameter_id = master_param_of(dominant_group(task)) )
```

Where `dominant_group(task)` = the group with the highest sum of contribution values on that task.

This derives the production owner from existing data — no manual entry — correct for ~80% of tasks. Manual override (`primary_producer_id`) becomes the rare exception, not the rule.

## What this analytics unlocks

| Analytic | Question | Today | After |
|---|---|---|---|
| Skill heatmap | Who's strongest at Concept vs Execution vs Revisions? | Impossible | One query |
| Group strength | Is CQID002 a Design specialist or Variable specialist? | Impossible | One query |
| Bus-factor | If CQID005 leaves, what capability dies? | Guess | Measured |
| Training gap | Which parameters does the team score low on? | Guess | Measured |
| Production owner | Who actually made this task's output? | Unknown | Inferred from master-param |
| Promotion evidence | Has X improved on hard skills over 6 months? | Vibes | Trend chart |
| Assignment fit | Which employees should be on Brand vs Social work? | Manager memory | Data-driven |

---

## The detailed plan — 6 phases, ~10 days

### Phase 1 — Master parameter schema flag (1 day)

Add a master flag to `parameters`. Check current schema first; may partially exist.

```sql
-- migrations/008_parameters_is_master.sql
ALTER TABLE parameters ADD COLUMN IF NOT EXISTS is_master BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_parameters_one_master_per_group
  ON parameters(group_id) WHERE is_master = true;
```

Settings UI (`/dashboard/settings`) gets a "Master" toggle per parameter. Enforce one master per group at UI + DB level.

**Deliverable**: migration file + settings UI toggle + brief data-entry pass to mark existing master parameters.

---

### Phase 2 — Pure aggregation helpers (2 days)

Create `src/lib/analytics/performance.ts`. Pure functions, no DB writes, no I/O — just transformations:

```typescript
type ContribRow = { task_id: string; employee_id: string; parameter_id: string; value: number }
type Param      = { id: string; group_id: string; name: string; weight: number; is_master: boolean }
type Group      = { id: string; name: string; weight: number }

// Per-employee mean strength per parameter (0-100, normalized as team-relative share averaged across tasks)
export function aggregateEmployeeByParameter(
  contributions: ContribRow[],
  parameters: Param[]
): Record<EmployeeId, Record<ParameterId, { score: number; taskCount: number }>>

// Per-employee strength per group (weighted roll-up using parameter weights, matching commission.ts active-param logic)
export function aggregateEmployeeByGroup(
  contributions: ContribRow[],
  parameters: Param[],
  groups: Group[]
): Record<EmployeeId, Record<GroupId, { score: number; taskCount: number }>>

// Derived production owner for a task
export function inferProductionOwner(
  taskId: string,
  contributions: ContribRow[],
  parameters: Param[]
): { employeeId: string; confidence: number } | null

// Map score to UI band
export function bandStrength(score: number): 'Expert' | 'Strong' | 'Developing' | 'Learning'

// Team coverage per parameter — bus-factor risk
export function teamCoverage(
  aggregated: ReturnType<typeof aggregateEmployeeByParameter>,
  parameterId: string
): { strongCount: number; totalCount: number; risk: 'high' | 'medium' | 'low' }
```

**Aggregation logic must mirror `commission.ts`:**
- Per parameter `p`: for each task, employee's share = `empValue / totalValueOfParamOnThatTask`. Average across all tasks where employee participated on that parameter.
- Per group: roll up parameter shares using `parameter.weight`, normalized to **active parameters only** (parameters with at least one non-zero contribution on that task — same as `commission.ts` line ~128).
- For production owner: filter to (taskId, master_param of dominant group), take argmax. Confidence = `topShare / secondShare` (capped at 10).

**Deliverable**: `performance.ts` + `performance.test.ts` with unit tests covering: single-employee task, multi-employee even split, weighted parameter roll-up, missing master parameter, empty contributions. **No UI changes yet.**

---

### Phase 3 — Reports tab: "Skills & Performance" (3-4 days)

New tab in `src/app/(dashboard)/dashboard/reports/reports-client.tsx`. Server fetch in `reports/page.tsx` already pulls scores; extend it to also pull `contributions` joined with parameter + group metadata for the same 24-month window.

Four widgets in the tab:

**A. Skill Heatmap**
Grid: rows = employees, cols = parameters (visually grouped by their group). Each cell colored by `bandStrength()`. Hover shows raw score + task count. Click drills into contributing tasks.

**B. Group Radar Charts**
One radar per selected employee (multi-select dropdown). Axes = groups. Shows where each person concentrates.

**C. Team Coverage Bars**
Horizontal bar per parameter. Length = % of team scoring Strong+. Red label for `risk: 'high'` (bus-factor warning).

**D. Strength Trend Lines**
Per-employee + per-parameter selection. Monthly score line over last 12 months. Shows trajectory.

**Deliverable**: 4 components in `src/app/(dashboard)/dashboard/reports/_skills/` + integration in `reports-client.tsx`.

---

### Phase 4 — Employee dashboard "Your Strengths" card (2 days)

In `src/app/(dashboard)/dashboard/dashboard-client.tsx` employee section: a new card showing the logged-in employee:
- Their top 3 parameters with strength band + team rank ("3rd strongest at Concept across 18 team members")
- 1 growth area (lowest-scored parameter they have ≥3 tasks on)
- Versatility: parameters worked on / parameters available

**Deliverable**: `MyStrengthsCard` component, slotted above existing employee KPIs.

---

### Phase 5 — Production owner everywhere (2 days)

- Replace "Top Clients by Production Volume" in `reports-client.tsx` to count tasks where employee was the inferred production owner (current implementation uses `quantity × score%` which is misleading — see context below).
- Add "Producer" column to recent tasks lists (dashboard + tasks page).
- Add optional `primary_producer_id UUID REFERENCES employees(id)` to `tasks` table for the ~20% manual override cases.
- Task form gets a "Producer" dropdown (optional, defaults to inferred value, admin can override).

**Deliverable**: `migrations/009_primary_producer_id.sql` + task form field + replaced production-volume widget.

---

### Phase 6 — Performance rating suggestions (1 day)

Extend `calculatePerformanceScore()` in `commission.ts:199`. Currently uses only `avgScore`. Add components:
- **Versatility** (15%): how many parameters they're active on
- **Master strength** (20%): avg score on master parameters across groups they touch
- **Trend** (10%): is their 90-day avg trending vs prior 90 days

Suggestion text becomes diagnostic, not generic:
> "Strong on Concept and Execution, but participates in only 4 of 12 parameters. Consider cross-training opportunities."

**Deliverable**: updated `calculatePerformanceScore` + surfaced on employee detail page in settings.

---

## Context from recent work you should know

- **`tasks.quantity`** column exists (decimal, default 1) — number of creatives/pages per task. Used in billing and recently added to dashboard/reports as a "creatives" metric using `quantity × score% / 100`. This formula is **financially correct** (mirrors earnings split) but **production-misleading** because `score%` measures effort/value distribution, not physical output. Phase 5 replaces it with proper production-owner inference.
- **`migrations/007_cleanup_contribution_scores.sql`** has been applied — purged 0% rows, deleted orphans, added `UNIQUE (task_id, employee_id)`.
- **`migrations/005_granular_permissions.sql` and `006_rls_enforce_auth.sql`** — status unverified; if any data security work is needed, confirm these are applied first.

## What I want you to start with

**Phases 1 + 2** only. Land them in ~3 days. Then we preview the Skill Heatmap (Phase 3 first widget) before committing to phases 3-6.

Before writing code:

1. **Confirm `parameters.is_master` doesn't already exist** — check current schema.
2. **Verify raw `contributions(task_id, employee_id, parameter_id, value)` rows exist** for recent date ranges with reasonable density. If sparse, flag before proceeding.
3. **Read `src/lib/calculations/commission.ts` end-to-end** so aggregation logic mirrors it exactly (especially the active-parameter normalization at line ~128 and effective group weights at line ~105).

Then deliver:
- `migrations/008_parameters_is_master.sql`
- `src/lib/analytics/performance.ts`
- `src/lib/analytics/performance.test.ts`
- Settings UI toggle for `is_master`

**Stop for review before touching any other UI files.**
