# Profit Sharing, Capital & Device Valuation — Design Revision 5 (for final approval)

**Status: approved for implementation on 2026-10-22** (your instruction: "please develop asap and push to main"). Open items D1, D7, D11, D12 and D17 keep the conservative behaviour described here. Before approval: No application code, test, migration, permission, Cash Book entry, payroll record or production data has been created or changed. This file is the only change, and it's untracked in worktree `cirqle-app-profit-sharing` (branch `feat/profit-sharing`, from origin/main `b791c65`). Nothing has been queried in production; Appendix A lists read-only queries that have **not** been run.

### What Revision 5 changes

Your fast-track decisions close everything that affects the build:

| Group | Decisions | What it means |
|---|---|---|
| Now confirmed | D4, D8, D9, D10, D14, D16 | D4: prepaid treatment, 60-day initial threshold. D8: five categories, created only at implementation. D9: reserve as an earmark. D10: device capital only under an approved written agreement. D14: cost recognised in the confirmation period. D16: one Admin, with actor, timestamp and audit event recorded |
| Policy confirmed, verification pending | D15 | Who holds Cash Book access today still has to be checked |
| Still open, by your instruction | D1, D7, D17 | None blocks building; they block confirming the periods that depend on them (§15.2) |
| Deferred as conservative recommendations | D11 (device policy), D12 (agreement terms) | They don't touch the profit engine and wait for the device and investor-exit features. Legally significant terms stay subject to explicit agreement and professional review |

Also added: a short screens-and-navigation outline (§13.5) and a deferred build order (§15.4). Everything else from Revision 4 is unchanged.

## Tags

| Tag | Meaning |
|---|---|
| **[Confirmed]** | Your decision. Not changed here |
| **[Recommended]** | My proposed design choice |
| **[Open]** | Needs your decision (collected in §15) |
| **[Verified]** | Checked against source code or migrations in this repository (file named) |
| **[Unverified]** | Not yet confirmed from source or production; Appendix A says how to confirm it |

"Verified" means verified **in the repository**. Production was changed by hand in the SQL editor (`supabase/APPLIED.md`), so where production state matters it's marked [Unverified] until a query confirms it.

---

## 1. Executive summary and critical findings

Profit sharing is built as a separate, admin-only module. It reads the Cash Book, invoices, ad wallet, payroll and credit ledger, and writes only its own tables. The one exception is a Cash Book entry written on an explicit admin payment action.

Profit for sharing is **Cirqle's own revenue actually collected**, minus genuine operating payments, minus remuneration earned. Every Cash Book line and every payroll row lands in exactly one class (§3). Anything that can't be classified confidently blocks confirmation until an admin classifies it in a review queue. The source record is never edited.

### Critical findings that change Revision 2

| # | Finding | Status | Consequence |
|---|---|---|---|
| F1 | Locking a month does **not** stop Cash Book edits. `cashbook/actions.ts` never calls `isMonthFinalized`, and no trigger guards `cashbook_entries` (`20260807090000_financial_core.sql` adds `period_locks` but no Cash Book trigger) | [Verified] | Locks can't be the freeze. Confirmed periods keep their own **frozen input snapshot** plus a **fingerprint**; later edits raise a drift warning (§11) |
| F2 | Account balances need `bank_accounts.opening_balance`. The Accounts page uses it (`cashbook/accounts/accounts-client.tsx:140`); Company Ops' bank balance and Revision 2's cash bridge did not | [Verified] | Opening and closing cash = Σ opening balances + Σ live entries |
| F3 | Salary advances deducted in payroll (`payroll.advances_deducted`) are typed by hand (`payroll-client.tsx:790`) and **never written to the credit ledger**. Only `createCreditEntry` / `convertCredit` write it (`payroll/actions.ts:703,771`) | [Verified] | The same advance can be recovered in payroll **and** converted to salary in the credit ledger, which would count pay twice. A review links them (§6) |
| F4 | Stored `payroll.net_salary` is not a reliable figure. `liveFigures` includes `bonus` (`payroll/actions.ts:58`), but the bulk recalc and ownership patch omit it (`:219`, `:351`) | [Verified] | Gross is computed from components; a stored net that disagrees is flagged |
| F5 | Invoices already separate pass-through money: `invoice_ad_spend_items` (ad spend), `invoice_expense_items.original_amount_inr` (rebilled costs) vs `invoice_items` (fees, incl. "Agency Service Charge") and `markup_amount` (`src/lib/advertising/billing.ts:164-210`) | [Verified] | A collection's composition can be **derived from the invoice it's allocated to** |
| F6 | The client ad "wallet" is funded by **Cirqle's own outflows** to ad platforms ("top-up = Cash Book outflow share", `src/lib/advertising/wallet.ts:7`). Clients pay invoices; the app has **no record type for client money received for ads** | [Verified] | Client money is recognised through invoice allocation only; unallocated client receipts are held as client funds (§4) |
| F7 | No GST-registration setting and no refund or credit-note feature. Refunds are Cash Book **reversals** (`reversal_of`, migration `20261016100000_cashbook_reversals.sql`), which exist in production (16 Oct incident) and in the main checkout but **not on origin/main** | [Verified in repo] / [Unverified in prod] | GST is pending your information (§5). Reversals net in the same category; the engine must read `reversal_of` |
| F8 | `cashbook_entries` and `payroll` remain readable by logged-in users at table level (`20260815110000…least_privilege.sql`, keep list). Cash Book has a row policy of `has_permission(…,'cashbook.view')` (`20260801090000_apply_006_rls_idempotent.sql:248`) | [Verified in repo] / [Unverified in prod] | Payout and capital entries in the Cash Book would be visible, and searchable (`src/lib/search/global-search.ts:74`), to every `cashbook.view` holder (§12) |
| F9 | The generated `src/types/supabase.ts` is stale: no `scope`, `services.category_id`, `reversal_of`, `ownership_earned` | [Verified] | The implementation must not rely on generated types for these columns |
| F10 | A legacy `salary_advances` table exists with an RLS policy (`apply_006…:269`), but no current code reads or writes it (only a comment in `strip.ts:139`) | [Verified] | Historical advances may live in two places; Appendix A Q11 checks |
| F11 | Revision 2 counted ad spend and its recovery as operating expense and revenue, and treated Business Reserve as interchangeable with free cash | — | Both corrected (§4, §10) |

---

## 2. Requirements register

### Confirmed requirements (preserved without alteration)

| # | Rule |
|---|---|
| 1 | Profit sharing is based on Cirqle's own money actually collected, not simply invoiced revenue |
| 2 | The distribution rate is 50% of eligible profit after accumulated losses are absorbed |
| 3 | The distribution pool is split initially into 50% Capital Share and 50% Business Reserve |
| 4 | Capital Share / Business Reserve percentages are configurable by an authorised Admin and always total exactly 100% |
| 5 | The part outside the distribution pool remains in the business |
| 6 | Founder, employee investors and possible external investors are supported |
| 7 | Employee contribution earnings are remuneration for work, not a contribution-based profit-share percentage |
| 8 | Founder remuneration is an expense; the founder receives profit share only through eligible capital |
| 9 | Remuneration is counted once |
| 10 | Losses carry forward and are absorbed before future profit distributions |
| 11 | Historical Personal Withdrawals are reviewed individually; no automatic historical reclassification |
| 12 | Device valuation is individual, with no fixed monthly device allowance |
| 13 | Device valuation never automatically triggers payment, investment or a payslip entry |
| 14 | Profit-sharing information is Admin-only in this release |
| 15 | Confirmed periods keep their own frozen input snapshots and fingerprints, because locking a month doesn't freeze Cash Book edits |
| 16 | A later source-data change triggers a drift warning and never silently rewrites a confirmed period |

Settings changes never alter a confirmed period, and the distribution rate is set separately from the Capital/Reserve split.

### 2.1 Decision register (D1–D17)

| # | Decision | Status | Verification | What the design does |
|---|---|---|---|---|
| D1 | GST and TDS | **[Open]** | Business facts [Unverified] | Tax-bearing invoices go to review; no tax treatment is applied (§5) |
| D2 | Order for partial invoice payments | **[Confirmed]** | Invoice item tables [Verified] | Pass-through → applicable tax → own revenue; an allocation that can't be split reliably goes to review (§3.3–3.4) |
| D3 | Client receipts not yet allocated | **[Confirmed]** | Allocation table [Verified] | Held as client funds (a liability) until allocated and their composition is known (§3.3, §4) |
| D4 | Ad funding not yet shared to a wallet | **[Confirmed]** | That it can happen [Verified]; amount today [Unverified, Q9] | Prepaid asset, always listed for review, never silently revenue or expense. Blocks confirmation after 60 days (initial default, configurable) (§4.4, §11) |
| D5 | Payroll and salary advances | **[Confirmed]** | Formulas and gaps [Verified] | Gross from components, recognised when earned, counted once; deductions linked to credit-ledger advances; conversions classified; conflicts and unallocated salary payments block (§6) |
| D6 | Bank reconciliation | **[Confirmed]** | Tables [Verified]; production state [Unverified, Q12] | Accounts under reconciliation: block if incomplete, unmatched in the period, or mismatched above the tolerance (₹1.00 [Recommended]). Other accounts: warn. Opening balances included (§11) |
| D7 | Scheme start month and opening loss | **[Open]** | — | Mandatory setup before the first confirmation; history shown for reference only (§7.1) |
| D8 | Five Cash Book categories | **[Confirmed]** for future use | Not in repo seed [Verified]; production custom categories [Unverified, Q1] | Capital Introduced, Capital Withdrawn, Profit Share Payout, Loan Received, Loan Repaid, created by the implementation migration only if missing. History still reviewed individually (§3.3) |
| D9 | Business Reserve | **[Confirmed]** | — | Internal earmark; no loss absorption or payout funding; a release needs a reason + Admin approval; deducted once from cash available (§10) |
| D10 | Device usage value as capital | **[Confirmed]** | — | Only under an approved written device-investment agreement and an approved device policy. Cost recognised once; capital settlement recorded separately; never paid in cash and credited as capital (§9) |
| D11 | Device valuation policy | **[Recommended]**, deferred | — | No policy approved yet. Device valuations stay draft-only until you approve a versioned policy. Doesn't block the profit engine (§8) |
| D12 | Investor capital and exit terms | **[Recommended]**, deferred | — | Five terms captured per agreement, subject to explicit agreement and professional review. Proposed agreement-form defaults: earned entitlements survive exit; device capital weighs the same as cash and stays fixed; no buy-back unless agreed. Repayment timing has **no default** and must be entered (§7.4) |
| D13 | Capital Share above cash available | **[Confirmed]** | — | Warning + written acknowledgement to confirm; cash rechecked at every settlement (§10.3) |
| D14 | When device usage cost is recognised | **[Confirmed]** | — | In the period of confirmation; draft, calculated and reviewed valuations have no accounting effect; the later payment isn't counted again (§9.4) |
| D15 | Cash Book privacy | **Policy [Confirmed]** | Current assignments [Unverified, Q4] | Only Admins hold `cashbook.view`. A read-only check is a prerequisite before implementation; neutral descriptions everywhere (§12) |
| D16 | Review and confirmation | **[Confirmed]** for the initial release | — | One authorised Admin may review and confirm; actor, timestamp and an audit event are recorded at each step (§11.2) |
| D17 | Meaning of `payroll.other_deductions` | **[Open]** | Meaning [Unverified] | Warning only; no accounting treatment; net-pay effect kept apart from accounting (§6.1) |

**Other recommendations still standing** (conservative and reversible, labelled [Recommended] where they appear):

- the ₹1.00 reconciliation tolerance
- the 90-day warning on unrecovered pass-through costs
- invoice discounts reduce own revenue only
- invoices with a carried balance or a failed composition check go to review
- the market-value tolerance inside the device policy

Recommendations and verification status are also tagged inline. The remaining blockers are in §15.

---

## 3. Cash-profit methodology and transaction classification

### 3.1 Can Revision 2's formula be used? [Verified analysis]

No, not as written. "Cash collected = every revenue-section inflow" would count client ad money, refunds of pass-through costs, tax, and anything mis-categorised (capital booked as "Other Income"). "Operating payments = every cogs/opex outflow" would count ad funding paid on clients' behalf.

### 3.2 Revised formula [Recommended]

```
Distributable operating profit (period)
  = Own revenue collected                      (class 1)
  − Own operating payments                     (class 8)
  − Remuneration earned                        (class 9)
  − Confirmed device usage costs               (§9, recognised when confirmed)
  − Pass-through losses written off            (class 3, e.g. invoice marked bad debt)
```

Classes 2–7 and 10 never enter profit; they appear only in the cash bridge and liability checks.

### 3.3 Classification rules [Recommended unless tagged]

The rule is "every Cash Book line, payroll row and credit-ledger row lands in exactly one class". A line the rules can't place goes to **Needs review**, which blocks confirmation (§11).

| # | Class | Authoritative source | Inclusion rule | Cash Book section / category | Refunds, partials, timing | Duplicate prevention | If unclear |
|---|---|---|---|---|---|---|---|
| 1 | **Own revenue collected** | Cash Book inflow + its live, unreleased `cashbook_invoice_allocations` row + the invoice's composition | The **own-revenue share** of each allocated rupee, recognised on the later of entry date and allocation date. Inflows with no client and no invoice link go to review | `revenue` (e.g. Invoice, Visiting Charge, Commission, Other Income) [Verified seed list, `20260714090000`] | **Partial payments [Confirmed D2]:** pass-through first, then applicable tax, then own revenue; an allocation that can't be split reliably goes to review. **Refund:** a reversal (`reversal_of`) undoes the same composition in the reversal's period. **Late allocation:** recognised when allocated | `payments` rows and `invoices.paid_amount` are **never read** (they mirror the same cash). Σ allocations of an entry is capped at the entry amount; any excess is flagged | Unallocated client inflow → class 7; no client and no invoice → review |
| 2 | **Client funds held** | Inflows from a client not (yet) allocated to an invoice | Liability, never revenue, until allocated and its composition is known [Confirmed D3] | Whatever category the receipt used, usually Invoice | Becomes class 1 or 3 when allocated; returned money is a reversal | Each rupee is either allocated (class 1/3) or held, never both | — |
| 3 | **Pass-through costs and recovery** | Outflows linked to a client wallet top-up (`ad_wallet_ledger` credit, `client_id` set) or to `invoice_expense_items.cashbook_entry_id`; recoveries from invoice composition (`invoice_ad_spend_items`, `original_amount_inr`) | Paid → **pass-through receivable** (not expense). Recovered → reduces the receivable (not revenue). Written off when its invoice becomes `bad_debt` → a loss in that period | Online Spend `cogs.ad_spend` (client), rebilled expenses in any category flagged `is_billable` | Partially recovered: the remainder stays receivable. Aged > 90 days → warning (threshold [Recommended], not a decided policy) | One outflow → one wallet credit (existing `cashbook_entry_id` link); recovery comes only from invoice composition | Online Spend outflow with no wallet share → "unassigned platform funding", listed for review (§4.4, [Confirmed D4]) |
| 4 | **Tax collected** | `invoices.tax_amount` share of each collection | Liability; remittances settle it | Remittance currently lands in "Tax & Government Fees" `opex.taxes_fees` [Verified seed], so it must be classified | Pending your GST/TDS facts [Open D1]; no treatment applied until then | Once D1 is confirmed: a remittance classified as tax settlement is excluded from class 8 | Every invoice with `tax_amount > 0` → review while D1 is open |
| 5 | **Capital and loans** | Cash Book inflow/outflow + its profit-share capital or loan classification | Never revenue or expense | No such category exists in the repo seed [Verified]; production may have custom ones [Unverified, Q1]. The five new categories are approved for future entries [Confirmed D8] and created only at implementation | Repayments are the reverse class | One Cash Book entry ↔ one capital movement (§13.4 cash-link table) | Unidentified receipts → review |
| 6 | **Own-account transfers** | `transfer_ref` set | Excluded (the journal already drops them, `journal.ts:130`) [Verified] | — | An orphan leg (other side deleted) → review | Pair must net to 0 | Orphan → review |
| 7 | **Refunds, credits, chargebacks, customer advances** | Reversals (`reversal_of`); `financial.credit_*` lines; class 2 | Reversals net within their original class. Credit given/returned = receivable movements | `financial.credit_given` / `credit_return` [Verified] | A chargeback without `reversal_of` (an outflow in a revenue category) → review | One live reversal per entry (unique index, `20261016100000`) [Verified in main checkout] | → review |
| 8 | **Own operating payments** | Cash Book outflows in `cogs`/`opex` not in classes 3, 4, 9, 10, and not a settlement of a liability already expensed (salary paid, device usage settlement) | Expense when paid | cogs/opex categories [Verified seed]; recurring expenses post here too [Verified, `financial_core.sql:99`] | Supplier refunds (inflows or reversals in cogs/opex) reduce it | Salary entries linked to payroll and device settlements linked to a valuation are skipped by link | No category / no section → review |
| 9 | **Remuneration earned** | `payroll` rows (components) + `credit_ledger` `converted_salary` rows classified as additional pay | Gross per payroll month (§6) | Salary `opex.salaries` outflows are **settlements**, not expense | See §6 | Gross from payroll only; Ownership never read from `ownership_awards` | Salary outflow with an employee but no payroll allocation → review |
| 10 | **Withdrawals, drawings, payouts** | `excluded` section lines + profit-share classification | Never expense | Personal Withdrawals `excluded.owner_drawings` [Verified seed]; payout and withdrawal categories approved for future use [Confirmed D8] | Each historical one reviewed (§7.5) | One entry ↔ one classification (unique) | Unreviewed in the period → blocks |

### 3.4 Invoice composition [Verified sources, Recommended rule]

For each invoice, in INR at the invoice's rate:

```
own      = Σ invoice_items.total + Σ invoice_expense_items.markup_amount − discount_amount
pass     = Σ invoice_ad_spend_items.amount_inr + Σ invoice_expense_items.original_amount_inr
tax      = tax_amount
carried  = previous_balance
check:     own + pass + tax + carried = total_amount   (± ₹1)
```

- Discount is assumed to reduce own revenue only [Unverified business rule]. `total_amount` is stored net of discount [Verified, `invoice-revenue.ts` header].
- Campaign invoices: `total_amount` = ad spend + service charge, and `tax_amount` isn't set even when `ad_projects.tax_percent` is [Verified, `advertising/budget.ts:117-119`, `billing.ts` `writeInvoiceLines`].
- An invoice whose check fails, or that carries `previous_balance`, can't be split automatically. How allocations treat a carried balance is [Unverified]. Its collections go to **review**, where the admin enters the split with a reason.

### 3.5 Worked example: one period, fully reconciled (illustrative figures)

Period Apr–Sep 2026. Opening accumulated loss ₹20,000, an illustrative figure (the real one is D7). For illustration only, no invoice in the period carries tax; with D1 open, any that did would sit in review.

**Cash Book movements in the period**

| Movement | Class | ₹ |
|---|---|---|
| Collections allocated to invoices: pass-through first → ₹1,80,000 recovery + ₹7,20,000 own | 3 + 1 | + 9,00,000 |
| Client receipt not yet allocated to any invoice | 2 | + 20,000 |
| Employee investor's capital (1 Jul) | 5 | + 1,00,000 |
| Refund of a June receipt (reversal; that receipt was all own revenue) | 1 | − 10,000 |
| Ad platform funding shared to client wallets | 3 | − 1,90,000 |
| Rent, software, internal campaigns (company wallet), other | 8 | − 2,70,000 |
| Salaries paid (allocated to payroll rows: March ₹45,000 + Apr–Sep ₹2,60,000) | 9 (settlement) | − 3,05,000 |
| Personal Withdrawals (founder; reviewed in §7.5) | 10 | − 45,000 |

**Profit**

| Line | ₹ |
|---|---|
| Own revenue collected (7,20,000 − 10,000) | 7,10,000 |
| Own operating payments | − 2,70,000 |
| Remuneration earned, payroll gross Apr–Sep | − 3,20,000 |
| **Distributable operating profit** | **1,20,000** |

**Cash bridge** (must balance to the paisa)

| | ₹ |
|---|---|
| Opening cash (Σ account opening balances + Σ entries before 1 Apr) | 1,40,000 |
| + Movements above (9,00,000 + 20,000 + 1,00,000 − 10,000 − 1,90,000 − 2,70,000 − 3,05,000 − 45,000) | + 2,00,000 |
| **Closing cash** | **3,40,000** |

**Profit → cash reconciliation**

| | ₹ |
|---|---|
| Profit | 1,20,000 |
| + Pay earned but not yet paid (3,20,000 − 2,60,000 paid for Apr–Sep) | + 60,000 |
| − March pay (earned in the previous period) paid in this one | − 45,000 |
| − Pass-through paid, not yet recovered (1,90,000 − 1,80,000) | − 10,000 |
| + Client funds held | + 20,000 |
| + Capital introduced | + 1,00,000 |
| − Personal Withdrawals | − 45,000 |
| **= Change in cash (3,40,000 − 1,40,000)** | **+ 2,00,000** ✓ |

Payroll liability: opening ₹45,000 + earned ₹3,20,000 − paid ₹3,05,000 = **₹60,000** at 30 Sep.

---

## 4. Client ad wallet and pass-through money

### 4.1 How the money actually moves today [Verified, `wallet.ts`, `billing.ts`]

1. Cirqle pays the ad platform: a Cash Book **outflow**, Online Spend `cogs.ad_spend`.
2. The outflow is shared to wallets: `ad_wallet_ledger` **credit** rows (`kind 'topup'`), linked by `cashbook_entry_id`. `client_id` is the client, or null for Cirqle's own campaigns.
3. Campaigns draw from a wallet: `ad_wallet_ledger` **debit** rows (`campaign_allocation`). The campaign's billing basis is Σ debits.
4. The campaign's invoice gets an ad-spend line (`invoice_ad_spend_items`) and an "Agency Service Charge" line (`invoice_items`, the campaign task's billing = the service charge only, `billing.ts:132-136`).
5. The client pays the invoice: a Cash Book **inflow** allocated to that invoice.

### 4.2 Distinctions the design draws [Recommended]

| Concept | Measured as | In profit? |
|---|---|---|
| Client funds received | Client inflows; allocated part → recovery/revenue, unallocated part → **client funds held** | Only the own-revenue share, once allocated |
| Client funds spent | Wallet debits to that client's campaigns | No (it's the client's spend) |
| Unspent client balance | Wallet credits − debits for the client (money Cirqle has paid out on the client's behalf, not yet used) | No; part of the pass-through receivable |
| Ad costs paid before reimbursement | Pass-through receivable = Σ client wallet credits − Σ recovered | No, unless written off |
| Cirqle's own service fee | The "Agency Service Charge" share of collections | **Yes**, when collected |
| Cirqle's own campaigns (company wallet, `client_id` null) | Operating payment | **Yes**, as expense |

### 4.3 Worked example: ₹20,000 of client ad money (15% service charge)

| Date | Event | Cash | Client funds held | Pass-through receivable | Own revenue | Profit |
|---|---|---|---|---|---|---|
| 5 Sep | Client X transfers ₹20,000 (no invoice yet) | +20,000 | +20,000 | — | — | 0 |
| 8 Sep | Cirqle funds Meta ₹20,000, shared to X's wallet | −20,000 | — | +20,000 | — | 0 |
| 8–28 Sep | Campaigns use ₹20,000 from X's wallet | — | — | — | — | 0 |
| 30 Sep | Invoice: ad spend ₹20,000 + service charge ₹3,000 = ₹23,000 | — | — | — | — (not cash) | 0 |
| 30 Sep | The ₹20,000 held is allocated to the invoice (pass-through first) | — | −20,000 | −20,000 | — | 0 |
| 10 Oct | Client pays ₹3,000 | +3,000 | — | — | +3,000 | **+3,000 (Oct)** |
| **Total** | | **+3,000** | 0 | 0 | 3,000 | **3,000** |

The ₹20,000 never becomes revenue and never becomes expense.

**For contrast, pro-rata allocation** (not used): the 30 Sep allocation would recognise 20,000 × 3/23 = ₹2,608.70 of own revenue in September while ₹2,608.70 of Cirqle's own ad funding was still unrecovered. The total is the same (₹3,000), but profit arrives before costs are recovered. That's what the confirmed order (D2) prevents.

**Unspent variant:** if only ₹15,000 of the wallet is used by 30 Sep, the invoice is ₹15,000 + ₹2,250.

- Allocating the ₹20,000 held: ₹15,000 recovers pass-through, ₹2,250 is own revenue, and ₹2,750 stays **held**.
- The pass-through receivable is ₹5,000: the unused wallet money, which is neither expense nor revenue.

### 4.4 What current data can't tell us

| Gap | Status | Minimum classification needed |
|---|---|---|
| Online Spend outflows **not shared** to any wallet | [Verified possible: the share is a separate step] [Confirmed D4] **Prepaid ad-platform funding** (an asset), not revenue, expense or receivable, and always listed for review so it's never silently counted. Initial threshold 60 days (configurable): older unassigned funding blocks confirmation until shared to a wallet or written off by review |
| Client receipts recorded **without** a client or invoice | [Unverified count, Q8] | Review: own revenue without invoice / client funds held / capital / loan / other |
| Rebilled costs marked `is_billable` but never put on an invoice | [Unverified count] | Pass-through receivable with ageing; written off by review |
| Client paying the platform directly (Cirqle never touches the money) | Not represented in the Cash Book [Verified: no record type] | Nothing to do: only the service-charge collection appears, as own revenue |

---

## 5. GST and other taxes — PENDING YOUR CONFIRMATION [Open D1]

[Verified] facts: `invoices.tax_rate`/`tax_amount` exist; `clients.gstin` exists; there's no company GST-registration setting; campaign invoices compute tax but don't put it in `total_amount`.

Until you confirm, **any invoice with `tax_amount > 0` sends its collections to review**. No tax liability is computed, and no tax treatment is applied automatically. Tax is second in the confirmed D2 order, but that step only operates once D1 is confirmed.

The rest of this section is a **proposal**, not applied until D1 is confirmed. If D1 confirms GST registration:

- The tax share of each collection (§3.4) is a **liability**, not revenue.
- A GST remittance in the Cash Book (today, "Tax & Government Fees") is classified as **tax settlement**: it reduces the liability and is **not** an operating expense. Counting it as an expense after excluding the tax from revenue would deduct it twice.
- Input tax credit (GST inside ad spend or purchases): if you claim it, the recoverable part is a receivable, not an expense. Needs your confirmation.
- TDS, a separate question within D1: if clients deduct it, the invoice is short-paid. Proposed: the TDS is a tax credit receivable, not lost revenue. How TDS is recorded today is [Unverified]. Until D1 is answered nothing is assumed: a short-paid invoice is simply not fully collected.

Example (if registered): fee ₹10,000 + 18% GST ₹1,800 = ₹11,800 collected → own revenue **₹10,000**, GST liability ₹1,800. Remitting ₹1,800 clears the liability: profit +₹10,000 in total, not ₹8,200 or ₹11,800.

---

## 6. Payroll and advances

### 6.1 Definitions [Verified sources]

Per employee per payroll month:

| Term | Formula / source |
|---|---|
| **Gross remuneration earned (G)** | `base_salary + commission_earned + bonus + adjustment_earned + ownership_earned` (the payslip's gross, `payslip-html.ts:129`) |
| Advance deducted (A) | `advances_deducted` (typed by hand) |
| Other deductions (O) | `other_deductions`. Its **meaning is unknown [Open D17]**: it could be a penalty, tax withheld, a loan recovery, or something else |
| **Net salary payable (N)** | `max(0, G − A − O)`, computed, not read from `net_salary` (F4) |
| **Salary paid (S)** | Σ live, unreleased `cashbook_payroll_allocations.allocated_amount` for the row |
| **Outstanding payroll liability** | N − S (negative → overpayment, flagged) |
| Advances issued | `credit_ledger` `given` (cash out, `financial`) |
| **Advance recovered by deduction** | `min(A, G − O)`. The clamp at 0 means a deduction larger than pay recovers only what pay allowed |
| Advance converted to salary | `credit_ledger` `converted_salary` (no cash; `convertCredit` writes no Cash Book entry [Verified]) |
| Ownership and incentives | Inside G (`ownership_earned`, `bonus`); `ownership_awards` is never read |

**Rule [Confirmed D5]:**

- Remuneration expense = Σ G for the payroll months in the period, plus `converted_salary` conversions **classified as additional pay**. Recognised when earned, not when paid.
- G is computed from components, never from stored `net_salary`.
- Salary Cash Book outflows are settlements, never expense.
- A conversion classified as "records a payroll deduction" is ignored.

**`other_deductions` while D17 is open:**

- **Effect on net pay (a payroll fact):** N = G − A − O, exactly as payroll computes it. This drives the payroll liability.
- **Accounting treatment:** none assumed. O is **not** added as an expense, **not** subtracted from the expense, and **not** treated as a receivable or a liability. Remuneration expense stays G.
- **Validation:** any period with O > 0 shows a warning listing each row and amount, flagged "treatment unconfirmed (D17)". In the cash bridge, O is its own reconciling line ("payroll deductions, treatment unconfirmed"), so the bridge still balances without classifying it.
- **What a D17 answer would change** (for awareness only, nothing applied):
  - a penalty would lower the expense
  - tax withheld would be a liability to the government and reduce free cash
  - a loan recovery would reduce a receivable

  Until then, if O is in fact tax withheld, free cash is overstated by O, and the warning says so.

### 6.2 Worked examples (employee CQID-007)

**1. Earned in September, paid in October.** Base 20,000 + commission 5,000 = G 25,000; paid 3 Oct.

| Month | Cash | Remuneration expense | Payroll liability (closing) | Profit effect |
|---|---|---|---|---|
| Sep | 0 | 25,000 | 25,000 | −25,000 |
| Oct | −25,000 | 0 | 0 | 0 |
| **Total** | **−25,000** | **25,000** | | |

**2. Advance issued earlier, deducted from salary.** Advance ₹5,000 on 12 Aug; September G 25,000, A 5,000 → N 20,000, paid 3 Oct.

| Month | Cash | Expense | Payroll liability | Advance receivable | Profit |
|---|---|---|---|---|---|
| Aug | −5,000 | 0 | 0 | 5,000 | 0 |
| Sep | 0 | 25,000 | 20,000 | 0 (recovered by deduction) | −25,000 |
| Oct | −20,000 | 0 | 0 | 0 | 0 |
| **Total** | **−25,000** | **25,000** | | | |

*Limitation (F3):* the credit ledger still shows ₹5,000 outstanding. The deduction must be **linked** to that credit in a review; otherwise the engine flags it.

**3. Advance converted to salary (no deduction).** Advance ₹5,000 on 12 Aug; converted to salary on 20 Sep as a reward.

| Month | Cash | Expense | Advance receivable | Profit |
|---|---|---|---|---|
| Aug | −5,000 | 0 | 5,000 | 0 |
| Sep | 0 | 5,000 | 0 | −5,000 |
| **Total** | **−5,000** | **5,000** | | |

*Double-count trap:* if the advance in example 2 were **also** recorded as `converted_salary` to clear the credit ledger, expense would be 30,000 against cash of 25,000. The review must classify that conversion as "records a payroll deduction", which is ignored.

**4. All components.** October: base 15,000 + commission 8,400 + bonus 2,000 + adjustment −600 (September commission over-paid) + ownership 1,200 = **G 26,000**; no deductions; N 26,000, paid 2 Nov.

- Expense ₹26,000 in **October**.
- The −600 belongs to September economically, but it's booked when payroll books it. September is frozen once confirmed.
- If the stored `net_salary` says 24,000 (a recalc path that drops bonus, F4), the engine still uses 26,000 and flags "stored net differs by ₹2,000". If only 24,000 is paid, ₹2,000 stays as payroll liability.

**5. Salary Cash Book payment with no payroll row.** ₹10,000 to CQID-009 on 15 Sep, category Salary, no allocation. **Blocks confirmation until classified:**

| Classification | Cash | Expense | Liability | Receivable | Profit |
|---|---|---|---|---|---|
| a. Pays an existing payroll row (e.g. August, N 10,000 unpaid) | −10,000 | 0 | −10,000 | — | 0 |
| b. Extra pay outside payroll | −10,000 | +10,000 | 0 | — | −10,000 |
| c. Actually an advance | −10,000 | 0 | 0 | +10,000 | 0 |

For (a) and (c) I recommend also fixing the source in Payroll / Cash Book, outside this module.

**6. Salary paid net of an advance.** Same as example 2: the October Cash Book entry is ₹20,000, allocated to the September row.

- If pay were taken from Cash Book salary entries, expense would be **20,000 ✗**. The ₹5,000 left as `financial` credit in August and would never become an expense anywhere.
- Using gross: **25,000 ✓**.

### 6.3 Minimum extra classification [Confirmed D5] (held in the module's review table, no payroll change)

Items 1–3 below that remain unresolved **block confirmation** of any period they fall in. These are unallocated salary payments, and any advance or conversion conflict.

1. **Deduction link:** each payroll row with A > 0 → the credit-ledger `given` row(s) it recovers.
2. **Conversion class:** each `converted_salary` row → additional pay, or records a payroll deduction.
3. **Unallocated salary outflow:** pays payroll row X, extra pay, or advance.
4. **Legacy `salary_advances` rows** (F10): read for history; mapped to the credit ledger by review if any are still open [Unverified, Q11].

---

## 7. Loss carry-forward, distribution and capital

### 7.1 Loss carry-forward [Confirmed rule; Recommended mechanics]

```
Loss offset         = min(Opening loss, max(0, Result))
Closing loss        = Opening loss − Loss offset + max(0, −Result)
Eligible profit     = max(0, Result − Loss offset)
```

**Scheme start [Open D7].** The first period's opening accumulated loss, and the month the scheme starts, are **required setup inputs you provide**. Until both are recorded, no period can be confirmed. The setup screen may show the Cash Book's historical results as **reference information only**. They never set the opening loss and never reclassify a historical transaction. Both values are fixed once the first period is confirmed; a later correction is a documented adjustment, not an edit.

Sequence (illustrative; opening loss 0 is an example, not a proposal for D7):

| Period | Opening loss | Result | Offset | Closing loss | Eligible |
|---|---|---|---|---|---|
| Apr–Jun | 0 | −40,000 | 0 | 40,000 | 0 |
| Jul–Sep | 40,000 | +25,000 | 25,000 | 15,000 | 0 |
| Oct–Dec | 15,000 | +1,15,000 | 15,000 | 0 | **1,00,000** |

### 7.2 Distribution, seven figures kept apart [Confirmed percentages]

Using the §3.5 period (profit ₹1,20,000, opening loss ₹20,000):

| # | Figure | Formula | ₹ |
|---|---|---|---|
| — | Profit used to absorb prior losses | offset | 20,000 |
| 1 | **Eligible profit** | 1,20,000 − 20,000 | **1,00,000** |
| 2 | **Distribution pool** | 50% × eligible | **50,000** |
| 3 | **Capital Share** | 50% × pool | **25,000** |
| 4 | **Business Reserve allocation** | 50% × pool | **25,000** |
| 5 | **Retained outside the pool** | eligible − pool | **50,000** |
| 6 | **Total retained in the business** | 4 + 5 | **75,000** |
| 7 | **Cash available for payment** | §10.3 | **2,35,000** |

Check: 20,000 + 25,000 + 25,000 + 50,000 = 1,20,000 ✓. Only the Capital Share (3) is ever owed to anyone.

**Settings validation [Confirmed rule, Recommended mechanics]:**

- Percentages are `numeric(5,2)` between 0 and 100.
- A database CHECK enforces `capital_share_pct + reserve_pct = 100.00`, and the server validates the same before writing.
- Settings are versioned (append-only, with an effective-from month). A run copies the version in force at its period start; a confirmed run reads only its copy.

### 7.3 Capital-days allocation [Recommended]

```
balance_i(d)   = Σ approved movements with effective_date ≤ d      (in − out)
capital-days_i = Σ over each day d in the period of balance_i(d)
share_i        = capital-days_i ÷ Σ capital-days
entitlement_i  = Capital Share × share_i, split to the paisa (largest remainder)
```

Capital Share ₹25,000, period 183 days:

| Investor | Capital | Counts from | Capital-days | Share | Entitlement |
|---|---|---|---|---|---|
| Founder | 5,00,000 | before 1 Apr | 9,15,00,000 | 90.8640% | **22,715.99** |
| Employee investor (CQID) | 1,00,000 | 1 Jul (92 days) | 92,00,000 | 9.1360% | **2,284.01** |
| **Total** | | | 10,07,00,000 | 100% | **25,000.00** ✓ |

The paisa remainder: founder 22,715.988 → 22,715.99, employee 2,284.012 → 2,284.01. The sum is exact.

### 7.4 Investor lifecycle [Recommended unless tagged]

| Question | Rule |
|---|---|
| **Effective date vs approval date** | A movement counts from its **effective date** once **approved**. Effective date ≥ the date the money (or device) was received. Approval can come later, but a movement can't take effect inside an already **confirmed** period: if approved after that period was confirmed, it counts from the first day of the next unconfirmed period |
| **Device capital** | Only under an approved written device-investment agreement [Confirmed D10] and an approved device policy (D11). Then it counts from the agreement's effective date, the handover date, or the next unconfirmed period, whichever is latest. Whether it weighs the same as cash capital, and whether it stays fixed, are agreement terms [Recommended D12: equal weight, fixed; subject to agreement and professional review] (§9.1) |
| **Withdrawals** | An outflow movement with its own effective date; it can't take the balance below 0 on any day (database trigger + test) |
| **Reinvested profit** | A settlement `reinvested` + a capital movement in one atomic database function; counts from the settlement date |
| **Exit** | Capital stops counting on the exit date (an outflow movement for the full balance; repayment pending). **Repayment amount and timing come only from that investor's approved agreement [Recommended D12; subject to agreement and professional review].** No default period is assumed (the 90 days in Revision 3 is withdrawn). If the agreement has no repayment term, the exit is recorded as "repayment terms not agreed" and stays flagged until you record one |
| **Outstanding entitlements on exit** | **Recommended agreement default, not a contractual term [D12]:** earned entitlements survive exit in full and stay payable; they're never forfeited except by a waiver with a reason. It becomes binding only when recorded in the investor's approved agreement |
| **No eligible capital in a period** | The Capital Share is not allocated; it's added to "retained outside the pool" for that run, and a warning is recorded |
| **Corrections** | Approved rows are immutable; a correction is a new movement with a reason |
| **Terms every agreement must record before approval [Recommended D12; legally significant: explicit agreement + professional review]** | (1) capital repayment timing on exit; (2) whether outstanding entitlements survive exit; (3) for device capital, whether it weighs the same as cash capital; (4) whether device capital stays fixed or changes over time; (5) any device buy-back or repayment arrangement. The agreement form requires all five, so none can be left to a silent default |

### 7.5 Historical Personal Withdrawals [Confirmed: individual review]

Every `excluded.owner_drawings` entry appears in a queue. The admin classifies each one, with a note, as one of:

| Classification | Effect |
|---|---|
| Capital withdrawal | Creates a capital outflow movement (needs approval) |
| Advance profit distribution | Creates an advance balance for that member; later offset against an entitlement |
| Other personal drawing | No effect on capital or entitlements |
| Reimbursement of a business expense | Counts as class 8 operating payment (reduces profit), so it must be reviewed before the period is confirmed |
| Loan to the person | Recorded as a receivable; recommend moving it to the credit ledger outside this module |
| Other | Note required |

Safeguards:

- One review per entry (unique).
- A review that has been **used** (a capital movement or an advance offset exists) is locked; reclassifying needs the dependent record reversed first, with a reason.
- Nothing is classified automatically.

**Example, continuing §3.5:** ₹45,000 in two entries.

- ₹25,000 is classified as an advance distribution and ₹20,000 as an other personal drawing.
- On confirmation the founder's entitlement is ₹22,715.99. An advance offset of ₹22,715.99 leaves **pending ₹0**, and ₹2,284.01 of the advance carries forward to the next period.

---

## 8. Device valuation [Confirmed principles; parameters await a policy version (D11)]

**There is no approved device valuation policy (D11: deferred to the device feature; [Recommended] to keep confirmations disabled until you approve one).** Every parameter below is provisional: useful lives, depreciation floor, minimum remaining life, condition factors, business-use (daily work) shares, the device-need map and the market-value tolerance. Valuations can be **drafted and calculated** for review. None can be **confirmed**, or create any accounting, payment, capital or payslip effect, until you explicitly approve a versioned device policy.

### 8.1 Dates and values that must not be confused

| Pair | Meaning | Used for |
|---|---|---|
| Purchase date vs joining date | Purchase date sets the device's age; joining date (`employees.joined_date` [Verified]) is the earliest possible Cirqle use | Age; usage window |
| Registration date vs usage start | Registration = when it was entered in the app (proves nothing about use); usage start = when it began being used for Cirqle work, with evidence | Usage window starts at the latest of usage start, joining date, purchase date and period start |
| Replacement value vs evidenced resale value | Replacement = price of an equivalent **new** device; resale = what **this** device would fetch now, with evidence (listings, quotes) | Replacement only stands in for an unknown purchase price **and is always depreciated by age**; resale overrides the model value |
| Device value vs usage value | What the device is worth vs the wear Cirqle consumed | Transfer (case B) vs usage (case A) |
| Capital contribution vs cash reimbursement | Cirqle owes capital (no cash) vs pays cash | Settlement route (§9) |
| Estimated vs verified usage | Estimated from task data and policy assumptions vs established by declaration, manager confirmation or other documented evidence | A label on every valuation; verified needs a reason and evidence |

### 8.2 Formula under review

```
Model value V(d)   = Price × max(Floor, 1 − Age(d) ÷ Life) × Condition
Value used         = evidenced resale value if entered, else V(d)
Remaining life R   = max(Minimum remaining, Life − Age)              (months)
Monthly wear W     = Value used at usage-window start ÷ R
Usage value        = W × months in usage window × Business-use share
Transfer value     = Value used on the transfer date
```

Plain words: each month Cirqle uses a device, it uses up a slice of its remaining value. Cirqle's part of that slice is the share of use that's for Cirqle work.

**Where this could overvalue or double count, and the guard:**

| Risk | Guard |
|---|---|
| A **new-model replacement price** entered as "market value" for an old device (e.g. ₹80,000 for a 5-year-old phone whose model value is ₹7,000) | Market value accepts only **resale evidence for this device**; replacement is allowed only as the Price input and is always depreciated |
| Market value far above model value | Warning above a tolerance, with a reason required. The 1.5 × model tolerance is provisional (D11) |
| A short minimum remaining life inflating wear on a nearly worn-out device | A higher minimum *lowers* wear (W = V ÷ R), so it errs low; the parameter is still yours to set |
| Usage valued twice for overlapping windows | Database trigger: no two confirmed usage valuations of one device overlap |
| Usage valued, then the full value paid again on transfer | Transfer value is the value **on the transfer date**, already net of wear; no usage valuation after a transfer |
| A company-bought device valued for an employee | Devices linked to a Cirqle purchase ("Equipment & Devices" outflow) or marked company-owned can't get usage or transfer valuations |
| Repair cost counted twice | Only employee-paid repairs, inside the window, × business share; company-paid repairs are already Cirqle's expense |
| Daily work share assumed high | It's a policy input per device category, shown on every valuation; any override needs a reason |

### 8.3 Task-based usage assessment [Recommended]

**Task categories suggest which kind of device the work likely needed. They don't prove which physical device was used**, and the app records neither the device nor the time spent [Verified: `tasks` has no duration column; tools are recorded per task, devices are not].

1. **Device-need map** (policy): service category (`services.category_id → service_categories` [Verified, `20260722090000`]) → laptop / phone / both / none.
2. **Device-work days:** distinct dates in the window with at least one live, non-cancelled task linked to the person (`contribution_scores` or `task_assignments` [Verified columns]) whose category needs this kind of device.
3. **Available days:** the usage window ∩ employment (joining date to exit; exit is approximated by `archived_at` [Verified: there's no exit-date column]).
4. **Estimated business-use share** = device-work days ÷ available days × daily work share (policy).
5. **Verified share:** the admin replaces the estimate with a documented figure. The valuation shows **Verified** plus the evidence; otherwise **Estimated**.

**Context only, never in the formula:**

- task counts and category mix
- variant and quantity mix (a complexity proxy)
- contribution share, labelled "not a measure of device use"
- app-active days (`activity_logs`)
- mobile app installed on Android or iOS, and since when (`native_push_tokens` [Verified]), which proves a phone was used for the Cirqle app, not how much

### 8.4 Worked examples (illustrative parameters, NOT approved)

Assumed parameters for these examples only:

- Life: laptop 48 months, phone 36
- Floor: 10%
- Minimum remaining life: 12 months
- Condition: good 0.90, fair 0.75
- Daily work share: laptop 70%, phone 30%

Window Apr–Sep 2026 (183 days, 6 months).

| | A. Own laptop (usage) | B. Own phone (usage) | C. Old phone, resale evidence | D. Laptop A transferred 1 Oct |
|---|---|---|---|---|
| Price / purchase | 60,000, Jan 2025 | 25,000, Jun 2024 | 30,000, Jan 2022 | — |
| Age at window start | 15 months | 22 months | 51 months | 21 months on 1 Oct |
| Model value | 60,000 × (1 − 15/48) × 0.90 = **37,125.00** | 25,000 × (1 − 22/36) × 0.75 = **7,291.67** | floor: 30,000 × 0.10 × 0.90 = 2,700 | 60,000 × (1 − 21/48) × 0.90 = **30,375.00** |
| Value used | 37,125.00 | 7,291.67 | resale evidence **6,000** (> 1.5 × model → reason required) | 30,375 proposed; admin adjusts to 30,000 ("scratch on lid") |
| Remaining life R | 33 | 14 | 12 (minimum) | — |
| Monthly wear W | 1,125.00 | 520.83 | 500.00 | — |
| Business-use share | 104 work days ÷ 183 × 70% = **39.78% (estimated)** | 140 ÷ 183 × 30% = **22.95% (estimated)** | **25% (verified**: declaration + manager confirmation) | — |
| **Result** | 1,125 × 6 × 39.78% = **₹2,685.25** usage | 520.83 × 6 × 22.95% = **₹717.21** usage | 500 × 6 × 25% = **₹750.00** usage | **₹30,000** transfer value |

E. A company-owned laptop assigned to an employee and taken home gets **no valuation**. Only the assignment, condition and return are recorded.

Rounding: shares and wear are kept unrounded internally and only the result is rounded to the paisa; the table shows rounded intermediates.

---

## 9. Device ownership, capital recognition and reimbursement

### 9.1 Decision table [Recommended; D10 and D14 Confirmed]

| | **A. Employee-owned, used for Cirqle** | **B. Device formally contributed as capital** | **C. Company-owned, assigned** |
|---|---|---|---|
| Ownership | Employee keeps it | Passes to Cirqle on the handover date | Cirqle |
| Agreement needed | None for reimbursement (an approved device policy is still required, D11). For the capital route: a documented **device-investment agreement** and your explicit approval [Confirmed D10] | **Device-investment agreement**: device identity, approved value, effective date, exit/buy-back terms, signed document | Assignment record |
| Value basis | Usage value for a stated window | Transfer value on the handover date | None |
| What Cirqle owes | The confirmed usage value | Capital equal to the approved value (or cash, if Cirqle buys instead) | Nothing |
| Profit effect | Usage cost **recognised once, when the valuation is confirmed**, in the profit period containing the confirmation date [Confirmed D14]; draft, calculated and reviewed valuations have no accounting effect | **None.** Cirqle receives an asset for capital; the cash-basis books don't depreciate it, so it's never an expense. **If bought for cash instead:** an operating payment when paid ("Equipment & Devices", `opex.equipment` [Verified seed]) | None |
| Settlement | Paid in cash, or reinvested as capital (approved agreement required, D10), or waived. Never both cash and capital for the same amount | Capital movement (`device_contribution`), recorded once | — |
| Capital-days | Only after the agreement is approved: from the reinvestment date | From the effective date (§7.4); weight relative to cash capital per agreement [Recommended D12: equal] | — |
| Exit | Device stays with the employee; an unpaid usage settlement stays payable; usage capital follows the agreement's exit terms [D12, agreement term] | Device stays with Cirqle; capital repaid per the agreement [D12, agreement term]. A buy-back (the employee takes the device at its then-current value, set off against the repayment) applies only if the agreement records it [D12, agreement term] | Device returned; if not returned, its current value is recorded as owed (credit ledger, outside this module), never through payroll |
| Disposal / depreciation | n/a | Disposal by Cirqle doesn't change capital. Whether device capital stays fixed at the approved value or changes as the device ages is an agreement term [Recommended D12: keep it fixed] | Asset register only |
| Payslip | Never | Never | Never |

### 9.2 Is case A's capital route "double counting"? [Confirmed D10]

Device usage value never becomes capital automatically. It needs a documented device-investment agreement and your explicit approval before any capital-days include it.

When a case-A usage value is **reinvested**, Cirqle has consumed a service worth the usage value (a cost) and the employee's claim becomes capital instead of cash. Two treatments:

- **Recommended: cost once + capital.** The usage cost hits profit once (at confirmation), and the capital is how it's settled. This is the same as reinvesting pay or a profit share, and it treats reinvesting and reimbursed employees alike. It isn't double counting: one cost, one claim.
- **Alternative: capital only, no cost.** Simpler, but profit is higher by the value of services consumed, and a reinvesting employee is treated better than a reimbursed one.

Either way, the **same rupee is never both paid in cash and credited as capital**. A database trigger caps Σ settlements at the confirmed amount.

### 9.3 Device workflow [Confirmed states]

**Draft → Calculated → Reviewed → Confirmed → Settled / Reinvested** (or Rejected / Waived).

- Recalculation is allowed until Confirmed.
- Reviewed requires a reason for any adjustment.
- Confirmed freezes the inputs and the policy version.
- **Nothing before Confirmed has any accounting effect:** no expense, no capital, no Cash Book entry, no payslip line.

### 9.4 Recognition timing and the Cash Book [Confirmed D14]

**Rule:**

- A case-A usage cost is recognised **once**, in the profit period that contains the date the valuation is **confirmed**.
- Draft, calculated and reviewed valuations are never recognised.
- The later cash payment is a Cash Book outflow **linked** to its settlement, and the engine **skips** it in class 8, the same way salary payments are skipped.
- A case-B **purchase** is not pre-recognised; its outflow counts as class 8 when paid.

**Worked example** (illustrative; needs an approved device policy first, D11). Laptop A (§8.4), usage window Apr–Sep, value ₹2,685.25. The Apr–Sep profit period was confirmed and frozen on 15 Oct; the next profit periods are Oct–Dec and Jan–Mar.

| Date | Event | Valuation status | Profit effect | Cash | Device settlement owed |
|---|---|---|---|---|---|
| 3 Oct | Calculated | Calculated | none | 0 | 0 |
| 5 Nov | Reviewed, no adjustment | Reviewed | none | 0 | 0 |
| 12 Nov | **Confirmed** | Confirmed | **−2,685.25 in the Oct–Dec period** (the period containing 12 Nov), not Apr–Sep | 0 | 2,685.25 (reduces free cash at 31 Dec) |
| 20 Jan | Paid by Cash Book outflow, linked to the settlement | Settled | **none** (outflow skipped in Jan–Mar class 8) | −2,685.25 | 0 |
| **Total** | | | **−2,685.25 once** | **−2,685.25** | |

If the employee instead reinvests on 20 Jan under an approved written device-investment agreement (D10):

- The settlement becomes capital of ₹2,685.25, effective 20 Jan.
- There's no cash and no further cost.
- The Oct–Dec cost stays as recognised.

The same amount can never be both paid and credited as capital: Σ settlements ≤ ₹2,685.25, enforced by a database trigger.

---

## 10. Business Reserve, cash availability and settlements

### 10.1 What the reserve is [Confirmed D9]

| Rule | Detail |
|---|---|
| **Nature** | An **internal accounting earmark** of retained profit: a running reserve balance (allocations from confirmed runs ± recorded releases/uses). It's part of retained profit, not distributable profit |
| **Cash** | It **creates no cash** and **requires no transfer** to another bank account |
| **Allocation** | Pool = 50% of eligible profit; within it, 50% Capital Share and 50% Business Reserve, both configurable by an authorised Admin and always totalling exactly 100% |
| **Losses and payouts** | In this design the reserve **may not** absorb accumulated losses and **may not** fund profit-share payouts |
| **Release / use** | Only with a **recorded reason and Admin approval**; logged in `reserve_movements` and `events` |
| **Free cash** | The earmark balance is deducted **once** in "cash available after reserve" (§10.3) |
| **Future separate account** (not in this design) | If a later policy moves reserve money to its own account, that account is excluded from free cash and the earmark is **not** deducted again, so it's never subtracted twice |

An earmark never creates cash. "Cash available after reserve" can be lower than the Capital Share, which is why §10.3 checks it.

### 10.2 Reserve ledger example

| Event | Reserve balance |
|---|---|
| Opening | 0 |
| Apr–Sep confirmed: allocation 25,000 | 25,000 |
| Nov: release 8,000 for a laptop purchase (reason, approval) | 17,000 |

### 10.3 Cash available for payment (end of the §3.5 period)

| Line | ₹ |
|---|---|
| Closing cash (Cash Book, incl. opening balances) | 3,40,000 |
| − Unpaid payroll | − 60,000 |
| − Client funds held | − 20,000 |
| − Pending entitlements from earlier periods | 0 |
| − Confirmed, unpaid device settlements | 0 |
| − GST liability | pending D1 |
| (not deducted) payroll `other_deductions` of unconfirmed meaning | flagged, D17 |
| **= Free cash** | **2,60,000** |
| − Reserve earmark balance (earmark option only) | − 25,000 |
| **= Cash available for payment** | **2,35,000** |

- The pass-through receivable (₹10,000) is money owed to Cirqle, **not** cash, so it isn't added.
- The Capital Share (₹25,000) is ≤ ₹2,35,000 ✓.
- **[Confirmed D13]** If the Capital Share exceeds cash available after liabilities, pending obligations and the reserve earmark, the screen shows a clear warning. Confirmation is permitted only after the authorised Admin records a written acknowledgement, which is stored on the run and in `events`.
- **Confirmation is not payment.** Every settlement re-checks cash available at that moment and shows the same warning before anything is paid.

### 10.4 Settlement rules [Recommended]

Pending = entitlement (or confirmed device value) − Σ settlements. Settlement kinds:

| Kind | Effect | Rules |
|---|---|---|
| **Paid** | Cash Book outflow, linked one-to-one; full or partial | "Profit Share Payout" category [Confirmed D8], neutral description (§12) |
| **Reinvested** | Capital movement in the same transaction | Device capital needs an agreement in force |
| **Waived** | No effect beyond closing the amount | `profit_sharing.approve` permission + reason |
| **Advance offset** | Reduces a reviewed advance balance | ≤ the lesser of the pending amount and the advance left |

Safeguards:

- A trigger locks the parent row and refuses Σ settlements > amount.
- Each kind's writes happen in **one database function**, so a payment can't exist without its Cash Book link, or a reinvestment without its capital row.

---

## 11. Cash reconciliation and confirmation gates

### 11.1 Checks

| # | Check | Source | Result |
|---|---|---|---|
| 1 | Cash bridge balances to the paisa (opening + movements = closing, per account) | `bank_accounts.opening_balance` + live entries | **Block** (a mismatch means an engine bug) |
| 2 | **Bank reconciliation:** for each account with `reconcile_from` set, a closed `bank_statements` row covers the period end; statement closing balance = Cash Book balance at that date (± ₹1); no `unmatched` lines dated in the period | `bank_statements`, `bank_statement_lines` [Verified tables, applied 2026-09-22] | **[Confirmed D6]** **Block** for accounts under reconciliation if reconciliation is incomplete or has unmatched items in the period; **Warn** for accounts not under reconciliation (e.g. cash in hand), which are never shown as reconciled |
| 3 | Unexplained difference (statement vs Cash Book) | as above | **Block** above the documented tolerance [Confirmed D6]. Proposed tolerance ₹1.00 [Recommended], stored in the settings version and shown on the check |
| 4 | Unclassified lines (no category, or a category with no section) | Cash Book | **Block** |
| 5 | Review queue empty for the period: unidentified receipts, chargebacks, orphan transfers, salary without payroll, unlinked conversions/deductions, unreviewed withdrawals, invoices that fail composition, tax-bearing invoices (while D1 is open) | module review table | **Block** (unallocated salary payments and advance/conversion conflicts: [Confirmed D5]) |
| 6 | Payroll: a row for every active employee and month (or an explicit "no pay"); months finalized (`isMonthFinalized`: paid payroll or `period_locks`) so payroll writers are frozen | `payroll`, `period_locks` [Verified] | **Block**. Stored net ≠ computed net → **Warn** |
| 7 | Payroll liability | §6 | Shown; feeds free cash |
| 8 | Client funds held; pass-through receivable aged > 90 days; ad platform prepaid aged > 60 days | §4 | **Warn**. Unassigned ad funding is always listed for review. Older than the 60-day initial threshold [Confirmed D4]: **Block** until shared to a wallet or written off by review |
| 9 | GST liability | §5 | Pending D1 |
| 10 | Pending entitlements; confirmed unpaid device settlements | module | Shown; feeds free cash |
| 11 | Capital Share ≤ cash available | §10.3 | **Warn + written acknowledgement** [Confirmed D13]; rechecked before each settlement |
| 12 | Period is whole months, starts the day after the last confirmed period ends, and is confirmed in order | runs | **Block** |
| 13 | Calculation is fresh (fingerprint of every input row = live data) | module | **Block** (recalculate) |
| 14 | Approved device policy version exists (needed before any device valuation can be confirmed) | module | **Block** (D11) |
| 15 | Scheme start month and opening accumulated loss recorded (before the first period) | settings | **Block** [Open D7] |
| 16 | Payroll `other_deductions` > 0 in the period | `payroll` | **Warn**, listing rows and amounts, "treatment unconfirmed" [Open D17] |

**A balanced Cash Book is not proof the bank is right.** Check 1 proves the arithmetic; checks 2–3 compare with the bank.

### 11.2 Immutability and drift [Confirmed requirements 15–16; Recommended mechanics]

- At confirmation, every input row is copied into `run_inputs`: source table and id, class, amount, category, links, and the classification used. A SHA-256 fingerprint of that list is stored.
- Confirmed runs, their inputs and entitlements can't be updated (database trigger). The one transition allowed is **void**, only while no settlement exists, with a reason.
- **Drift:** every time a confirmed run is opened, and on demand, the engine recomputes from live data. If anything changed (a Cash Book edit, a soft delete of a linked entry, a payroll change), it shows "books changed since confirmation by ₹X" with the rows. The confirmed figures never move.
- A correction is a documented **prior-period adjustment** line in the next run (amount, reason, link to the drift report, approver).

**Who confirms [Confirmed D16, initial release].** One authorised Admin may review and confirm a period. Each step records the actor and timestamp on the run (`reviewed_by/at`, `confirmed_by/at`) and writes an audit event. A second-approver step could be added later without changing the data model.

---

## 12. Security and privacy review

| Surface | Verified state | Risk to profit sharing | Design response |
|---|---|---|---|
| Route middleware | `ROUTE_PERMS` regex list in `src/lib/supabase/middleware.ts` [Verified]; `/dashboard/finance/months` has **no** entry and relies on its page check [Verified] | A page that forgets its check would be open | Explicit `^/dashboard/finance/profit-sharing` entry **and** checks on every page |
| Server pages and actions | `loadCurrentUser` + `hasPermission`; actions use `requirePermission` [Verified] | — | Every page and action: permission **and** `isAdmin` in this release; amounts recomputed on the server |
| New tables | Supabase grants new tables to `anon`/`authenticated` by default [Unverified for this project, Q15] | Direct PostgREST reads | RLS on, `REVOKE ALL FROM anon, authenticated`, no policies → service role only; verified after applying with `has_table_privilege` |
| **Cash Book rows** | `cashbook_entries` keeps an `authenticated` grant; row policy is `cashbook.view` in repo [Verified] / production policies [Unverified, Q3]. Global search returns Cash Book entries to `cashbook.view` holders [Verified]. Amounts are gated by `cashbook.view_amounts` in the UI [Verified key] | **Payouts, capital and device payments written to the Cash Book are visible to every `cashbook.view` holder**: in the list, in search, and directly through PostgREST | **Policy [Confirmed D15]:** only Admins hold `cashbook.view` in this release. **Current assignments are [Unverified].** A read-only review (Q4) is a **prerequisite before implementation**. If any non-admin holds it, that's flagged as a separate prerequisite needing your authorisation and its own change; this project doesn't change permissions. In every case: neutral descriptions ("Profit share payout — PS-2026-04"), no investor names, amounts or profit-sharing details in text, reference `profit_share:<id>`, and no `employee_id` on the entry, so it is never offered for payslip allocation |
| `cashbook_audit_log` | Exists (`phase2_audit_log.sql`) [Verified]; who reads it [Unverified] | Payout edits recorded there | Same as above |
| Activity feed | `logActivity` → `activity_logs`, page gated by `timeline.view_all` [Verified] | Leak if the module logged there | The module **never** calls `logActivity`; its audit lives in its own `events` table |
| Notifications, dashboard tiles, command palette | Palette search is server-side and permission-gated [Verified]; dashboard inflow/outflow aggregates include all Cash Book lines [Unverified exact] | Aggregates include payouts (not attributable) | No notifications, tiles or palette entries from the module |
| Payroll and payslips | Payslip built from payroll rows [Verified] | — | The module never writes payroll |
| Identifiers | Employees by CQID (lint + build gate) [Verified]; external investors have no employee row | An external investor's name is personal data | Stored only in the module (admin-only); never written to the Cash Book |
| `credit_ledger` | Embeds `employees(cqid)`; readable by `payroll.view` holders [Verified pages] | Reviews and advance links must not be written there | The module reads it, never writes |

**Must be verified before implementation (read-only, Appendix A):**

- production policies on `cashbook_entries` (Q3)
- which designations hold `cashbook.view`, `cashbook.view_amounts`, `timeline.view_all`, and which are `is_admin` (Q4)
- default privileges on new tables (Q15)

---

## 13. Database structure and integration points

### 13.1 Do we need new tables? Reuse analysis [Verified]

| Need | Existing candidate | Reuse? | Why |
|---|---|---|---|
| Investors | `employees`, `business_partners` | Partly: link employees | External investors have no employee row; `business_partners` are commission intermediaries who own clients (nav comment, `nav-sections.ts`) |
| Profit-share entitlements | `ownership_programs`/`awards` | **No** | Awards flow into `payroll.ownership_earned` and onto payslips; you require profit share to stay off payroll |
| Advances | `credit_ledger` | Read only | It's readable by payroll users; profit-share advances are admin-only |
| Audit | `activity_logs`, `cashbook_audit_log` | **No** | Readable by non-admins |
| Settings versioning | `overhead_allocation_policy` pattern | Pattern only | Same append-only, effective-from design |
| Freeze | `period_locks` | Read for the payroll gate | Doesn't freeze the Cash Book (F1) |
| Bank truth | `bank_statements` | Read | Reconciliation gate |

### 13.2 Proposed tables (15, all `profit_share_*`) [Recommended]

| Table | Purpose | Key constraints and triggers |
|---|---|---|
| `members` | Founder, employee and external investors; roles text[] (one or more) | `employee_id` unique, nullable; label required without an employee; **the only FK to `employees`** (ON DELETE RESTRICT) |
| `agreements` | Capital and device-investment agreements: terms, dates, document, approval | Device capital requires an approved agreement in force on the effective date; approval requires all five D12 terms (§7.4) |
| `capital` | Append-only capital movements | amount > 0; direction by kind; effective ≥ received; approved rows immutable; running balance ≥ 0 on every day; can't take effect inside a confirmed period |
| `settings` | Versioned distribution %; reconciliation tolerance; ad-funding ageing threshold (60 days initially, D4); device policy with its own approval flag (D11). As built, the D7 inputs live on the first period: its start month is the scheme start, and its opening accumulated loss is entered on it and required before it can be confirmed | CHECK capital + reserve = 100.00 (server validates the same); 0–100; effective from the first of a month (several versions may share a month; the newest wins); append-only; device policy can't be marked approved without an approver and date |
| `runs` | One per period | whole months; `EXCLUDE USING gist (daterange(start,end,'[]') WITH &&) WHERE status='confirmed'` (range type only, no extension needed); immutable once confirmed except void-without-settlements |
| `run_inputs` | Frozen inputs per run (source, class, amount, links) | immutable; feeds drift detection |
| `entitlements` | Per member per run | unique (run, member); immutable |
| `settlements` | Paid / reinvested / waived / advance offset, against an entitlement **or** a device valuation | XOR parent; Σ ≤ amount (locking trigger); waived needs a reason |
| `reviews` | Classification overlay for any source row (withdrawals, unidentified receipts, salary w/o payroll, deduction links, conversions, chargebacks, invoice splits, unassigned ad funding) | unique (source_table, source_id); locked once consumed |
| `cash_links` | Every Cash Book entry the module uses as a payment or receipt | **PK = `cashbook_entry_id`**, so one entry backs exactly one module record across all tables; the **only FK to `cashbook_entries`** (ON DELETE RESTRICT; soft deletes surface as drift) |
| `reserve_movements` | Allocation (by confirm only), use, release, reversal | reason required for use/release |
| `devices` | Register: holder, ownership, specs, dates, price (+ estimated flag), condition, documents | company-owned or transferred → no usage valuation |
| `device_events` | Repairs, maintenance, condition changes, assignment, return, transfer | paid_by required on repairs |
| `device_valuations` | Usage or transfer valuations with frozen policy + evidence | no overlapping confirmed usage windows per device (trigger); adjusted ≠ proposed needs a reason |
| `events` | Audit history | append-only (trigger refuses UPDATE/DELETE) |

**Relationship rules [Recommended, from the 16 Oct PGRST201 incident]:**

- One FK from the module to `employees` (on `members`), and one to `cashbook_entries` (on `cash_links`).
- Actor columns (`created_by`, `approved_by` …) are plain uuids with no FK.
- No table has two FKs to the same table.
- `reviews.source_id` is polymorphic (no FK), so it creates no PostgREST relationship.
- Every embed uses an explicit `!column` hint.

**Data retention and correction:** nothing confirmed is ever deleted. Drafts can be discarded. Corrections are new rows (capital correction, prior-period adjustment, settlement reversal) with a reason and an event.

### 13.3 Integration points

| Direction | What |
|---|---|
| **Reads** | `cashbook_entries` (+ `reversal_of` when present), `cashbook_categories`, `cashbook_invoice_allocations`, `invoices`, `invoice_items`, `invoice_expense_items`, `invoice_ad_spend_items`, `ad_wallet_ledger`, `payroll`, `cashbook_payroll_allocations`, `credit_ledger`, `salary_advances` (history), `period_locks`, `bank_accounts`, `bank_statements`/`_lines`, `employees` (cqid, joined_date, archived_at), `tasks`, `services`, `service_categories`, `contribution_scores`, `task_assignments`, `activity_logs`, `native_push_tokens` |
| **Writes** | Only `profit_share_*` tables, plus Cash Book entries on explicit admin settlement or capital actions, through one database function each |
| **Not touched** | Contribution engine, ownership engine, `profit.ts`, `pnl.ts`, payroll, payslips, Cash Book screens and actions |

### 13.4 Source-code assumptions still to verify during implementation

1. How `cashbook_invoice_allocations` behaves when an invoice carries `previous_balance` [Unverified].
2. Whether a reversal must equal the original amount (one live reversal per entry is verified; partial refunds are [Unverified]).
3. The final shape of the Cash Book reversal work in the main checkout (uncommitted there; it changes `journal.ts` and `types.ts`). The engine must be built on what lands.
4. Whether discounts ever apply to pass-through lines [Unverified business rule].
5. The bad-debt date: `invoices.updated_at` is the only timestamp [Unverified as reliable].

---

### 13.5 Screens and navigation [Recommended]

One new Finance sidebar entry, "Profit Sharing", at `/dashboard/finance/profit-sharing`. It's gated by `profit_sharing.view` in the sidebar, the route middleware, every page and every action, and by `isAdmin` in this release.

| Section | Route | Contents |
|---|---|---|
| Overview | `/` | Setup checklist (D7, members, opening capital); cash profit by period; accumulated loss; eligible profit; pool → Capital Share / Reserve; reserve balance; total retained; cash available; pending settlements; open warnings |
| Investors & Capital | `/investors`, `/investors/[id]` | Members and roles; capital ledger with approvals; agreements; per-person statement; **review queues** (withdrawals, unidentified receipts, salary and advance links, invoice splits, unassigned ad funding) |
| Device Valuation | `/devices`, `/devices/[id]` | Register, events, valuations with formula and evidence; confirmation disabled until a device policy is approved (D11) |
| Distribution Settings | `/settings` | Settings versions (distribution %, tolerance, ageing threshold); device policy drafts and approval |
| Profit Periods | `/periods`, `/periods/[id]` | Runs and statuses; cash bridge, profit bridge, loss carry-forward, allocation, capital-days, gates checklist, acknowledgement, Confirm; drift report |
| Settlements | `/settlements` | Pending / paid / reinvested / waived / advance offset; cash check at payment |
| Audit History | `/history` | Every event; frozen inputs of each confirmed period |

Every figure opens a "how this was worked out" panel showing the formula with real numbers and links to the source rows. People appear by CQID; external investors by their label.

---

## 14. Edge cases and test plan

### 14.1 Edge cases (each becomes at least one test)

| Area | Cases |
|---|---|
| **Revenue** | Partial payments over several periods; allocation later than receipt; refund (reversal) of a mixed-composition receipt; chargeback without reversal; foreign-currency receipt (INR snapshot); allocation exceeding the entry; invoice with carried balance; invoice failing the composition check; bad debt with unrecovered pass-through; client overpayment left held |
| **Ad money** | Wallet funded but unused; company wallet; funding never shared; funding shared to two clients; client pays the platform directly |
| **Payroll** | All six §6.2 examples; deduction larger than pay (clamp); stored net ≠ computed; month without payroll; overpayment; adjustment for a confirmed month; ownership included once; `other_deductions` present (warning; expense stays G) |
| **Capital** | Same-day in and out; withdrawal below zero refused; late approval into a confirmed period; zero capital; exit mid-period; reinvestment; correction row; external investor; founder who is also an employee |
| **Losses and distribution** | Loss → loss → partial absorb → profit; exactly-zero result; settings change between periods; percentages with decimals; rounding to the paisa |
| **Settlements** | Partial pay; over-pay refused; reinvest creates capital atomically; waive without reason refused; advance offset larger than pending; duplicate Cash Book link refused |
| **Devices** | Examples A–D exactly; replacement-as-market refused; market > 1.5× model needs a reason; unknown price (estimated); past useful life; overlapping windows refused; usage after transfer refused; company-owned refused; employee-paid repair; verified override without evidence refused; confirm without approved policy refused; usage confirmed after its window's profit period was frozen (cost lands in the confirmation period, §9.4); capital route without an approved agreement refused |
| **Runs** | Overlap, gap, out-of-order refused; stale fingerprint refused; void with settlements refused; drift after a Cash Book edit and after a soft delete of a linked entry |
| **Reconciliation** | Bridge balances; unmatched statement line blocks; account without reconciliation warns; opening balances included |

### 14.2 Test plan

| Layer | Tests |
|---|---|
| **Pure engine** (`src/lib/profit-sharing/*.test.ts`, vitest; no database) | Every class rule in §3.3 with a fixture; §3.5 reproduced to the paisa (profit 1,20,000, bridge 3,40,000, reconciliation +2,00,000); §4.3 and the variants; §5 example behind a flag; §6.2 examples 1–6; §7.1 sequence; §7.2 table; §7.3 (22,715.99 / 2,284.01); §7.5 advance offset; §8.4 A–D; §10.3 |
| **Property tests** | Σ entitlements = Capital Share; offset + capital + reserve + outside = result for any result ≥ 0; every input row in exactly one class; the bridge always balances |
| **Decision rules** | D1: a tax-bearing invoice's collections go to review, with no tax computed. D2: pass-through → tax → own order, and an unsplittable allocation goes to review. D3: an unallocated client receipt is held, never revenue. D4: unassigned funding is listed, never profit or expense; older than 60 days blocks. D8: the five categories map to their classes. D10: capital route refused without an approved agreement. D5: gross from components; unallocated salary payment and conversion conflict block. D6: block vs warn by account; tolerance from settings. D7: no confirmation without start month and opening loss. D9: a reserve release needs reason + approval; earmark deducted once. D11: no device confirmation without an approved policy. D12: an agreement can't be approved without its five terms. D13: no confirmation without acknowledgement; settlement re-checks cash. D14: cost lands in the confirmation period and the paid outflow is skipped. D16: review and confirm record actor, timestamp and an event. D17: O > 0 warns; expense stays G |
| **Database** (static SQL tests, like `rls-grants.test.ts`) | Migration contains RLS + REVOKE for all 15 tables; the CHECK for 100%; the EXCLUDE constraint; append-only and immutability triggers; exactly one FK to `employees` and one to `cashbook_entries` |
| **Server** | Every action refuses non-admins and missing permissions; the route gate covers every sub-route; server recomputes and ignores client figures |
| **Browser** (localhost uses the production database) | Every screen opened and read; **no form submitted, nothing saved** |
| **Gates** | `npm run typecheck`, `npm test`, `npm run lint` (cap 2128), name-privacy build gate |

---

## 15. Remaining blockers, build order and risks

### 15.1 Before implementation starts

1. **Your explicit final approval** of this design.
2. **D15 verification:** the read-only check of who holds `cashbook.view` (Appendix A, Q4). You can run it in the SQL editor, or authorise me to run it read-only. If any non-admin holds it, changing that is a separate task that needs your authorisation; this project doesn't change permissions.

Nothing else blocks building.

### 15.2 Open decisions that block using the profit engine (not building it)

| # | Until you answer |
|---|---|
| D7 | No profit period can be confirmed: the start month and opening accumulated loss are mandatory setup inputs |
| D1 | A period containing a tax-bearing invoice can't be confirmed, because those collections sit in review. Periods with no tax-bearing invoices are unaffected |
| D17 | Doesn't block. Periods with `other_deductions` show a warning, and free cash is overstated if those deductions turn out to be tax withheld |

### 15.3 Choices that can wait for the device or exit feature

| # | Needed before |
|---|---|
| D11 | The first device valuation is confirmed. Until then valuations are draft-only |
| D12 | The first non-founder investment, device-capital agreement or investor exit is approved. These terms are legally significant: explicit agreement and professional review required |

### 15.4 Build order

1. **Migration and rollback:** tables, constraints and triggers, RLS + REVOKE, permissions (Admin only), the five D8 categories (only if missing), settings version 1 (50/50/50, ₹1.00 tolerance, 60-day threshold). Handed to you to apply by hand, never applied by me.
2. **Pure engine with vitest tests:** classes, invoice composition, payroll and advances, loss carry-forward, distribution, capital-days, settlements, gates, drift fingerprint.
3. **Profit-sharing screens:** Overview, Investors & Capital with the review queues, Settings, Profit Periods, Settlements, Audit (§13.5).
4. **Device register and valuation screens:** confirmation stays disabled until D11.
5. **Checks:** typecheck, tests, lint (cap 2128), name-privacy gate, and a browser check of every screen **without saving anything**.

### 15.5 Risks that need business information, not design

1. **Legal and tax structure.** Capital from employees or outside investors, profit sharing with them, and device transfers can create partnership, loan or share arrangements, with legal and tax consequences that depend on Cirqle's legal form. The agreements here record terms; they don't make them valid. Have a chartered accountant or lawyer review them before the first non-founder investment is approved.
2. **GST/TDS status** (D1): until known, some collections can't be classified.
3. **Cash Book completeness before reconciliation started** (`reconcile_from`): profit for earlier months is only as good as those entries.
4. **Evidence** for the founder's original investment and the D7 opening loss.
5. **Informal client money** recorded under other categories, which only review can find.
6. **Current Cash Book access** (D15): if non-admins hold `cashbook.view`, they'd see payout and capital entries until that's changed.
7. **Production schema drift:** migrations are applied by hand and the generated types are stale (F9).

### 15.6 Approval gate

Approved for implementation on 2026-10-22. Migrations are handed to you to apply by hand; I never apply them.

---

## Appendix A — read-only verification queries (not run)

None of these has been executed. They are read-only suggestions: run them yourself in the Supabase SQL editor, or authorise me to run them read-only. Q4 is the D15 prerequisite. They return counts and configuration, not personal details.

| # | Purpose | Query |
|---|---|---|
| Q1 | Categories in use, with section and usage | `select c.name, c.type, c.statement_section, c.account_code, count(e.id) from cashbook_categories c left join cashbook_entries e on e.category_id=c.id and e.deleted_at is null group by 1,2,3,4 order by 5 desc;` |
| Q2 | Invoices carrying tax | `select count(*), sum(tax_amount) from invoices where coalesce(tax_amount,0) > 0;` |
| Q3 | Policies on Cash Book and payroll | `select tablename, policyname, roles, cmd, qual from pg_policies where tablename in ('cashbook_entries','payroll');` |
| Q4 | Who can see the Cash Book and the timeline | `select d.name, d.is_admin, p.key from designation_permissions dp join designations d on d.id=dp.designation_id join permissions p on p.id=dp.permission_id where dp.allowed and p.key in ('cashbook.view','cashbook.view_amounts','timeline.view_all');` |
| Q5 | Personal Withdrawals to review | `select date_trunc('year', entry_date), count(*), sum(amount_inr) from cashbook_entries e join cashbook_categories c on c.id=e.category_id where c.account_code='excluded.owner_drawings' and e.deleted_at is null group by 1;` |
| Q6 | Salary outflows with no payroll allocation | `select count(*), sum(e.amount_inr) from cashbook_entries e join cashbook_categories c on c.id=e.category_id where c.account_code='opex.salaries' and e.deleted_at is null and not exists (select 1 from cashbook_payroll_allocations a where a.cashbook_entry_id=e.id and a.deleted_at is null);` |
| Q7 | Advances deducted vs conversions | `select (select count(*) from payroll where coalesce(advances_deducted,0)>0), (select count(*) from credit_ledger where credit_type='converted_salary');` |
| Q8 | Revenue inflows with no invoice allocation | `select (e.client_id is null) as no_client, count(*), sum(e.amount_inr) from cashbook_entries e join cashbook_categories c on c.id=e.category_id where c.statement_section='revenue' and e.type='inflow' and e.deleted_at is null and not exists (select 1 from cashbook_invoice_allocations a where a.cashbook_entry_id=e.id and a.deleted_at is null) group by 1;` |
| Q9 | Ad funding not shared to any wallet | `select count(*), sum(e.amount_inr) from cashbook_entries e join cashbook_categories c on c.id=e.category_id where c.account_code='cogs.ad_spend' and e.deleted_at is null and not exists (select 1 from ad_wallet_ledger w where w.cashbook_entry_id=e.id and w.deleted_at is null);` |
| Q10 | Invoices with a carried balance | `select count(*) from invoices where coalesce(previous_balance,0) <> 0;` |
| Q11 | Legacy advances | `select status, count(*), sum(amount) from salary_advances group by 1;` |
| Q12 | Accounts under reconciliation and their latest closed statement | `select a.name, a.reconcile_from, max(s.period_end) filter (where s.status='closed') from bank_accounts a left join bank_statements s on s.bank_account_id=a.id group by 1,2;` (columns [Verified], `20260922100000`) |
| Q13 | Reversal column present | `select column_name from information_schema.columns where table_name='cashbook_entries' and column_name='reversal_of';` |
| Q14 | Ownership programs on the profit basis | `select count(*) from ownership_programs where basis='profit' and is_active;` |
| Q15 | Default privileges for new tables | `select grantee, privilege_type from information_schema.role_table_grants where table_name='cashbook_categories' and grantee in ('anon','authenticated');` (a proxy; re-check on the new tables after applying) |
