> **SUPERSEDED IN PART (5 Aug 2026):** see the header of FINANCIAL-CORE-SPEC.md.
> Only step 3.0 was implemented (5 Aug 2026); steps 3.1–3.6 require re-scoping
> against `lib/tasks/pricing.ts` before any of this plan is followed.

# Phase 3 — Implementation Plan

**Role:** lead engineer sign-off on building `FINANCIAL-CORE-SPEC.md`
**Date:** 2 August 2026 · Architecture is final; this document is about *how to land it safely*.

---

## 0. Two measurements that change the plan

I measured production before planning. Both results invert conventional sequencing advice.

### 0.1 The dataset is tiny — stop engineering for scale you don't have

| Table | Rows |
|---|---|
| tasks | 1,876 |
| contribution_scores | 5,267 |
| invoice_items | 1,857 |
| contributions | 2,125 |
| client_service_pricing | 817 |
| invoices | 262 |
| payroll | 83 |
| services | 41 |
| **client_agreement_items** | **2** |
| **tasks with a coverage stamp** | **2** |

Every migration in the spec touches thousands of rows at most. On Postgres that is **seconds**, not minutes. Concretely:

- No zero-downtime choreography is required. No dual-write phases, no shadow tables, no online backfill jobs.
- A migration + backfill + verify cycle fits inside a normal deploy.
- `CREATE INDEX CONCURRENTLY` is unnecessary at this size — plain `CREATE INDEX` locks for milliseconds.

Building for 100k+ tasks now would add weeks of complexity to protect against a problem you are years away from. **Do not.**

### 0.2 The contribution cutover blast radius is currently 2 tasks

The spec calls step 6 (contributions read `work_value`) "highest risk — earnings change." That was correct in principle and is wrong today: **only 2 tasks carry a coverage stamp**, because retainers went live last week.

That number only grows. Every month you defer, the cutover gets more expensive and the reconciliation harder.

**This inverts the usual instinct.** The riskiest-sounding phase should be done *early*, while a full manual verification is 2 rows instead of 2,000.

### 0.3 A finding that needs a decision before 3.4

In a 1,000-row sample of `contribution_scores`, **970 rows have `is_manual_override = true`** and 654 have zero earnings.

Two implications:

1. **The new engine must honour `is_manual_override`.** The audit already found the current auto-recalc ignores it. If Phase 3.4 recomputes over overrides, you will destroy 97% of the human-curated earnings ledger. This is the single most dangerous thing in the whole plan.
2. **People override the engine almost always.** Phase 3.4 fixes *where the number comes from*. It does not fix *why nobody trusts the computed number*. Worth understanding before assuming 3.4 solves the contributions problem.

---

## 1. Existing code impact

Measured call sites, not estimates.

### Stays unchanged
`lib/finance/*` (journal, splits, pnl, tags — already pure and tested) · `lib/payroll/compute.ts` (already has finalized-month protection) · Cash Book · Requests · Approvals · Chat · Recruitment · Social Calendar · Catalog · Advertising (post-cleanup)

### Requires refactoring

| Module | Call sites | Why |
|---|---|---|
| `contributions-client.tsx` (3,020 lines) | 6 browser writes | Phase 3.0 — must move server-side |
| `contribution-entry-panel.tsx` | 4 browser writes | Phase 3.0 |
| `tasks-client.tsx` (5,227 lines) | 1 browser write + billing form | 3.0, 3.3, 3.6 |
| `tasks/actions.ts` | resolver lives here | 3.3, 3.6 |
| `lib/agreements/*` | 46 refs to `retainer_item_id` across 10 files | 3.5 |
| `lib/sync/integrity.ts` | recalc paths | 3.4 |
| `api/recalc-commissions` | recompute entrypoint | 3.4 — must become audited + override-aware |
| `invoices-client.tsx` (6,160 lines) | fee lines, `source_type` | 3.8 |

### Deleted
Quotations module + `quotations` / `quotation_items` tables (0 rows) — Phase 3.9.

### Deliberately not touched
`billing_amount_inr` — **224 references across 42 files**. The spec defers the rename to Phase 5 and that is confirmed correct: renaming it during Phase 3 would triple the diff of every phase for zero functional gain.

---

## 2. Migration order and rollback

### Rollback strategy by class

| Class | Rollback | Notes |
|---|---|---|
| New table | `DROP TABLE` | Free — nothing reads it until cutover |
| New nullable column | `DROP COLUMN` | Free |
| Backfill | Re-runnable | Every backfill must be idempotent |
| Read-path cutover | Feature flag | Flip the flag, no DB change |
| Column rename | Rename back | Only risky if code shipped in the same deploy — so never do that |
| Constraint tighten (`NOT NULL`, `CHECK`) | Drop constraint | Do these last, in their own migration |

**Rules that make rollback trivial:**

1. Never ship a schema change and its read-path change in the same deploy. Schema first, code next deploy.
2. Never combine two backfills in one migration.
3. Every backfill runs as `dry-run → report counts → apply`.
4. Constraints (`NOT NULL`, `CHECK`) always land one deploy after the backfill that satisfies them.

### Zero-downtime

Not required at this data size — but two ordering rules still apply because they protect *code*, not the database:

- **Expand → migrate → contract.** Add the new column; write both; read new; drop old. Applies to `retainer_item_id → agreement_line_id` and `billing_mode → amount_basis`.
- **Never rename in place.** Add the new column, dual-write, cut reads over, drop the old one a deploy later.

---

## 3. Data migration specifics

### 3.1 `agreement_line` migration — 2 rows

Trivially small. For each `client_agreement_items` row: insert one `agreement_lines` row, insert one `agreement_line_versions` row carrying its terms, map `tasks.retainer_item_id → tasks.agreement_line_id`.

Verify: every task that had a stamp has exactly one new stamp; `SELECT count(*) WHERE retainer_item_id IS NOT NULL AND agreement_line_id IS NULL` = 0.

### 3.2 `work_value` backfill — 1,876 tasks

```
for each task:
  version := rate card row for (entity, service_id) valid at task_date
  if version exists → work_unit_value, currency, base, fx_rate, fx_date, source='rate_card', version_id
  else             → source='none'
```

**Publish the `source='none'` count before proceeding to 3.4.** That number is the size of your catalog gap. Services with no rate-card entry produce unvalued work.

Seed the rate card from current service default prices so day-one behaviour is unchanged.

### 3.3 `billing_treatment` backfill

```
retainer_item_id IS NOT NULL AND bill_as_extra IS TRUE  → 'extra'
retainer_item_id IS NOT NULL                            → 'covered'
otherwise                                               → 'billable'
```

Deliberately does **not** infer `free` / `internal` / `write_off` — there is no reliable signal for them in the current data, and guessing would encode fiction. They become available going forward only.

### 3.4 Contributions cutover

Do **not** rewrite `contribution_scores`. Write into the new `contribution_entries` ledger from a cutover date forward, and leave 36 months of history untouched.

Migration is therefore: create the table, run both engines in parallel for one month, diff, then flip the read.

**Override rule (non-negotiable):** if a task's existing score has `is_manual_override = true`, the new engine records the computed value but does not supersede the override. 97% of rows are in this state.

---

## 4. Performance

At current volumes nothing is slow. These indexes exist to prevent the obvious future problem, not to fix a present one.

```sql
CREATE INDEX ON tasks (agreement_line_id) WHERE deleted_at IS NULL;   -- progress query
CREATE INDEX ON tasks (legal_entity_id, task_date) WHERE deleted_at IS NULL;
CREATE INDEX ON contribution_entries (employee_id, period);           -- payroll
CREATE INDEX ON contribution_entries (task_id);
CREATE INDEX ON agreement_line_versions (line_id, effective_from DESC);
CREATE INDEX ON client_service_pricing (client_id, service_id, valid_from DESC);
CREATE INDEX ON service_work_values (entity_id, service_id, valid_from DESC);
```

**The real performance problem is not in this spec.** It is that Tasks, Invoices, Cash Book and Contributions each load their entire table into the browser — Tasks serialises up to 50,000 rows into the page payload. That is a Phase 4 concern and it will bite long before any index does.

Agreement progress stays a derived query. At 1,876 tasks it is instantaneous. Materialise it only if a profile ever shows otherwise; the append-only design makes that a drop-in later.

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **3.4 overwrites 970 manual overrides** | Medium | **Severe** — destroys the curated ledger | Override guard + parallel run + row-level diff before flip |
| Browser writes bypass the model | High if 3.0 skipped | Severe | 3.0 is a hard gate |
| Parameter system has zero tests | Certain today | High | Test suite lands with 3.4 |
| Stamping misses → silent underdelivery | Medium | Medium | Reconciliation screen ships *with* 3.5 |
| `billing_mode` rename breaks sub-task billing | Low | Medium | Only ~4 real logic sites, all in `tasks-client.tsx`; separate deploy + regression test on parent/child tasks |
| Rate-card gaps block sealing | Medium | Medium | Publish the `none` count before 3.4; unvalued-work queue |
| Historical reporting shifts | Low | High | Cutover date; never rewrite `contribution_scores` |
| Invoice differences | Low | High | Invoices immutable after `issued_at`; corrections are credit notes |
| Data loss | Low | Severe | Every phase additive; no destructive migration until 3.9 (0-row tables) |

**Note on `tasks-client.tsx:123`:** the type allows `billing_mode: 'parameter_driven'`, but the database contains only `fixed` and `percent_of_parent`. That is a dead branch — verify and remove during the 3.6 rename rather than carrying it forward.

---

## 6. Testing strategy

### Unit
- Billing resolver: every precedence path, including "covered + override attempted" → refused
- Work-value resolver: rate card hit, override, gap → `none`
- Contribution split: weights sum to 1; version pinning; **override preservation**
- Proration: part months, mid-month start, mid-month end
- FX: rate selection by date; no re-conversion of sealed rows

### Integration (currently zero — this is the biggest coverage gap)
- Task create → seal → contribution entries written → payroll picks them up
- Covered task → invoice shows no line; extra task → invoice shows a line
- Agreement terms change → progress preserved (the lineage regression)
- Period close → sealed task edit refused
- Idempotency: same key twice → one write

### Migration validation
Each backfill ships with a paired assertion query that must return zero:
```sql
-- 3.5
SELECT count(*) FROM tasks WHERE retainer_item_id IS NOT NULL AND agreement_line_id IS NULL;
-- 3.6
SELECT count(*) FROM tasks WHERE billing_treatment IS NULL;
-- 3.3 (reported, not asserted zero)
SELECT count(*) FROM tasks WHERE work_value_source = 'none' AND status IN ('done','delivered','invoiced','paid');
```

### Production verification checklist (per phase)
1. `bash scripts/verify-remediation.sh` — no new failures
2. `node scripts/probe-rls.mjs` — exits 0
3. Full suite green
4. Build green in a clean worktree
5. Smoke: Tasks, Invoices, Cash Book, Agreements, one public intake link
6. Spot-check one covered task, one extra task, one normal task

---

## 7. Phased plan

| Phase | Goal | Effort | Depends on | Risk | Deployable alone | Rollback |
|---|---|---|---|---|---|---|
| **3.0** | Contribution writes → server actions | **3 d** | — | Med | Yes | Easy — revert commit |
| **3.1** | Entities, periods, FX dating | 1.5 d | — | Low | Yes | Easy — drop tables |
| **3.2** | Internal rate card + seed + admin UI | 2 d | 3.1 | Low | Yes | Easy — nothing reads it |
| **3.3** | Task `work_*` columns + backfill | 1.5 d | 3.2 | Low | Yes | Easy — drop columns |
| **3.4** | **Contributions read work value** | **4 d** | 3.0, 3.3 | **High** | Yes (flagged) | Flag flip |
| **3.5** | Agreement lineage + re-stamp + reconciliation screen | 3 d | 3.1 | Med | Yes | Medium — expand/contract |
| **3.6** | `billing_treatment` + `amount_basis` rename + resolver | 2.5 d | 3.5 | Med | Yes | Medium |
| **3.7** | Sealing + period locking | 2 d | 3.3, 3.6 | Med | Yes | Easy — drop constraint |
| **3.8** | Invoice `source_type`, fee lines, Delivery Report | 3 d | 3.5, 3.6 | Med | Yes | Medium |
| **3.9** | Agreements-as-proposal; delete Quotations | 1.5 d | 3.5 | Low | Yes | Easy — 0 rows |

**Total ≈ 24 engineer-days.** Every phase is independently deployable and independently revertible. No phase requires a maintenance window.

---

## 8. Rollout

Per phase: feature branch → clean-worktree build → verify script → merge to `main` → watch → smoke checklist.

Two phases get extra ceremony:

- **3.4** — parallel run for one full payroll cycle. Publish a per-employee diff. Announce before the flip. Flag stays in place for one cycle after.
- **3.6** — deploy the rename alone. Nothing else in that deploy.

Never deploy 3.5 and 3.6 together: both rewrite task rows at scale and a combined rollback would be ambiguous.

---

## 9. If I were the lead engineer, this is the order I'd choose

**3.0 → 3.4 → 3.1 → 3.2 → 3.3 → 3.5 → 3.6 → 3.7 → 3.8 → 3.9**

with 3.1–3.3 done as prerequisites *inside* the 3.4 workstream rather than as separate releases.

Three reasons, in order of weight:

**1. Do the contribution cutover while it costs 2 rows.** The blast radius is 2 covered tasks today. In six months it is every retainer task you have created since. This is the only phase whose difficulty grows with delay, and it is the phase the spec labels highest-risk. Verification right now is one person reading two rows; later it is a reconciliation project. Every other phase costs the same whenever you do it.

**2. 3.0 is not negotiable and must be absolutely first.** Eleven browser write sites still mutate the earnings ledger directly. Until they are server-side, every guarantee in the spec — sealing, period locking, override protection, idempotency — is advisory. Building the work-value model on top of a mutable substrate produces a system that looks correct and behaves wrong, which is worse than the current state because it is *trusted*.

**3. Everything else is genuinely order-independent, so sequence by risk-reduction per day.** Lineage (3.5) prevents a bug that only fires on renegotiation — real, but you control when that happens. Sealing (3.7) protects history that nothing is currently corrupting. The rename (3.6) is pure hygiene. None of them degrade with time.

**What I would not do:** follow the spec's numeric order. It reads as risk-ascending — foundation first, dangerous cutover late. That is the right instinct with a large dataset and exactly wrong here, because the dangerous phase is the one that is currently cheap and will not stay that way.

**One thing I would insist on before 3.4 starts:** an answer to why 97% of contribution scores are manual overrides. If the computed number is systematically wrong for a reason Phase 3.4 does not address, the cutover will move earnings from one distrusted number to another — and you will find out during a payroll run rather than during a design review.
