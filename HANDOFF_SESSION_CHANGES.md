# Handoff — Session Changes Log

This is a complete summary of work done in the previous session on the Cirqle ERP. Pair this with `HANDOFF_PERFORMANCE_ANALYTICS.md` (the forward plan).

## TL;DR

- **Fixed a critical data corruption issue**: CQID002 showed 47 phantom 2023 contributions despite joining post-2024. Root cause: 1,690 placeholder `score_percentage = 0` rows from a bulk-import recalc run.
- **Hardened all contribution queries** to filter `0%` rows and use `!inner` joins with `task_date` windowing (never `calculated_at`).
- **Created and applied `migrations/007_cleanup_contribution_scores.sql`** — purges 0% rows, NULL orphans, stale FK rows, dedups, locks schema with `NOT NULL` + `UNIQUE`.
- **Added "creative (quantity)" analytics** across dashboard and reports using `tasks.quantity × score_percentage / 100`.
- **Identified that the creative formula is financially correct but production-misleading** (score% measures value distribution, not physical output). Forward plan captured in companion handoff doc.
- **Fixed a latent bug** in `reports/page.tsx` that had the same outer-join + `calculated_at` issue as the dashboard previously had.

---

## Files modified

### 1. `src/app/(dashboard)/dashboard/page.tsx`

**What changed:**
- Added `quantity` to 4 task selects (analytics, display, today, scores joins).
- Added `.gt('score_percentage', 0)` to admin scores, employee scores, and `pendingContribCount` queries.
- Admin scores join: `task:tasks!inner(id, task_date, quantity)`
- Employee scores join: `id, task_number, task_date, title, status, quantity, client:clients(name), service:services(name)`
- `pendingContribCount` scoredRes: `.gt('score_percentage', 0)` — treats 0% as "not yet contributed".

**Why:**
- `quantity` powers creative analytics.
- `.gt(score_percentage, 0)` excludes bulk-import placeholder rows that were inflating contribution counts and timelines.

### 2. `src/app/(dashboard)/dashboard/reports/page.tsx`

**What changed:**
```typescript
const scoresBase = supabase
  .from('contribution_scores')
  .select('id, employee_id, task_id, score_percentage, earnings_inr, calculated_at, task:tasks!inner(id, title, task_date, billing_amount_inr, service_id, quantity, client:clients(id, name))')
  .not('task_id', 'is', null)
  .gt('score_percentage', 0)
  .gte('tasks.task_date', windowFromStr)  // was .gte('calculated_at', ...) — latent bug fixed
  .order('calculated_at', { ascending: false })
  .order('id', { ascending: true })
```
- Switched from outer join to `!inner`.
- Added `.gt('score_percentage', 0)`.
- Windowed by `tasks.task_date` instead of `calculated_at`.
- Added `quantity` to the join and to the employee-tasks reconstruction loop (lines 66-83).

**Why:**
- Same corruption pattern as dashboard. Reports page had been silently leaking 0% rows and recalc-history pollution.
- `calculated_at` is the recalc timestamp, not the work date — windowing by it skews historical analytics.

### 3. `src/app/(dashboard)/dashboard/dashboard-client.tsx`

**Major additions:**

**(a) Employee creative aggregates:**
```typescript
const myCreatives = useMemo(() => {
  let total = 0
  for (const s of filteredScores) {
    const qty   = Number(s.task?.quantity ?? 1)
    const share = (s.score_percentage ?? 0) / 100
    total += qty * share
  }
  return total
}, [filteredScores])
const avgCreativesPerTask = myContributions > 0 ? myCreatives / myContributions : 0
```

**(b) KPI grid expanded** from 2 to 4 cards (`grid-cols-2 lg:grid-cols-4`):
- My Contributions
- My Creatives
- Avg Score
- Avg Creatives/Task

**(c) `trendData` updated to track both tasks and creatives per period:**
```typescript
const trendData = useMemo(() => {
  const map: Record<string, { count: number; creatives: number }> = {}
  for (const s of filteredScores) {
    const k = getPeriodKey(d, granularity)
    if (!k) continue
    if (!map[k]) map[k] = { count: 0, creatives: 0 }
    map[k].count += 1
    const qty = Number(s.task?.quantity ?? 1)
    const share = (s.score_percentage ?? 0) / 100
    map[k].creatives += qty * share
  }
  return [...].map(([k, v]) => ({
    period, count: v.count, creatives: Math.round(v.creatives * 10) / 10
  }))
}, [filteredScores, granularity])
```

**(d) `teamEarnings` updated with per-employee creatives:**
```typescript
const creatives = filtered.reduce((acc, e) => {
  const qty   = Number(e.task?.quantity ?? 1)
  const share = (e.score_percentage ?? 0) / 100
  return acc + qty * share
}, 0)
return { ...emp, earnings, taskCount, creatives }
```

**(e) New admin `productionTotals` aggregate:**
```typescript
const productionTotals = useMemo(() => {
  const src = dateFilter ? allAnalyticsTasks.filter(...) : allAnalyticsTasks
  let creatives = 0
  for (const t of src) creatives += Number(t.quantity ?? 1)
  return { tasks: src.length, creatives }
}, [allAnalyticsTasks, dateFilter])
```

**(f) New "Production Output" KPI strip** inserted between financial KPIs and Business Pulse tabs (admin view).

**(g) Team Earnings tiles updated:**
```tsx
<p className="text-[10px] text-muted-foreground/70 leading-tight mt-0.5">
  {emp.taskCount} task{...} · {emp.creatives.toLocaleString('en-IN', { maximumFractionDigits: 1 })} creative{...}
</p>
```

**(h) Recent Contributions table shows per-row creative share:**
```tsx
{Number(t.quantity ?? 1) > 1 && (
  <span className="text-[10px] text-teal-400 font-medium tabular-nums">
    {(Number(t.quantity) * pct / 100).toLocaleString('en-IN', { maximumFractionDigits: 1 })} cr.
  </span>
)}
```

### 4. `src/app/(dashboard)/dashboard/_charts.tsx`

**What changed:**
`ContributionActivityBar` now accepts optional `creatives` field and overlays a second teal bar when data has any non-zero creative values.

```typescript
export function ContributionActivityBar({
  data,
}: {
  data: { period: string; count: number; creatives?: number }[]
}) {
  const hasCreatives = data.some(d => (d.creatives ?? 0) > 0)
  // ...
  <Bar dataKey="count"     fill="#a855f7" radius={[4, 4, 0, 0]} maxBarSize={28} name="Tasks" />
  {hasCreatives && (
    <Bar dataKey="creatives" fill="#14b8a6" radius={[4, 4, 0, 0]} maxBarSize={28} name="Creatives" />
  )}
}
```

### 5. `src/app/(dashboard)/dashboard/reports/reports-client.tsx`

**What changed:**
- Added `quantity?: number` to `Score` and `Task` interfaces.
- Added computations: `totalCreatives`, `avgCreativesPerTask`, `productionTotals`, `creativesByClient`.
- Added a "Production stats" row (4 cards: My Creatives, Avg/Task, Studio Tasks, Studio Creatives).
- Added a "Top Clients by Production Volume" table:
```tsx
<div className="grid grid-cols-[1fr_80px_80px_80px] gap-2">
  // Client | Tasks | Creatives (teal) | Per Task
</div>
```

---

## Files created

### `migrations/007_cleanup_contribution_scores.sql`

```sql
BEGIN;

-- Step 1: Delete 0% score rows (THE critical fix — these were inflating counts)
DELETE FROM contribution_scores WHERE score_percentage = 0 OR score_percentage IS NULL;

-- Step 2: Delete NULL task_id orphans
DELETE FROM contribution_scores WHERE task_id IS NULL;

-- Step 3: Delete stale FK rows (task referenced no longer exists)
DELETE FROM contribution_scores cs
WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = cs.task_id);

-- Step 4: Deduplicate (task, employee) keeping newest calculated_at
-- NOTE: initial draft used SELECT MAX(id) — that fails because id is UUID.
-- Corrected to DISTINCT ON.
DELETE FROM contribution_scores
WHERE id NOT IN (
  SELECT DISTINCT ON (task_id, employee_id) id
  FROM contribution_scores
  ORDER BY task_id, employee_id, calculated_at DESC
);

-- Step 5: Lock task_id as NOT NULL going forward
ALTER TABLE contribution_scores ALTER COLUMN task_id SET NOT NULL;

-- Step 6: Recreate UNIQUE constraint to prevent future dupes
ALTER TABLE contribution_scores
  ADD CONSTRAINT contribution_scores_task_employee_unique UNIQUE (task_id, employee_id);

COMMIT;
```

**Status: applied.** Verified via SQL query — CQID002's pre-2024 phantom rows are gone, contribution counts went from 1,690 inflated to 990 real.

**Pre-existing migrations possibly still pending (verify state before assuming):**
- `migrations/005_granular_permissions.sql`
- `migrations/006_rls_enforce_auth.sql`

---

## Bugs found and fixed (root causes)

### Bug 1: CQID002 phantom 2023 contributions (CRITICAL)

**Symptom:** Employee CQID002 (joined 2024+) showed 47 contribution rows dated 2023, inflating total contributions to 1,690 (which equaled the company's total task count — a smoking gun).

**Root cause:** A bulk-import recalc pipeline created `contribution_scores` rows with `score_percentage = 0` for **every** employee on **every** task in history — including employees who never touched those tasks. These were valid FK rows (not orphans), so `!inner` joins didn't exclude them.

**Three-layer fix:**
1. Server query filter: `.gt('score_percentage', 0)` on every contribution_scores read.
2. DB migration `007` to purge existing 0% rows.
3. Relabeling 0% semantics: "0% score = no real contribution made" (was previously "assigned but pending").

### Bug 2: Reports page outer-join + `calculated_at` window (LATENT)

**Symptom:** None visible yet — would have surfaced as the same kind of pollution as Bug 1 once Reports got more user traffic.

**Root cause:** `reports/page.tsx` was filtering by `.gte('calculated_at', ...)` instead of `tasks.task_date`, and using outer join instead of `!inner`. Same pattern that had previously been fixed on the dashboard.

**Fix:** Mirror the dashboard pattern — `!inner` join, `.gt('score_percentage', 0)`, `.gte('tasks.task_date', windowFromStr)`.

### Bug 3: Migration step 4 SQL error (PROCESS)

**Symptom:** First draft of dedup step used `SELECT MAX(id) FROM contribution_scores GROUP BY task_id, employee_id` — PostgreSQL errored with `function max(uuid) does not exist`.

**Fix:** Switched to `SELECT DISTINCT ON (task_id, employee_id) id FROM contribution_scores ORDER BY task_id, employee_id, calculated_at DESC`.

---

## Architectural audit conclusions

Conducted a deep audit of whether `quantity × score_percentage / 100` is a valid "creatives produced" metric.

**Verdict:**
- **Financially correct** — it mirrors how earnings split. The number a row generates is consistent with the money it generates.
- **Production-incorrect** — `score_percentage` is a value-allocation key (output of `commission.ts`), not a physical output counter. An employee who scores 30% by reviewing/prompting may have touched zero pages, yet the formula reports `10 × 30% = 3 creatives`.

**Three-ledger architecture required for full correctness:**

| Ledger | Purpose | Status |
|---|---|---|
| **Effort/Value** | `contribution_scores` — who contributed how much value | ✅ Built |
| **Production** | who physically made the output | ❌ Missing |
| **Quality** | how good the output was | 🟡 Partial (via performance_rating) |

**Recommended actions** (forward plan):

1. **Week 1**: Relabel per-employee "Creatives" → "Credited Output Share" in UI to stop misleading production decisions.
2. **Near-term**: Derive a production owner from existing data using master-parameter argmax (see `HANDOFF_PERFORMANCE_ANALYTICS.md` Phase 5).
3. **Optional override**: Add `tasks.primary_producer_id UUID REFERENCES employees(id)` for manual correction on the ~20% of tasks where inference is wrong.
4. **Long-term**: A `creatives` table for multi-creative tasks (1 row per output, each with `produced_by`).

---

## Verified outcomes

Browser preview confirmed after all changes:
- Studio tasks total: **1,691**
- Studio creatives total: **2,702**
- Avg creatives/task: **1.6**
- CQID002 contributions: **990 real** (down from 1,690 inflated)
- Top Clients by Production Volume table rendering with real data
- Recent Contributions row-level creative share rendering for tasks with `quantity > 1`

---

## What's still pending after this session

These were called out but not completed:

1. **Verify migrations `005_granular_permissions.sql` + `006_rls_enforce_auth.sql`** are applied to production Supabase.
2. **Validate CQID002 employee dashboard manually** — login as employee account, confirm chart shows only 2024+ data.
3. **Convert settings-client mutations (~60)** from direct anon-client Supabase calls to server actions.
4. **Convert mutations in invoices-client, tasks-client, contributions-client, quotations-client** to server actions.
5. **Relabel per-employee "creatives" metric** to "Credited Output Share" (or similar) per audit recommendation.
6. **Implement the performance-analytics plan** in `HANDOFF_PERFORMANCE_ANALYTICS.md` — Phase 1 (master parameter flag) onward.

---

## Files touched (reference list)

**Modified:**
- `src/app/(dashboard)/dashboard/page.tsx`
- `src/app/(dashboard)/dashboard/reports/page.tsx`
- `src/app/(dashboard)/dashboard/dashboard-client.tsx`
- `src/app/(dashboard)/dashboard/_charts.tsx`
- `src/app/(dashboard)/dashboard/reports/reports-client.tsx`

**Created:**
- `migrations/007_cleanup_contribution_scores.sql`

**Not modified but read for context:**
- `src/lib/calculations/commission.ts`
- `src/app/(dashboard)/dashboard/contributions/page.tsx`
- `src/app/(dashboard)/dashboard/contributions/contributions-client.tsx`

---

## Key invariants now enforced (don't break these)

1. Every `contribution_scores` read uses `!inner` join + `.gt('score_percentage', 0)`.
2. Historical analytics window by `tasks.task_date`, not `calculated_at`.
3. `contribution_scores.task_id IS NOT NULL` (schema-enforced).
4. `UNIQUE (task_id, employee_id)` on `contribution_scores` (schema-enforced).
5. Per (task, employee) dedup keeps newest `calculated_at` — order DESC, take first.
6. Server-side strip of `earnings_inr`/`billing_amount_inr` before serialising to non-admin clients.
