# Cirqle — Financial Core Architecture

**Status:** Proposed · **Date:** 1 August 2026
**Scope:** Tasks, Agreements, Contributions, Invoicing, Revenue, Profitability
**Audience:** engineering + owner. Written as a target design, not a description of what exists.

---

## 0. The governing principle

Three financial planes exist in this business. Every serious bug in the current system comes from letting one derive from another.

| Plane | Question it answers | Owns |
|---|---|---|
| **Revenue** | What does the client owe us, and when do we recognise it? | agreements, invoices, revenue events |
| **Cost** | What did producing this work cost us? | work values, compensation plans, payroll |
| **Fulfilment** | What did we promise, and what have we delivered? | agreement entitlements, consumption ledger |

**Rule: the three planes join by reference, never by derivation.** Cost must never be computed from revenue. Fulfilment must never be inferred from a zero amount. Revenue must never be summed from tasks.

Everything below follows from that.

---

## 1. Tasks

### 1.1 A task is two things at once

A task is an *operational* object (mutable: status, assignee, title, dates) and a *financial event* (must become immutable). Conflating these is why editing task #1883 silently created a double-bill.

Separate them by lifecycle, not by table: keep one `tasks` row, but give its financial fields a **seal**.

### 1.2 Challenge: "frozen at creation" is wrong

You have repeatedly said values should freeze at creation. They should not.

At creation you frequently do not yet know the final quantity, and the service or client may still change. Freezing at creation means the frozen value is wrong the moment someone corrects a typo. Never freezing means history drifts under you.

**The correct freeze point is a `seal` event**, triggered by whichever comes first:

- the task is invoiced, or
- the period containing it is closed for payroll, or
- an explicit manual seal

Before the seal, financial fields are **provisional** and re-derive on every edit. After the seal they are immutable, and changes require an adjusting entry — never an in-place update.

```
created ──► provisional (re-derives on edit) ──► SEALED (immutable) ──► adjustments only
```

This single mechanism prevents both failure modes and gives you an audit story: every sealed value has a timestamp, an actor and a reason.

### 1.3 Challenge: `amount = 0` must stop being a signal

Today, `billing_amount = 0` is overloaded. It can mean covered by retainer, deliberately free, internal work, or nobody set a price. Those need different downstream behaviour, and the ambiguity is precisely what produced the current bug.

Replace the implicit signal with an explicit one:

```
billing_mode ENUM: 'billable' | 'covered' | 'extra' | 'internal' | 'free' | 'write_off'
```

`billing_mode` is authoritative. The amount is a consequence, never the signal.

### 1.4 Challenge: never hardcode a currency into a column name

`billing_amount_inr` bakes today's reporting currency into the schema. The moment a second legal entity reports in AED, every column name is a lie.

Use `*_native` (transaction currency) + `*_base` (the entity's base currency) + the rate that connected them.

### 1.5 Task financial fields

Store **unit values plus quantity**, not just totals. Totals are derivable; units are not, and allowance consumption, partial delivery and quantity edits all need the unit.

```sql
-- operational (mutable)
id, task_number, client_id, service_id, task_date, quantity, status, ...

-- work value: what this work is worth to us. ALWAYS populated. Drives cost/commission.
work_unit_value_native    numeric
work_value_currency       text
work_unit_value_base      numeric
work_value_fx_rate        numeric
work_value_fx_date        date
work_value_source         text     -- 'override' | 'client_rate_card' | 'service_standard' | 'none'
work_value_version_id     uuid     -- FK to the rate-card version actually used

-- billing: what the client owes for THIS task. Drives invoicing/revenue.
billing_mode              text     -- enum above; authoritative
billable_unit_amount_native numeric
billable_currency         text
billable_unit_amount_base numeric
billable_fx_rate          numeric
billable_source           text     -- 'client_pricing' | 'service_default' | 'agreement_extra' | 'manual'

-- fulfilment linkage
coverage_line_id          uuid     -- which agreement line absorbed it (null = none)

-- seal
sealed_at                 timestamptz
sealed_by                 uuid
seal_reason               text     -- 'invoiced' | 'period_closed' | 'manual'
```

**Calculated later, never stored on the task:** revenue totals, agreement progress, client profitability, employee earnings. All derive from immutable rows.

**Why store both `_native` and `_base` plus the rate:** so a historical report never re-converts. Re-conversion is how FX drift silently rewrites last year's margins.

---

## 2. Agreements

### 2.1 Agreements are commercial contracts. Nothing else.

An agreement owns: who, what scope, what period, what price, what entitlement. It does **not** own cost allocation, and it does **not** own counters.

```
agreements
  id, client_id, legal_entity_id, status, currency,
  start_date, end_date, billing_cycle, renewal_policy,
  revenue_recognition_policy   -- 'ratable' | 'on_delivery' | 'milestone'

agreement_lines
  id, agreement_id, service_scope, period_basis, price_native, ...

agreement_line_versions
  id, line_id, valid_from, valid_to,
  included_quantity, price_native, ...
```

Every commercial term lives on a **version** with an effective window. "Change terms" closes the current version and opens a new one — which the current system already does correctly. Nothing is ever updated in place.

### 2.2 Revised recommendation: `allocated_unit_value` should not exist

Last turn I suggested keeping it for margin reporting. Designing from scratch, **I no longer think it should exist**, and I want to be explicit that this reverses my earlier advice.

Its only real job was to give contributions a number to work from. Once `work_value` exists on the task, that job is gone. Keeping it creates a second, hand-maintained source of truth for "what a unit of this service is worth," which will drift from the rate card and produce two defensible-but-different margin numbers.

Agreement profitability does not need it:

```
agreement margin = Σ revenue_events(agreement, period)
                 − Σ work_value(tasks consumed by that agreement in period)
                 − direct costs
```

You get per-agreement margin from two independent ledgers with no allocation table at all.

**The one case that would bring it back:** if accounting ever requires delivery-based recognition on a retainer (IFRS 15 / ASC 606 performance obligations), you need a per-unit standalone selling price. Handle it then, via `revenue_recognition_policy = 'on_delivery'` and a recognition rule — not by storing an allocation on every line forever.

### 2.3 Entitlement is a ledger, never a counter

Do not store `delivered` / `remaining`. Denormalised counters drift on: task deletion, date changes moving a task between periods, client reassignment, status reverting, agreement date edits, terms changes. You will miss one of those paths.

```sql
agreement_consumption          -- append-only
  id, agreement_line_version_id, task_id,
  period,                      -- the entitlement period consumed
  units numeric,               -- NEGATIVE rows reverse; never UPDATE, never DELETE
  created_at, created_by
```

Remaining allowance is a query. If it ever gets slow, materialise it — but the ledger stays the source of truth for rebuilds. This is the same pattern already used for cashbook allocations, so it is not a new idea in this codebase.

**Consumption must count `quantity`, not tasks.** A task with quantity 4 consumes 4 units. Counting tasks makes a 15-post entitlement meaningless the first time someone logs a multi-quantity task.

### 2.4 Rules that must be explicit

| Question | Decision |
|---|---|
| Which period does a task consume? | The period containing `task_date` — never `created_at` |
| What happens on over-delivery? | Consume to the limit; the surplus becomes `billing_mode='extra'` and requires approval |
| Can a closed period be consumed? | No. Seal blocks it; the task goes to the current open period flagged for review |
| Task deleted after invoicing? | Reversal row in the ledger; the original consumption stays visible |
| Retainer with zero delivery? | Revenue still accrues (see §5). Entitlement simply expires unless `carry_forward` is set |

---

## 3. Employee contributions

### 3.1 Source of truth: `work_value`. Nothing else.

Employees are a cost of production. Cost of production does not depend on the customer's payment plan. This is ordinary standard-cost accounting: value the work at standard, and let discounts, retainer under-delivery and write-offs land as variances on the commercial side, where the decisions were actually made.

Contributions therefore read `tasks.work_value` and **never** read invoices, agreements or client pricing.

### 3.2 Challenge: work value must not come from client pricing

This is the most important disagreement in your proposal.

You specify the ladder as *client pricing → service default*. But client pricing is a **revenue** concept — it is what *this particular client* negotiated. If Client A pays AED 20 for a poster and Client B pays AED 30 for the identical poster, your stated business rule ("employees are rewarded for the work, not how the client was billed") says the employee must earn the same for both.

Sourcing work value from client pricing silently reintroduces exactly the coupling you are trying to remove. It will look correct for months, until a discounted client makes a designer's earnings drop for identical work — and nobody will be able to explain why.

**Introduce an internal rate card, independent of client pricing:**

```sql
service_work_values            -- effective-dated internal standard values
  id, service_id, legal_entity_id,
  unit_value_native, currency,
  valid_from, valid_to,
  created_by, note
```

Derivation ladder at seal time:

1. explicit per-task override (requires reason + actor)
2. `service_work_values` version valid at `task_date`
3. → `source = 'none'` — **block the seal and alert**

Never fall through to zero silently. A task that cannot be valued is a data problem to fix before payday, not a zero to pay.

**Migration is painless:** seed `service_work_values` from today's service default prices. Day-one behaviour is identical; the concepts are now separate and free to diverge when the business needs them to.

### 3.3 Work value is not employee cost

Keep these distinct, because profitability needs both:

- **`work_value`** — notional standard value of the work. Allocates credit; drives commission.
- **Actual employee cost** — salary, benefits, employer taxes, from payroll.

Utilisation and true margin need actual cost. Commission needs standard value. Conflating them makes it impossible to answer "did this client earn us money?" honestly.

### 3.4 Compensation plans are versioned too

```sql
compensation_plans
  id, employee_id, plan_type,     -- 'commission_pct' | 'fixed' | 'per_unit' | 'hybrid'
  params jsonb,
  valid_from, valid_to
```

Commission for a task reads the plan version valid at the task's **seal date**, and stores the resulting `commission_amount` plus `plan_version_id` on the contribution row. A later plan change never rewrites past earnings.

---

## 4. Invoicing

Invoices care about billable amounts only. **An invoice must never read `work_value`.** If it ever needs to, the model is wrong.

Line sources:
- task lines — tasks where `billing_mode IN ('billable','extra')`
- agreement lines — the periodic retainer fee
- manual lines — ad-hoc

An issued invoice is immutable. Corrections are **credit notes**, never edits and never deletions. The current ability to hard-delete a paid invoice along with its payment rows is the single most dangerous behaviour in the existing system; it must not survive into this design.

Each invoice line snapshots its own amounts, tax code, FX rate and the task/agreement version it came from.

---

## 5. Revenue

### 5.1 Challenge: revenue cannot be derived from tasks

If revenue is summed from tasks, a retainer month with no delivery reports **zero revenue** — while the client has paid AED 400 and the contract has been honoured. That is simply wrong, and no amount of task-level cleverness fixes it.

Revenue is **event-driven** and gets its own append-only ledger:

```sql
revenue_events
  id, legal_entity_id, client_id,
  source_type,        -- 'agreement_period' | 'task' | 'invoice_line' | 'adjustment'
  source_id,
  period,
  amount_native, currency, amount_base, fx_rate, fx_date,
  recognised_at, reversal_of_id
```

### 5.2 Recognition by contract type

| Type | Basis | Note |
|---|---|---|
| **Retainer** | Ratable — fee ÷ period, accrued per period | Independent of delivery. This is correct for fixed-fee service contracts |
| **One-time / T&M** | On delivery (task sealed) or on invoice | Pick one policy per entity and hold it |
| **Fixed-price project** | Milestone, or percentage-of-completion | Needs a project entity with milestones; POC uses cost-to-cost against `work_value` |

Deferred revenue and accrued revenue both fall out of this naturally: invoiced-not-yet-recognised and recognised-not-yet-invoiced are two queries over the same ledger.

---

## 6. Profitability

All three questions resolve without duplication, because revenue and cost come from two ledgers that never read each other.

```
Client profitability (period)
  = Σ revenue_events(client, period)
  − Σ actual employee cost attributed to that client's tasks
  − Σ direct costs (ad spend, subcontract, licences)
  − allocated overhead

Agreement profitability (period)
  = Σ revenue_events(source_type='agreement_period', agreement, period)
  − Σ actual cost of tasks whose coverage_line_id belongs to that agreement
  − direct costs

Employee contribution vs cost (period)
  = Σ work_value of tasks they delivered      -- output at standard
  − their actual payroll cost                  -- input
  → the ratio is utilisation/efficiency, not profit
```

Report **both** standard (`work_value`) and actual (payroll) cost. The gap between them is the production variance, and it is a genuinely useful management number: it tells you whether your standard values reflect reality.

**Overhead allocation** is a policy, so make it explicit and versioned (`overhead_allocation_rules`) rather than hardcoded in a report. Two reports using different allocation bases is how you end up with four disagreeing margin numbers — which is the current state.

---

## 7. Historical integrity

Six mechanisms, all mandatory:

1. **Effective-dated reference data.** Rate cards, client pricing, agreement terms, FX, tax rates, compensation plans — all `valid_from` / `valid_to`. Reference data is never updated in place.

2. **Snapshot *and* reference.** Transactional rows copy the value they used **and** store the version id it came from. The copy makes reads fast and stable; the reference makes it auditable. Copy alone loses provenance; reference alone re-derives history.

3. **Period locking.** A `financial_periods (entity, period, status)` table. `closed` means no writes to sealed rows. Corrections become adjusting entries in an open period.

4. **Append-only ledgers.** Consumption, revenue, commission, allocation — never UPDATE, never DELETE. Reversals are negative rows carrying `reversal_of_id`.

5. **FX discipline.** Every converted amount stores its rate, rate date and source. Historical rows are never re-converted. One `fx_rates` table, effective-dated, one lookup function.

6. **Recalculation is an explicit, audited operation.** Never a side effect of page load. A recalc names its scope, refuses closed periods, records who ran it and what changed, and is reversible. (The current auto-recalc on mount, which rewrites the earnings ledger as a side effect of navigation, is the exact anti-pattern this rule exists to prevent.)

---

## 8. Scale

**100k tasks is not a database problem.** Postgres handles that on a laptop. The current pain comes from loading whole tables into the browser — up to 50,000 rows serialised into a page payload. Fix the access pattern, not the storage engine: server-side pagination, aggregate queries, and summary tables for dashboards.

What genuinely needs designing now, because retrofitting is brutal:

**Legal entity from day one.** Put `legal_entity_id` on every transactional table *now*, even with one entity. Each entity carries its own base currency, tax regime, numbering sequences and period calendar. Adding this later means rewriting every query and backfilling every row.

**Tax as first-class.** `tax_codes` + effective-dated `tax_rates`, applied at invoice-line level and **stored on the line**. Never compute tax at read time — rates change and historical invoices must not move. Design for line-level tax now even if today everything is one rate.

**Numbering.** Per-entity, per-year sequences, allocated by a database sequence or advisory lock. The current four competing invoice-numbering implementations are a symptom of not owning this centrally.

**Partitioning.** Not needed at 100k. At ~10M rows, partition `tasks`, `revenue_events` and `agreement_consumption` by period. The append-only design makes this trivial later; a mutable design makes it painful.

**Multi-payroll.** Already handled by versioned `compensation_plans` (§3.4).

**Read models.** As reporting grows, add materialised summaries (`mv_client_period_margin`) rebuilt by job. The ledgers stay authoritative; the views are disposable and always rebuildable from them.

---

## 9. Answers to the eight questions, condensed

1. **Task fields** — work value and billable amount as *separate* unit-level snapshots, each with native + base + FX rate + source + version reference; `billing_mode` enum as the authoritative signal; `coverage_line_id`; seal metadata. Aggregates never stored.
2. **Agreements** — commercial commitment only. Versioned terms, entitlement as an append-only ledger, no counters, no cost allocation.
3. **Contributions** — `tasks.work_value`, sourced from an **internal rate card**, not client pricing. Never reads invoices or agreements.
4. **Invoicing** — billable amounts only; never sees work value; immutable once issued; corrections via credit note.
5. **Revenue** — its own event ledger. Retainers recognised ratably, independent of delivery. `allocated_unit_value` should not exist.
6. **Profitability** — revenue ledger minus cost ledger, joined by reference. Report standard and actual cost side by side; make overhead allocation an explicit versioned policy.
7. **Historical integrity** — effective-dated reference data, snapshot + reference, period locking, append-only ledgers, FX discipline, explicit audited recalculation.
8. **Scale** — fix access patterns, not storage. Add `legal_entity_id` and line-level tax now. Partition later; the append-only design makes that easy.

---

## 10. Migration path

Additive and reversible for as long as possible. Nothing existing changes meaning until step 6.

| # | Step | Risk |
|---|---|---|
| 1 | Create `service_work_values`, seed from service defaults | none — nothing reads it |
| 2 | Add `work_value_*` columns to `tasks`; backfill; verify zero rows land on `source='none'` | none |
| 3 | Point contributions at `work_value`; keep the old path behind a flag for one cycle and diff the outputs | low |
| 4 | Add `billing_mode`; backfill from current state (`retainer_item_id` present + amount 0 → `covered`) | low |
| 5 | Introduce `agreement_consumption`; backfill from covered tasks; derive progress; delete counters | medium |
| 6 | Introduce `revenue_events`; recognise retainers ratably; repoint revenue reports | **highest — do alone, reconcile against current numbers before switching** |
| 7 | Seal mechanism + `financial_periods` locking | medium |
| 8 | Retire `allocated_unit_value` once agreement margin is proven from the two ledgers | low |

Step 6 is where numbers legitimately change: retainer revenue starts accruing on contract rather than on delivery. Expect the totals to move, reconcile deliberately, and communicate it — do not let it surprise anyone reading a report.

---

## 11. What I would refuse to build

- Any field whose meaning depends on another field being zero
- Mutable counters on parent records
- Revenue derived by summing tasks
- Employee earnings derived from client billing
- Hard deletion of any financial record
- Recalculation as a side effect of rendering
- A currency baked into a column name
