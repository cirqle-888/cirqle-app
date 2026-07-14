# Finance Foundation

The core financial architecture of Cirqle: one explicit **scope** dimension
(`client` / `company`) plus **statement sections** on cashbook categories,
consumed by a single reusable **Finance Engine** (`src/lib/finance/`) that is
the only place financial aggregation logic lives.

Design goal: client work and company operations share the same modules
(Tasks, Advertising, Cashbook, Payroll, Reporting) — they differ only by a
tag, never by code path. "Internal = `client_id IS NULL`" is dead; scope is
first-class.

---

## The two dimensions

| Dimension | Where | Values | Meaning |
|---|---|---|---|
| `scope` | `tasks`, `ad_projects`, `cashbook_entries` | `client`, `company` (cashbook also `NULL` = untriaged) | Whose economy a record belongs to |
| `statement_section` | `cashbook_categories` | `revenue`, `cogs`, `opex`, `financial`, `excluded` | Which P&L section a movement lands in |
| `account_code` | `cashbook_categories` | dot-hierarchy string, e.g. `opex.salaries` | The P&L report line |
| `default_scope` | `cashbook_categories` | `client`, `company`, `NULL` | Pre-fill + backfill hint for new entries |

Invariants (DB CHECK constraints):
- `scope = 'client'` ⇒ `client_id IS NOT NULL` (all three tables)
- `tasks.scope` and `ad_projects.scope` are `NOT NULL`; `cashbook_entries.scope`
  may be `NULL` only as the explicit "needs triage" state.
- A `company`-scoped record MAY reference a client (e.g. non-billable internal
  work related to a client); it just never flows to invoices.

Compatibility shim: `BEFORE INSERT OR UPDATE` triggers
(`trg_derive_task_scope`, `trg_derive_ad_project_scope`,
`trg_derive_cashbook_scope`) derive scope whenever a write doesn't provide
one, so pre-Phase-2 code paths remain correct forever. App code should still
always set scope explicitly — the trigger is a safety net, not an API.

## Accounting flow (the money map)

- **Company P&L (ledger truth, cash basis).** `company`-scoped cashbook rows
  grouped by section/account. Salaries appear once — as the payroll outflow
  actually paid (`opex.salaries`), which already includes commission earned on
  internal work. Internal ad spend posts gross (GST-inclusive) under
  `opex.marketing`. `excluded` (owner drawings) and `financial`
  (credit given/returned, transfers) never hit the P&L.
- **Client profitability (management view, not a second ledger).** Per client:
  invoiced revenue (INR snapshots) − direct costs (`invoice_expense_items.
  original_amount_inr` + ad-wallet campaign debits) − attributed labor
  (Σ `contribution_scores.earnings_inr` on that client's tasks). The same
  salary rupee appears in Company P&L as *what was paid* and here as *who
  earned it* — the two views are labeled and never summed together.
- **Internal advertising.** A company campaign is funded from the **company
  wallet** (`ad_wallet_ledger` rows with `client_id NULL`): cashbook outflow
  (`scope='company'`, `opex.marketing`) → wallet credit → campaign debit.
  Full budget/metrics/daily-report pipeline works; invoicing and service
  charge are structurally skipped.
- **Contribution → Payroll is unchanged.** It was already architecturally
  correct: per-task-per-client commission attribution for free.

## The Finance Engine (`src/lib/finance/`)

Single source of truth for every financial number. Pure functions over
normalized `JournalLine`s; Supabase is touched only in `journal.ts`.

```
types.ts                  JournalLine, Scope, StatementSection, PnlRow, …
journal.ts                the ONLY query surface (base tables + category join;
                          no view dependency, so it works pre/post migration)
classify.ts               scope derivation helpers shared by forms/importer
pnl.ts                    monthly company P&L, burn rate, runway   (pure)
client-profitability.ts   per-client contribution margin           (pure)
kpis.ts                   dashboard KPI computations                (pure)
```

Rules:
1. **No page or report may hand-roll financial aggregation.** Dashboards,
   P&L, profitability, KPI strips — all consume this engine.
2. Engines are pure and unit-tested (vitest, colocated `.test.ts`).
3. `v_finance_journal` / `v_company_pnl_monthly` SQL views mirror `journal.ts`
   for SQL-level consumers (integrity checks, BI, future GL feed). The app
   deliberately queries base tables instead so it never breaks when a
   migration hasn't been applied yet.

## Future-proofing map (no rewrites required)

| Future feature | How it lands on this foundation |
|---|---|
| General Ledger / Balance Sheet | `v_finance_journal` is already journal-shaped; promote `account_code` strings into a `finance_accounts` table with types (asset/liability/equity/income/expense) and post cashbook + allocations into it. |
| Tax reports | GST already isolated (`AD_SPEND_GST_RATE`, invoice `tax_amount`); add `tax_code` to categories, report from the journal. |
| Multi-company / branches | Add `company_id`/`branch_id` columns to the three spine tables + categories; the engine takes them as one more filter dimension. |
| Cost centers / departments / project accounting | Extend `account_code` hierarchy or add a `dimensions JSONB`/link table on `cashbook_entries`; `JournalLine` already carries pass-through metadata. |
| Budgeting | New `budgets` table keyed by `account_code` + month; compare in `pnl.ts` (budget vs actual is a pure-function change). |
| Procurement / assets / inventory | Post their cash effects as categorized cashbook entries (`scope='company'`, dedicated accounts); modules own workflow, engine owns money. |
| Approval workflows | The existing `approvals` module gates writes; finance reads are unaffected. |

---

## Phases

### Phase 1 — Schema foundation ✅ (this repo state)
- `supabase/migrations/20260714090000_finance_scope_foundation.sql`
- Rollback: `supabase/rollbacks/20260714090000_finance_scope_foundation_down.sql`
- Verify after applying: `scripts/verify-finance-phase1.sql`

**Impact:** zero behavior change (no code reads the columns yet).
**Risks:** prod category renames → unmapped rows (verify script §6 lists them);
prod schema drift (migration references only long-applied columns).
**Migration strategy:** apply any time, before or after deploying Phase 2 code —
order-independent thanks to the trigger shim.
**Rollback:** run the down script; pure-additive, no data loss either way.

### Phase 2 — Write paths set scope explicitly
Forms and server actions stamp `scope` on every insert/update (tasks modal,
cashbook entry form + importer, `markPayrollPaid`, campaign creation). All
writes tolerate the migration not being applied (retry-without-column
fallback, matching the repo's `safeQuery` philosophy).

**Impact:** new rows are always explicitly scoped; UI gains a scope choice
where ambiguity exists (cashbook).
**Risks:** the tasks UI is a 5k-line client component — edits are minimal and
localized (save payload + label).
**Rollback:** revert the code deploy; trigger shim keeps deriving scope.

### Phase 3 — Finance Engine, Company Ops report, company wallet ✅
- `src/lib/finance/` + unit tests
- Migration `20260714093000_finance_views_company_wallet.sql`:
  `v_finance_journal`, `v_company_pnl_monthly` (security_invoker),
  `ad_wallet_ledger.client_id` nullable + shape check update,
  `ad_reports.client_id` nullable.
- Company Operations report (`dashboard/reports/company-ops/`): monthly P&L
  by account with drill-down, burn rate, runway, triage queue.
- `ScopeFilter` shared UI component (mirrors `date-filter.tsx`).
- Company wallet + first-class internal campaigns (fund/allocate/report,
  never invoice).
- Dashboard "Company Ops" strip.

**Risks:** wallet shape-check relaxation — mitigated by keeping the CHECK
strict for client rows and adding dedicated company-row shapes; billing engine
gains an explicit `scope === 'company'` early return so no invoice write can
occur.
**Rollback:** code revert + down-script restores `NOT NULL` and the original
CHECK (only safe when no company-wallet rows exist yet; the down script
guards on that).

### Phase 4 — Consolidation + hardening ✅
- **Client Profitability report** (`/dashboard/reports/client-profitability`):
  per-client contribution margin from the engine (invoiced − direct costs −
  attributed labor + markup), plus the internal-initiatives labor card.
- **Wallet credit RPC** (`20260714095000_wallet_credit_rpc.sql` + rollback):
  `credit_ad_wallet()` row-locks the funding entry — over-crediting is now
  impossible to race. App prefers the RPC and falls back to the TS path when
  it isn't applied.
- **`client-fifo.ts`**: `payrollToItem` no longer reads the phantom
  `payroll.paid_salary` column; outstanding comes from an explicit
  `allocatedInr` parameter (Σ active `cashbook_payroll_allocations`).
- **`markPayrollUnpaid`**: soft-deletes the salary entry + its allocations
  (was a hard delete — the one break in the soft-delete convention). The
  phase-9 trigger re-derives payroll status from surviving active rows.
- **`serverCancelTask`**: `[JOB LOSS]` entries are `scope='company'`;
  deliberately NO `client_id` (the rebilling trigger would bill the client
  for our own written-off work).
- Verify after applying both migrations: `scripts/verify-finance-phase3-4.sql`.

**Verification at every phase:** `npx tsc --noEmit`, `npm run build`,
`npm test`, plus the phase's SQL verify script and a manual smoke of the
affected screens.

## Engine boundary + remaining consolidation

The engine v1 deliberately models the **cash ledger** (cashbook + categories)
plus **attribution inputs** (contribution scores, expense items, wallet
debits). Invoice-side AR metrics (Total Billed / Outstanding / Overdue on the
dashboard) are receivables, not cash — they stay single-sourced in
`dashboard/page.tsx` until the GL step promotes invoices into the journal.

**Rule for all future work: any new or modified financial surface must
consume `src/lib/finance` — no hand-rolled aggregation.** Known legacy
surfaces still on their own math (consolidate opportunistically when next
touched):
- `dashboard-analytics.tsx` monthly jobs−payroll table (accrual management
  metric; distinct from the engine's cash P&L — label it or migrate it)
- `lib/reports/contribution-analysis.ts` task-profit column (feeds What-If;
  shares inputs with `client-profitability.ts` — unify on the engine)
- `lib/partners/queries.ts` statement math (uses raw `total_amount`, not the
  INR snapshots — known FX inconsistency)
- Internal-campaign PDF reports: DB-ready (`ad_reports.client_id` nullable);
  the `lib/reporting` wiring is pending (that module was under concurrent
  active development when Phase 3/4 shipped).
