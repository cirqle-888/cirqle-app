# Commitment Backfill — Production Deployment Runbook

**Change:** seed client→service commitments from operational evidence.
**Writes:** 5 INSERTs + 625 UPDATEs (`is_active=false`) in `client_service_pricing`, plus 630 append-only audit rows.
**Reversible:** yes, fully. See §3.
**Downtime:** none.

Verified at commit `932bb05`: tsc clean · 442/442 tests · build passes · **28/28 mutations caught, 0 survived** · two independent adversarial reviews.

---

## 0. What this actually does, in one paragraph

`client_service_pricing` currently holds 809 rows, but only **163 pairs have ever carried a task** — pricing is 5× broader than reality, and 342 rows point at six generic "Service at ₹X" buckets with zero tasks ever. The backfill marks the unused rows `is_active=false` so pickers stop offering services a client never buys, creates 5 rows for pairs that have real work but no row, and spares 21 rows that are a client's last commitment of an intake kind (deactivating those would break a live external portal). **Nothing is deleted. No money moves.**

---

## 1. Deployment checklist

### Preconditions

- [ ] On commit `932bb05` or later; working tree clean (`git status --porcelain`)
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` → 442/442
- [ ] `npm run build` succeeds
- [ ] `.env.local` present with `SUPABASE_SERVICE_ROLE_KEY` pointing at **production**
- [ ] No other operator is editing commitments (Settings, Pricing Matrix, Client edit, Import) for the duration — see §3 TOCTOU note
- [ ] You have Supabase SQL editor access (needed only for rollback)

### Required migrations

| Migration | Status | Required before backfill? |
|---|---|---|
| `20260720100000_service_scope_foundation.sql` | **APPLIED** (verified) | **Yes** — creates `service_scope_audit`, `deactivated_at/by`. Backfill fails without it. |
| `20260720110000_scope_audit_updated_action.sql` | Not applied | **No.** Adds the `'updated'` audit action. Backfill emits only `added`/`activated`/`deactivated`, all in the live CHECK. Apply **after**. |
| `20260721090000_commission_default_null.sql` | Not applied | **No.** Drops `DEFAULT 0` on `commission_percentage`. Unrelated to this run. Apply **after**. |

### Backup verification

- [ ] Confirm Supabase PITR (Point-in-Time Recovery) is enabled, or take a manual snapshot from the dashboard
- [ ] Note the snapshot timestamp — this is your last-resort recovery, below the row-level rollback in §3
- [ ] Run `node scripts/backfill-baseline.mjs` and **keep the JSON**. It contains a full 809-row snapshot, so a rollback can be reconstructed even if everything else is lost.

### Recovery file verification

The recovery file is written **by the backfill itself**, immediately before its first database write — it is not a separate prior step. After the run:

- [ ] `backfill-recovery-<timestamp>.json` exists in the repo root
- [ ] It contains `deactivateIds` (625), `reactivateIds` (0), `created` (5), `preserved` (21)
- [ ] Copy it somewhere outside the repo (it is gitignored and easy to lose)

If the script dies before writing this file, **nothing was written to the database** — the file precedes the first write.

### Environment verification

```bash
node -e "const {readFileSync}=require('fs');const e=readFileSync('.env.local','utf8');
console.log('URL:', e.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]);
console.log('service key present:', /SUPABASE_SERVICE_ROLE_KEY=.+/.test(e))"
```
- [ ] URL is the **production** project, not staging

### Database verification

- [ ] `node scripts/backfill-baseline.mjs` reports: 809 commitments · 0 duplicates · 0 orphans · 0 inactive · **163 pairs with a task** · 15 finalized payroll months

### User impact

| Who | What changes | When |
|---|---|---|
| Staff (task/request pickers) | Service dropdowns narrow to what each client actually buys | Next page load |
| External intake portals (`/intake`, `/start`) | Clients see only their committed services | Next page load |
| Finance / payroll | **Nothing.** No historical reader filters `is_active` | — |
| Employees | **Nothing.** Employee scoping is inert — `scope.*` granted to 0 designations | — |

**Most visible change:** Sea Star Tea Time 15→1 services, Malabar Supermarket 10→1, Hyper Happy Mart 14→2. This is the intended effect, but tell the team beforehand or you will get bug reports.

> ⚠️ The `scope_client_services` kill switch does **not** cover the external intake portals. Flipping it off does not undo the client-facing effect — only the §3 rollback does.

### Expected downtime

**None.** No schema change, no locks beyond per-row updates in 200-row batches.

### Rollback prerequisites

- [ ] Recovery file copied outside the repo
- [ ] Baseline JSON copied outside the repo
- [ ] Supabase SQL editor open and authenticated
- [ ] `node scripts/backfill-rollback-sql.mjs` verified to run (it only prints SQL)

---

## 2. Exact deployment order

| # | Step | Command | Why this step exists |
|---|---|---|---|
| 1 | Verify code state | `git status --porcelain && npx tsc --noEmit && npx vitest run && npm run build` | The backfill's safety properties are enforced by the test suite. A dirty tree means you are running something that was never reviewed. |
| 2 | Confirm migrations | See §1 table | `20260720100000` **must** be applied — the script writes to `service_scope_audit` and sets `deactivated_at`. Without it, every audit write fails and the run halts. |
| 3 | Take a backup | Supabase dashboard → snapshot / confirm PITR | Last-resort recovery beneath the row-level rollback. Cheap; take it. |
| 4 | Capture baseline | `node scripts/backfill-baseline.mjs` | Read-only. Produces the numbers §4 diffs against. **Without this you cannot prove nothing moved.** |
| 5 | Dry run | `node scripts/seed-client-commitments.mjs` | Recomputes the plan from live data. Read-only. |
| 6 | Compare to expected | See baseline below | If the plan differs, **stop** — the data changed since review and the analysis no longer applies. |
| 7 | Execute | `node scripts/seed-client-commitments.mjs --apply --yes` | The actual change. Writes the recovery file first, then creates, then deactivates. |
| 8 | Verify | `node scripts/backfill-verify.mjs backfill-baseline-<ts>.json` | 24 automated checks. Exit 0 = verified. |
| 9 | Apply deferred migrations | SQL editor: `20260720110000`, then `20260721090000` | Deliberately after: neither affects this run, and applying them first adds variables to a change you want isolated. |
| 10 | Clear caches | Nothing to do — see note | Every commitment surface is `export const dynamic = 'force-dynamic'`, and `loadServiceScope` reads fresh per request. The 30s `loadCurrentUser` cache holds permissions only, never commitments. **No cache action is required.** |
| 11 | Monitor | §5 | The failure modes that matter are user-visible, not log-visible. |
| 12 | Final verification | §4 + §6 | Sign-off. |

### Step 6 — expected dry-run baseline

```
evidence pairs found            : 168
  sources: task=167 offer=3 social=2 request=2 ad=1
already correct (keep)          : 163
create  (evidence, no row)      : 5
reactivate                      : 0
deactivate                      : 625  (generic buckets: 342)
PRESERVED by intake guardrail   : 21
clients losing an intake kind   : 0  ✅
```

**Any deviation = STOP.** In particular `clients losing an intake kind` must be exactly `0`; anything else means a live external portal is about to break.

### Step 7 — what you will see

The script is gated twice: `--apply` alone prints the plan and exits; only `--apply --yes` writes. During the run:

```
Recovery file written: backfill-recovery-<ts>.json   ← before ANY write
[1/3] creating 5…
[3/3] deactivating 625…
      deactivate chunk 1/4 (200) ok, 200 audited
      ...
```

It **halts** on: a create failure (before any deactivation), an audit-write failure, or a row-count mismatch between what it asked to change and what the database reported changing.

---

## 3. Rollback plan

### Generate the SQL

```bash
node scripts/backfill-rollback-sql.mjs backfill-recovery-<ts>.json > rollback.sql
less rollback.sql          # READ IT
# paste into Supabase SQL editor
```

The generator only prints. It never connects to a database.

### What it restores

| Item | How |
|---|---|
| **Commitments** | `UPDATE ... SET is_active=true, deactivated_at=NULL, deactivated_by=NULL` for the 625 ids |
| **Active/inactive status** | Same statement. Clearing `deactivated_at` matters — a live row with a stale removal stamp reads as pending-removal in every UI |
| **Created rows** | Set `is_active=false`. **Never DELETE** — the row carries the agreed price historical recompute reads |
| **Audit data** | **Cannot be un-written, by design.** `service_scope_audit` has a `BEFORE UPDATE OR DELETE` trigger that raises. The rollback appends `activated` rows instead. The trail reads forward: backfill, then rollback. This is correct behaviour, not a limitation to work around. |

### Recovery scenarios

| Scenario | State | Action | Time |
|---|---|---|---|
| **Dies before the recovery file** | Nothing written | None needed | 0 min |
| **Dies during creates** | 0–5 rows created, nothing deactivated. The script exits **before** deactivation by design | Re-run, or roll back the created rows | 2 min |
| **Dies during deactivation** | Some chunks applied, each fully audited before the next began | Run the rollback SQL — it is idempotent, and rows never reached are set to the state they already hold | 5 min |
| **Audit write failed** | Run halted at that chunk. Data changed, trail incomplete | Roll back. The recovery file is authoritative; the audit table is not | 5 min |
| **Row-count mismatch** | Run halted before auditing that chunk | Roll back and investigate — this means concurrent modification | 10 min |
| **Completed, but verification fails** | All 630 rows written | Roll back, then diagnose from the baseline diff | 10 min |
| **Everything is wrong** | — | Supabase PITR to the §1 snapshot | 30–60 min |

**Estimated full rollback: under 10 minutes**, dominated by reading the SQL before committing.

### After rolling back

```bash
node scripts/backfill-verify.mjs backfill-baseline-<ts>.json
```
Every **INVARIANT** check must pass. The **EXPECTED-DELTA** checks will fail — that is correct after a rollback; it means the changes are gone.

---

## 4. Post-deployment verification

```bash
node scripts/backfill-verify.mjs backfill-baseline-<ts>.json
```

24 checks, exit 0 = verified. It asserts:

**Expected changes**

| Check | Expected |
|---|---|
| commitments total | **814** (809 + 5) |
| commitments active | **189** (814 − 625) |
| commitments inactive | **625** |
| audit rows | **630** (5 added + 625 deactivated) |

**Must not have changed**

duplicates 0 · orphans 0 · `contribution_scores` 5213 rows / **₹318,818.36** · tasks 1849 / ₹671,069.79 · invoices 262 / ₹628,146.94 · quotations 0 · requests 13 · price SUM ₹179,505.86 · commission SUM 60,221 · rows with commission 0 = 2 · **deactivated pairs that have a task = 0** · pre-existing rows with changed price/commission = 0

### Read-only SQL (Supabase editor)

```sql
-- Row counts
SELECT is_active, count(*) FROM client_service_pricing GROUP BY is_active;
-- expect: true 189, false 625

-- Duplicates — must return zero rows
SELECT client_id, service_id, count(*) FROM client_service_pricing
GROUP BY client_id, service_id HAVING count(*) > 1;

-- Orphans — both must be 0
SELECT count(*) FROM client_service_pricing p
  LEFT JOIN clients c ON c.id = p.client_id WHERE c.id IS NULL;
SELECT count(*) FROM client_service_pricing p
  LEFT JOIN services s ON s.id = p.service_id WHERE s.id IS NULL;

-- No deactivated pair carries work — MUST be 0
SELECT count(*) FROM client_service_pricing p
 WHERE p.is_active = false
   AND EXISTS (SELECT 1 FROM tasks t
                WHERE t.client_id = p.client_id AND t.service_id = p.service_id);

-- Agreed terms survived deactivation — MUST be 0
SELECT count(*) FROM client_service_pricing
 WHERE is_active = false AND price IS NULL AND commission_percentage IS NULL
   AND id IN (/* paste deactivateIds */);

-- No live row carries a stale removal stamp — MUST be 0
SELECT count(*) FROM client_service_pricing
 WHERE is_active = true AND deactivated_at IS NOT NULL;

-- Audit trail
SELECT action, source, count(*) FROM service_scope_audit
GROUP BY action, source ORDER BY count(*) DESC;
-- expect: deactivated/backfill 625, added/backfill 5

-- Historical money — compare to baseline JSON
SELECT count(*), round(sum(earnings_inr)::numeric, 2) FROM contribution_scores;
-- expect: 5213, 318818.36

-- Payroll untouched
SELECT year, month, status, count(*) FROM payroll GROUP BY 1,2,3 ORDER BY 1 DESC, 2 DESC;
```

### Manual UI checks

- [ ] **Client portal** — open a live `/intake/<token>`; services narrow, list is **not empty**
- [ ] **Offer intake** — a client from the 21 preserved list still shows their offer service
- [ ] **Tasks** — pick Sea Star Supermarket; ~11 services, not 24
- [ ] **Tasks** — open an existing task on a now-deactivated pair; it still renders and **saves**
- [ ] **Pricing Matrix** — deactivated pairs still show their stored price
- [ ] **Payroll** — open a finalized month; totals match the baseline
- [ ] **Contribution Analysis** — spot-check a task on a deactivated pair; commission % is the stored rate, not 50%

---

## 5. Production monitoring — first 24 hours

### What to watch

| Signal | Where | Why it matters |
|---|---|---|
| Application errors | Vercel / server logs | Baseline first; only deltas matter |
| `[scope-audit]` errors | Server logs | Audit write failing — likely the unapplied `'updated'` migration |
| Missing commitments | Staff reports | A service that should be offered isn't |
| Empty pickers | Staff reports | Narrowed to zero — should be impossible, fallback shows everything |
| Portal dead ends | Client complaints | **Highest severity.** A client who cannot submit |
| Permission issues | Staff reports | Should be nil — `scope.*` granted to nobody |
| Payroll / commission anomalies | Finance | Should be nil — no historical reader filters `is_active` |
| Failed jobs | Cron / recalc | Watch the monthly payroll cron if it falls in-window |
| Performance | Page load | Pickers get *smaller*; expect neutral-to-faster |

### Checkpoints

**+15 minutes** — the blast radius is immediate, so most problems appear here.
- [ ] `backfill-verify.mjs` exits 0
- [ ] Open one external intake portal — loads, non-empty
- [ ] Open Tasks, pick a client — services narrowed, not empty
- [ ] Server logs: no new error class

**+1 hour**
- [ ] No staff reports of missing services
- [ ] Audit table still 630 rows (nothing writing unexpectedly)
- [ ] Spot-check 3 clients from the 21 preserved list — intake still works
- [ ] One task save on a deactivated pair succeeds

**+6 hours**
- [ ] Re-run `backfill-verify.mjs` — invariants still hold
- [ ] Review any new `client_service_pricing` rows created by staff: `SELECT * FROM client_service_pricing WHERE created_at > '<deploy time>'` — check none landed with `commission_percentage = 0` (the `DEFAULT 0` path; migration `20260721090000` closes it)
- [ ] No client-reported portal issues

**+24 hours**
- [ ] Re-run `backfill-verify.mjs` — **historical sums identical to baseline**
- [ ] Payroll/commission reports match pre-deploy figures
- [ ] Collect the list of services staff had to re-add — that is your commitment-drift signal
- [ ] Decide: keep, or roll back and re-scope the evidence rules

---

## 6. Success criteria

Objective, all machine-checkable except the last two:

- [ ] Script exits **0**, `problems` empty
- [ ] **5** commitments created
- [ ] **625** commitments deactivated
- [ ] **0** reactivated
- [ ] **21** preserved by the intake guardrail
- [ ] **630** audit rows, split 5 `added` / 625 `deactivated`
- [ ] Total rows **814**, active **189**, inactive **625**
- [ ] **0** duplicate pairs
- [ ] **0** orphan records
- [ ] `contribution_scores` count and SUM **identical** to baseline
- [ ] Invoice, quotation, task, request counts and SUMs **identical**
- [ ] Price SUM and commission SUM **identical** (terms preserved)
- [ ] **0** deactivated pairs carrying a task
- [ ] **0** live rows with a stale `deactivated_at`
- [ ] No payroll or commission figure differs from pre-deploy
- [ ] No client blocked from an intake portal
- [ ] No staff member blocked from creating legitimate work

**Any failure → roll back (§3). Do not diagnose forward on production.**

---

## 7. Executive summary

| | |
|---|---|
| **Deployment risk** | **Low** |
| **Confidence** | **88%** |
| **Downtime** | None |
| **Execution time** | 2–3 min (script), ~20 min including verification |
| **Rollback time** | Under 10 min |
| **Recommended window** | Low-traffic, with you present for the +15 min checkpoint. Avoid month-end payroll processing. A weekday morning beats a Friday evening — the risks here are user-visible, so you want staff around to report them. |

**Why Low risk.** The write is small (630 rows), fully reversible, touches no schema, and is provably money-safe: 163 pairs carry tasks and those are exactly the ones kept, so all 625 deactivations and 21 preservations have zero tasks. No historical reader filters `is_active`. Two independent reviewers reproduced the evidence math from scratch and agreed. 28/28 mutations are caught.

**Why not higher than 88%.** The final review round still found two real defects (unpaginated money reads ~190 rows from silent corruption; audit recording requested rather than changed rows). A review that finds defects tells you the floor of what remains unfound is not zero.

### Known limitations

- The `scope_client_services` kill switch does not cover external intake portals — only the rollback undoes the client-facing effect
- The script's "0 clients losing an intake kind" check is self-referential; it was verified independently, but the check itself does not constitute proof
- `--apply --yes` recomputes the plan rather than replaying the reviewed one (TOCTOU if someone edits commitments between dry run and execution)
- **Single-shot.** A second run would evaluate the 625 newly-inactive rows and could revive any that gained a task, overriding deliberate curation

### Remaining technical debt (independent of this deployment)

1. **Six browser-side `delete()+insert()` paths write `earnings_inr` unguarded** via the anon key — can rewrite a finalized payroll month. Needs a server-side write path. *Highest-value follow-up.*
2. **Anon key can read `contribution_scores`, `tasks`, `clients`** — live data exposure; RLS needs `TO authenticated`
3. `commission_percentage DEFAULT 0` — migration written, awaiting apply
4. `20260720110000` unapplied — UI repricing audit silently rejected until applied
5. Reactivation-by-history semantics need a guard before any re-run

### Final recommendation

**GO.**

Execute in this order: baseline → dry run → compare → apply → verify → deferred migrations. Do not skip the baseline; without it you cannot prove nothing moved, and that proof is the entire point of the verification step.
