#!/usr/bin/env node
/**
 * READ-ONLY. Diffs live production against a baseline captured by
 * backfill-baseline.mjs and renders a PASS/FAIL verdict.
 *
 *   node scripts/backfill-verify.mjs backfill-baseline-<ts>.json
 *
 * INVARIANT checks must be identical. EXPECTED-DELTA checks must match the
 * predicted post-backfill value exactly — "close" is a failure, because the
 * only correct outcome is the one the dry run planned.
 *
 * Exit code 0 = all checks pass. 1 = at least one failure.
 * Makes no writes of any kind.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const baselinePath = process.argv[2]
if (!baselinePath) {
  console.error('usage: node scripts/backfill-verify.mjs <baseline.json>')
  process.exit(2)
}
const base = JSON.parse(readFileSync(baselinePath, 'utf8'))

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim()
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function all(table, select) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).order('id').range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return rows
}
const sum = (rows, col) => Number(rows.reduce((s, r) => s + (Number(r[col]) || 0), 0).toFixed(2))

// Plan the backfill committed to. Sourced from the dry run, not guessed.
const PLAN = { create: 5, deactivate: 625, reactivate: 0, preserved: 21 }

const csp = await all('client_service_pricing', 'id, client_id, service_id, price, commission_percentage, is_active')
const tasks = await all('tasks', 'id, client_id, service_id, billing_amount_inr')
const scores = await all('contribution_scores', 'id, earnings_inr')
const invoices = await all('invoices', 'id, total_amount').catch(() => [])
const quotations = await all('quotations', 'id, total_amount').catch(() => [])
const clients = new Set((await all('clients', 'id')).map(r => r.id))
const services = new Set((await all('services', 'id')).map(r => r.id))
const { count: requests } = await db.from('task_requests').select('*', { count: 'exact', head: true })
const audit = await all('service_scope_audit', 'id, action, client_id, service_id, source')

const pairs = new Set(csp.map(r => `${r.client_id}|${r.service_id}`))
const results = []
const check = (name, actual, expected, kind) =>
  results.push({ name, actual, expected, kind, pass: actual === expected })

// ── EXPECTED-DELTA ─────────────────────────────────────────────────────────
check('commitments total', csp.length, base.commitments_total + PLAN.create, 'delta')
check('commitments active', csp.filter(r => r.is_active !== false).length,
  base.commitments_total + PLAN.create - PLAN.deactivate, 'delta')
check('commitments inactive', csp.filter(r => r.is_active === false).length, PLAN.deactivate, 'delta')
check('audit rows written', audit.length, base.audit_rows + PLAN.create + PLAN.deactivate + PLAN.reactivate, 'delta')
check('audit: added', audit.filter(a => a.action === 'added' && a.source === 'backfill').length, PLAN.create, 'delta')
check('audit: deactivated', audit.filter(a => a.action === 'deactivated' && a.source === 'backfill').length, PLAN.deactivate, 'delta')

// ── INVARIANT: structure ───────────────────────────────────────────────────
check('duplicate pairs', csp.length - pairs.size, 0, 'invariant')
check('orphan client_ids', csp.filter(r => !clients.has(r.client_id)).length, 0, 'invariant')
check('orphan service_ids', csp.filter(r => !services.has(r.service_id)).length, 0, 'invariant')
check('null client/service', csp.filter(r => !r.client_id || !r.service_id).length, 0, 'invariant')

// ── INVARIANT: money ───────────────────────────────────────────────────────
check('contribution_scores count', scores.length, base.contribution_scores_count, 'invariant')
check('contribution_scores SUM', sum(scores, 'earnings_inr'), base.contribution_scores_sum, 'invariant')
check('tasks count', tasks.length, base.tasks_count, 'invariant')
check('tasks billing SUM', sum(tasks, 'billing_amount_inr'), base.tasks_billing_sum, 'invariant')
check('invoices count', invoices.length, base.invoices_count, 'invariant')
check('invoices SUM', sum(invoices, 'total_amount'), base.invoices_sum, 'invariant')
check('quotations count', quotations.length, base.quotations_count, 'invariant')
check('quotations SUM', sum(quotations, 'total_amount'), base.quotations_sum, 'invariant')
check('task_requests count', requests, base.task_requests_count, 'invariant')

// ── INVARIANT: agreed terms survive deactivation ───────────────────────────
// The 5 new rows carry price null / commission null, so both sums are
// unchanged. Any movement means the run overwrote agreed terms.
check('price SUM (terms preserved)', sum(csp, 'price'), base.price_sum, 'invariant')
check('commission SUM (terms preserved)', sum(csp, 'commission_percentage'), base.commission_sum, 'invariant')
check('rows with commission 0', csp.filter(r => Number(r.commission_percentage) === 0).length,
  base.rows_with_zero_commission, 'invariant')

// ── INVARIANT: no active pair carrying work was deactivated ────────────────
const usedPairs = new Set(tasks.map(t => `${t.client_id}|${t.service_id}`))
const deactivatedWithTasks = csp
  .filter(r => r.is_active === false && usedPairs.has(`${r.client_id}|${r.service_id}`))
check('deactivated pairs that have tasks', deactivatedWithTasks.length, 0, 'invariant')

// ── Per-row diff against the snapshot: only is_active may have moved ────────
const before = new Map((base.rows || []).map(r => [r.id, r]))
let termsChanged = 0
for (const r of csp) {
  const b = before.get(r.id)
  if (!b) continue                                    // one of the 5 new rows
  if (String(b.p) !== String(r.price) || String(b.cm) !== String(r.commission_percentage)) termsChanged++
}
check('pre-existing rows with changed price/commission', termsChanged, 0, 'invariant')

// ── Report ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.pass)
console.log('POST-DEPLOYMENT VERIFICATION (read-only)')
console.log('='.repeat(78))
for (const kind of ['delta', 'invariant']) {
  console.log(`\n${kind === 'delta' ? 'EXPECTED CHANGES' : 'MUST NOT HAVE CHANGED'}`)
  for (const r of results.filter(x => x.kind === kind)) {
    const mark = r.pass ? ' ok ' : 'FAIL'
    console.log(`  [${mark}] ${r.name.padEnd(42)} actual ${String(r.actual).padStart(12)}   expected ${r.expected}`)
  }
}
console.log(`\n${'='.repeat(78)}`)
if (failed.length === 0) {
  console.log(`ALL ${results.length} CHECKS PASSED — deployment verified.`)
  process.exit(0)
}
console.log(`${failed.length} of ${results.length} CHECKS FAILED:`)
for (const f of failed) console.log(`  · ${f.name}: got ${f.actual}, expected ${f.expected}`)
console.log('\nDo NOT proceed. See docs/BACKFILL_DEPLOYMENT.md section 3 (Rollback).')
process.exit(1)
