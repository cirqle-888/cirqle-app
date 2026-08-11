/**
 * READ-ONLY audit: manually linked tasks the money engine cannot see.
 *
 * Finds every task that has a client_agreement_tasks join row (the agreement
 * screen shows it as covered) but a NULL tasks.retainer_item_id (the money
 * engine treats it as uncovered → pool basis falls back to billing, which is
 * 0 for covered work → the team earned nothing).
 *
 * For each affected task it reports current vs corrected pool basis, an
 * ESTIMATED corrected team earning, and the payroll status of the task's
 * month — because a task in a paid/locked month must NOT be silently
 * restated by any backfill.
 *
 * This script never writes. Run:  node scripts/audit-manual-retainer-links.mjs
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', quiet: true })
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Same lineage/version rules as src/lib/agreements/manual-link.ts.
const sameLineage = (a, b) =>
  a.agreement_id === b.agreement_id
  && (a.service_id ?? null) === (b.service_id ?? null)
  && (a.commitment_type ?? null) === (b.commitment_type ?? null)
const appliesOn = (i, d) => i.effective_from <= d && (!i.effective_to || i.effective_to >= d)

const r2 = n => Math.round(n * 100) / 100

// ── Load everything read-only ────────────────────────────────────────────────
const { data: links } = await db.from('client_agreement_tasks').select('item_id, task_id')
const taskIds = [...new Set((links ?? []).map(l => l.task_id))]
if (taskIds.length === 0) { console.log('No manual links exist at all.'); process.exit(0) }

const { data: tasks } = await db.from('tasks')
  .select('id, task_number, title, status, task_date, billing_amount_inr, work_value_inr, retainer_item_id, bill_as_extra, quantity, deleted_at')
  .in('id', taskIds)

const itemIds = [...new Set((links ?? []).map(l => l.item_id))]
const { data: linkedItems } = await db.from('client_agreement_items')
  .select('id, agreement_id, service_id, commitment_type, effective_from, effective_to, work_unit_value, work_commission_pct, currency')
  .in('id', itemIds)
const agreementIds = [...new Set((linkedItems ?? []).map(i => i.agreement_id))]
const { data: allItems } = await db.from('client_agreement_items')
  .select('id, agreement_id, service_id, commitment_type, effective_from, effective_to, work_unit_value, work_commission_pct, currency')
  .in('agreement_id', agreementIds)
const { data: agreements } = await db.from('client_agreements')
  .select('id, agreement_number, status').in('id', agreementIds)

const { data: fx } = await db.from('exchange_rates').select('currency, rate_to_inr')
const rateToInr = c => (c === 'INR' || !c) ? 1 : (fx?.find(r => r.currency === c)?.rate_to_inr ?? null)

const { data: scores } = await db.from('contribution_scores')
  .select('task_id, employee_id, score_percentage, earnings_inr').in('task_id', taskIds)

const { data: payroll } = await db.from('payroll').select('month, year, status')
const { data: locks } = await db.from('period_locks').select('month, year')
const monthState = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  if ((locks ?? []).some(l => l.year === y && l.month === m)) return 'LOCKED'
  const rows = (payroll ?? []).filter(p => p.year === y && p.month === m)
  if (rows.length === 0) return 'open (no payroll yet)'
  if (rows.some(p => p.status === 'paid')) return 'PAID (partially or fully)'
  return 'open (pending payroll)'
}

// ── Analyse ──────────────────────────────────────────────────────────────────
const affected = []
for (const t of tasks ?? []) {
  if (t.deleted_at) continue
  if (t.retainer_item_id != null) continue          // engine already sees it

  const myLinks = (links ?? []).filter(l => l.task_id === t.id)
  const myItems = (linkedItems ?? []).filter(i => myLinks.some(l => l.item_id === i.id))
  if (myItems.length === 0) continue

  // Resolve the correct version: linked lineage's version in force at the
  // task date; else the lineage's current (open-ended) version.
  const clicked = myItems[0]
  const lineage = (allItems ?? []).filter(i => sameLineage(i, clicked))
  const dated = lineage.filter(i => appliesOn(i, t.task_date))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))
  const current = lineage.filter(i => !i.effective_to)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))
  const resolved = dated[0] ?? current[0] ?? clicked

  const agr = (agreements ?? []).find(a => a.id === resolved.agreement_id)
  const fxRate = rateToInr(resolved.currency)
  const unit = resolved.work_unit_value
  const correctedWorkValue = (unit != null && fxRate != null)
    ? r2(unit * (t.quantity ?? 1) * fxRate) : null

  const isExtra = !!t.bill_as_extra
  const currentBasis = isExtra ? (t.billing_amount_inr ?? 0)
    : (t.retainer_item_id ? (t.work_value_inr ?? 0) : (t.billing_amount_inr ?? 0))
  const correctedBasis = isExtra ? (t.billing_amount_inr ?? 0) : (correctedWorkValue ?? 0)

  const myScores = (scores ?? []).filter(s => s.task_id === t.id)
  const currentEarn = r2(myScores.reduce((s, x) => s + (x.earnings_inr ?? 0), 0))
  const poolPct = resolved.work_commission_pct ?? 50
  const shareSum = myScores.reduce((s, x) => s + (x.score_percentage ?? 0), 0) / 100
  // Estimate only — the real figure comes from recalcTaskCommissions, which
  // also applies tool deductions and ratings.
  const correctedEarnEst = r2(correctedBasis * (poolPct / 100) * Math.min(shareSum, 1))

  affected.push({
    task: `#${t.task_number} ${t.title}`,
    task_id: t.id,
    task_status: t.status,
    task_date: t.task_date,
    agreement: agr ? `${agr.agreement_number} (${agr.status})` : resolved.agreement_id,
    resolved_item: resolved.id,
    item_version: `${resolved.effective_from} → ${resolved.effective_to ?? 'current'}${resolved.effective_to == null ? ' (current)' : dated[0] ? ' (in force at task date)' : ' (fallback)'}`,
    work_unit: unit != null ? `${unit} ${resolved.currency}` : 'NOT SET',
    pool_pct: poolPct,
    current_work_value_inr: t.work_value_inr,
    current_billing_inr: t.billing_amount_inr,
    current_pool_basis: currentBasis,
    corrected_work_value_inr: correctedWorkValue,
    corrected_pool_basis: correctedBasis,
    current_team_earning: currentEarn,
    est_corrected_team_earning: correctedEarnEst,
    est_earning_delta: r2(correctedEarnEst - currentEarn),
    scored_by: myScores.length,
    payroll_month: t.task_date?.slice(0, 7),
    period_state: monthState(t.task_date?.slice(0, 7) ?? ''),
  })
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`Manually linked tasks invisible to the money engine: ${affected.length}\n`)
for (const a of affected) console.log(JSON.stringify(a, null, 1), '\n')

const open = affected.filter(a => a.period_state.startsWith('open'))
const closed = affected.filter(a => !a.period_state.startsWith('open'))
const totalDelta = r2(affected.reduce((s, a) => s + a.est_earning_delta, 0))
console.log('── Summary ──')
console.log(`affected tasks:            ${affected.length}`)
console.log(`in OPEN periods:           ${open.length}  (safe to backfill after approval)`)
console.log(`in PAID/LOCKED periods:    ${closed.length}  (flagged — must NOT be silently restated)`)
console.log(`est. total earning delta:  ₹${totalDelta.toLocaleString('en-IN')} (estimate; exact figure comes from the recalc engine)`)
