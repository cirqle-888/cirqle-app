# Cirqle — Employee Commission Agreements
### Architecture & Workflow Design Document (for approval)

**Status:** Proposal — **Revision 2** (owner sign-off folded in). No code, no migrations, no tables yet.
**Module:** Per-employee special commission agreements (Client + Service based).

**Owner-approved decisions (Rev 2):**
- **Percentage base:** support **both** `percentage_of_billing` **and**
  `percentage_of_pool`, selectable per agreement row.
- **Trigger:** applies **only when the employee has a contribution record** on the
  task. **Task assignment alone is NOT sufficient.**
- **Recalculation scope:** current month + **pending** payroll auto-recalculate;
  **paid payroll is never modified**; **historical months require a manual refresh**.
- **UI home:** a **dedicated "Commission Agreements" section/tab inside the
  Employee Profile** — **not** a small modal.
- **Isolation reaffirmed:** this changes nothing in the current setup; it affects
  **only** an employee who actually has a matching agreement.

---

## 0. Goal & Hard Guarantees

Let specific employees earn a **special, agreed commission** on tasks for a given
**Client + Service** (with optional "all clients" / "all services" wildcards),
**replacing** their normal contribution-based earning **for that employee on
that task only**.

**Iron guarantees (must hold):**
1. The **default earning system is unchanged**: contribution scores, ratings,
   `remainingPool × score% × rating%`, payroll, Contribution Analysis, Reports
   all keep working exactly as today.
2. **Employees with no agreement are completely unaffected** — the resolver is an
   *identity function* when no agreement matches (same number, same source).
3. **Only the agreement employee** is affected on a matching task. Everyone else
   on that task keeps their normal contribution earning.
4. **Nothing auto-assigns tasks.** Contribution scoring stays fully available.
5. The agreement applies **only when the employee has a contribution record on
   the task** (a `contributions` entry / the contribution score it produces).
   **Task assignment alone is NOT sufficient.** A matching Client+Service with no
   contribution never creates earnings.
6. **Strictly additive**: a new agreements table + nullable, default-valued
   columns. Zero behavioural change to existing tables.

---

## 1. Core Concept & Precedence

Today, each contributing employee's stored earning is:
```
earnings_inr = remainingPool × scorePercentage × performanceRating
```
We introduce a **final resolution step** applied to each employee's earning,
with this **precedence (highest wins):**

```
1. Manual Override   (is_manual_override = true)   → never touched, as today
2. Employee Agreement (active, matching, employee worked the task) → REPLACES earning
3. Contribution-Based (the normal formula)         → default, unchanged
```

The employee's **contribution score is still recorded** (they did the work); only
their **earnings_inr value is replaced** by the agreement, and the row is tagged
with its **source**. Their score still appears in the contribution graph; it just
doesn't drive *their* pay on that task.

---

## 2. Database Structure

### NEW table — `employee_commission_agreements`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| employee_id | uuid FK employees | the employee the agreement belongs to |
| client_id | uuid FK clients **null** | null = **all clients** (wildcard) |
| service_id | uuid FK services **null** | null = **all services** (wildcard) |
| agreement_type | text | `fixed_per_task` \| `percentage_of_billing` \| `percentage_of_pool` *(extensible)* |
| agreement_value | numeric | ₹ for fixed; % for either percentage type |
| currency | text | default `INR` (for fixed amounts) |
| effective_from | date | when it starts applying (by task_date) |
| effective_to | date **null** | optional end (null = open-ended) |
| is_active | bool | quick on/off without deleting |
| notes | text | free text (the agreement context) |
| created_by / created_at / updated_at | … | audit |

Unique-ish guard (soft): discourage exact duplicates of
`(employee_id, client_id, service_id, effective_from)` while active.

### Additive columns on existing `contribution_scores` (safe, default-valued)
| Column | Type | Notes |
|---|---|---|
| earning_source | text **default `'contribution'`** | `contribution` \| `agreement` \| `manual_override` |
| agreement_id | uuid **null** FK | which agreement produced it (traceability) |

> Existing rows default to `earning_source = 'contribution'` → **no change** to any
> current data or calculation. `is_manual_override` already exists and stays the
> top of the precedence chain.

**Why not a per-employee price matrix?** A full employee × client × service grid
is ~99% empty and unmaintainable. This **sparse rule table** stores only the
exceptions, supports wildcards, and is far easier to reason about.

---

## 3. Matching & Precedence Rules

An agreement **matches** for `(employee, task)` when **all** hold:
1. `agreement.employee_id = employee.id`
2. `agreement.client_id` is **null** OR equals `task.client_id`
3. `agreement.service_id` is **null** OR equals `task.service_id`
4. `agreement.is_active = true`
5. `task.task_date` within `[effective_from, effective_to]` (to null = open)
6. **The employee has a contribution record on the task** (see §0.5 — a `contributions` entry / its contribution score; **assignment alone is not enough**)

If several of *that employee's* agreements match, the **most specific** wins:

| Specificity | client_id | service_id | Rank |
|---|---|---|---|
| Exact | set | set | 1 (highest) |
| Client-wide | set | null | 2 |
| Service-wide | null | set | 3 |
| Global | null | null | 4 (lowest) |

Tie-breaker if still equal: most recent `effective_from`, then newest `created_at`.

---

## 4. Multiple Employees with Agreements on the Same Task

Each employee is resolved **independently**:

```
Task: Sea Star Catering · Social Media · billing ₹1,000 · pool ₹500
 ├─ Ajid   → agreement "₹300 per task"      → earnings ₹300   [agreement]
 ├─ Sara   → agreement "20% of billing"     → earnings ₹200   [agreement]
 └─ Faisal → no agreement, score 60%        → ₹500×60%×100%   [contribution]
```

- Ajid and Sara are each replaced by their own agreement.
- Faisal is untouched — normal contribution earning.
- **No redistribution** between them (each row is independent in the stored
  model, exactly as today). The pool is *not* re-balanced; agreements are
  per-employee guarantees by your direction.

**Consequence (by design):** the task's total payout can be **more or less** than
the commission pool. That's intentional — an agreement is a guarantee, not a
pool share. The validation layer (§6) surfaces when this happens.

---

## 5. Engine Integration — where the override is applied  *(critical)*

Earnings are produced in **two** places that must stay in agreement:

**A. Stored earnings** (`contribution_scores.earnings_inr`) — written by:
- `recalcTaskCommissions` / `refreshStoredEarningsFromBilling` (`src/lib/sync/integrity.ts`)
- the bulk recalc route (`src/app/api/recalc-commissions/route.ts`)
- the contributions save path

**B. Live recompute** in **Contribution Analysis** (`buildAnalysisRows`,
`src/lib/reports/contribution-analysis.ts`) — recomputes on every page load.

**Design:** introduce one shared, pure resolver:
```
resolveEarning(employee, task, normalEarning, agreements, isManualOverride)
   → { earnings, source: 'contribution'|'agreement'|'manual_override', agreementId }
```
Rules inside it: manual override → return as-is; else best-matching active
agreement → compute:
- `fixed_per_task` → `value` (₹, FX-converted to INR)
- `percentage_of_billing` → `task.billing_amount_inr × value%`
- `percentage_of_pool` → `remainingPool × value%` *(pool = billing × service commission%, after tool deductions — the same `remainingPool` the engine already computes)*

else → return `normalEarning`. The resolver receives both `billing` and
`remainingPool` from the engine so both percentage bases are available.

**This resolver is called in BOTH path A and path B**, with the agreements list
loaded alongside the other reference data. That keeps **report == stored ==
payroll** by construction (the same lesson from the earnings-sync work).

> No change to `calculateCommission` itself (it stays pure). The override is a
> thin post-step layered on its output, so the core formula is untouched for
> everyone without an agreement.

**Recalc triggers & scope (Rev 2 — owner-approved):** editing/adding/
deactivating an agreement, or editing a task's billing/client/service,
recomputes affected tasks' earnings via the existing sync path, **scoped as:**
- **Current month + pending payroll → auto-recalculate** (as billing edits do today).
- **Paid payroll → never modified** (immutable, enforced by the existing
  pending-only payroll recompute).
- **Historical months → manual refresh only** (a "Recalculate affected tasks"
  action on the agreement / month), so old/closed periods never move on their own.

---

## 6. Validation Logic

Surfaced as **warnings (never hard blocks)** — agreements are deliberate:

**At agreement-editing time (Employee → Commission Agreements):**
- ⚠️ Fixed amount looks high: if `agreement_value` (fixed) exceeds the typical
  billing for that client+service (from the Pricing Matrix), warn
  "₹300 exceeds the usual ₹250 billing for this service."
- ⚠️ Overlapping agreement: another active agreement already matches the same
  scope.
- ⚠️ Percentage > 100%.
- ⚠️ effective_to before effective_from.

**At calculation/display time (task & Contribution Analysis):**
- ⚠️ Agreement earning exceeds the task billing (`earnings > billing`).
- ⚠️ Task total payout (all sources) exceeds the commission pool — flags that the
  company pays more than the pool on this task.
- Clear labelling so agreement-based earnings are never mistaken for
  contribution-based ones.

---

## 7. UI Design

**A. Employee Profile → dedicated "Commission Agreements" tab/section (Rev 2).**
A **full-width dedicated area** (not the small Edit Employee modal — that modal
stays exactly as it is today). Agreements can grow, so they get their own room.
List + add/edit:

```
Commission Agreements                                   [+ Add agreement]
┌──────────────────────────────────────────────────────────────────────┐
│ Client            Service            Type        Value   From     ● ON │
│ Sea Star Cater.   Social Media       Fixed/task  ₹300    01 Jun   ●    │
│ Sea Star Super.   (All services)     % billing   15%     01 Jun   ●    │
│ (All clients)     Offer Flyer        Fixed/task  ₹50     —        ○ off│
└──────────────────────────────────────────────────────────────────────┘
```
Add/edit fields: Client (Combobox + "All clients"), Service (Combobox + "All
services"), Agreement Type (Fixed per task / Percentage), Value, Effective From,
Effective To (optional), Active toggle, Notes. Inline validation warnings (§6).

**B. Task / Contribution view.** Next to an agreement-based earning, a small
chip: **`Agreement`** (vs normal). Hover shows "₹300 fixed — Ajid · Sea Star ·
Social Media".

**C. Permissions.** A new `employees.manage_agreements` permission (admins/HR);
gated like the rest of the catalog. Viewing agreement *earnings* follows the
existing financial-visibility rules.

---

## 8. Impact on Contribution Analysis

- The same `resolveEarning` runs inside `buildAnalysisRows`, so the report shows
  **agreement earnings live** and they match payroll.
- New **"Source"** indicator per employee earning: `Contribution` / `Agreement` /
  `Manual Override` (driven by `earning_source`). Can be a column or a chip.
- Totals (the row you added earlier) include agreement earnings naturally.
- Score% still displays (the employee's contribution is real); only the ₹ comes
  from the agreement, clearly labelled.

## 9. Impact on Payroll

- **None structurally.** Payroll keeps summing `contribution_scores.earnings_inr`
  exactly as today; that value now already reflects agreements (resolved during
  recompute). `earning_source` is informational only.
- Pending-payroll auto-sync already recomputes on earnings changes → agreement
  edits flow through with no payroll code change.
- Paid payroll stays immutable, as always.

---

## 10. Edge Cases

| Case | Behaviour |
|---|---|
| Employee has agreement but **didn't work** the task | No earning (trigger rule §0.5). |
| **Percentage** agreement on a **₹0** billing task | ₹0 (warn). |
| **Fixed** agreement > billing | Applies, but warned at edit + on task. |
| Manual override + agreement both present | **Manual override wins** (§1). |
| Multiple matching agreements (same employee) | Most specific wins (§3). |
| Historical earnings-only imports (`score% = 0`) | Untouched — agreements only resolve for tasks the employee actually worked; the score%=0 protection from the earnings-sync model still holds. |
| Agreement **deactivated/edited** | Future calc uses new state; past **stored** earnings change only when those tasks are recomputed (a "recalculate affected tasks" action / next task save). Effective dates make this predictable. |
| Agreement spans a **rate change** | Use two rows with `effective_from`/`effective_to`; the resolver picks the one valid on `task_date`. |
| Two employees, one agreement each | Each resolved independently (§4). |
| Currency mismatch (fixed in non-INR) | Convert to INR via existing FX, like billing. |

---

## 11. Future Scalability (no redesign)

- **New agreement types** slot into `agreement_type` + the resolver: e.g.
  `percentage_of_pool`, `tiered`, `min/max cap per task`, `monthly cap`,
  `per-quantity`.
- **Scope by tag/group** (e.g. "all premium clients") via an optional
  `client_group_id` later.
- **Approval/audit** of agreement changes via the existing activity log.
- Because earnings still land in `earnings_inr` with a `earning_source` tag, every
  downstream consumer (payroll, analysis, payslips) already supports it.

---

## 12. Implementation Roadmap (when approved)

1. **Phase 1 — Data + resolver (inert):** `employee_commission_agreements` table,
   `contribution_scores.earning_source` + `agreement_id` columns, the pure
   `resolveEarning` helper. *No agreements exist yet → zero behavioural change.*
2. **Phase 2 — Apply in recompute (path A):** wire `resolveEarning` into
   `recalcTaskCommissions` / refresh / recalc route so stored earnings honour
   agreements; recompute triggers on agreement + task edits.
3. **Phase 3 — Apply in live report (path B):** wire into `buildAnalysisRows`;
   add the **Source** indicator + totals; keep report == payroll.
4. **Phase 4 — UI:** Employee → Commission Agreements section (CRUD + validation
   warnings); agreement chip on task/contribution views; `employees.manage_agreements`
   permission.
5. **Phase 5 — Polish:** edit-time warnings vs Pricing Matrix, "recalculate
   affected tasks" action, payslip labelling.

---

## 13. Approved Decisions (Rev 2 — signed off)

1. **Percentage base:** **both** `percentage_of_billing` **and**
   `percentage_of_pool` are supported, **selectable per agreement row.** ✅
2. **Trigger:** applies **only when the employee has a contribution record** on the
   task. **Task assignment alone is NOT sufficient.** ✅
3. **Recalculation scope:** current month + **pending** payroll auto-recalculate;
   **paid payroll never modified**; **historical months via manual refresh** only. ✅
4. **UI home:** a **dedicated Commission Agreements tab/section in the Employee
   Profile** — never the small modal. ✅

**Isolation (reaffirmed):** strictly additive — one new table + two nullable,
default-valued columns. The resolver is an identity function with no agreements,
so the current setup and every employee **without** an agreement are byte-for-byte
unchanged. Only an employee **with** a matching, active agreement is ever affected.

---

## 14. Status

Design **approved** pending your "build it" green light. Implementation will
follow the §12 roadmap (data + inert resolver first, so nothing changes until an
agreement is actually created).
