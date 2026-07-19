#!/usr/bin/env node
/**
 * READ-ONLY. Captures the production baseline that the commitment backfill
 * must not disturb, and writes it to backfill-baseline-<timestamp>.json.
 *
 * Run this IMMEDIATELY BEFORE `--apply`, and again after via
 * backfill-verify.mjs, which diffs the two. Numbers that must be
 * byte-identical after the run are marked INVARIANT below; the few that are
 * expected to move are marked EXPECTED-DELTA with their predicted value.
 *
 * Makes no writes of any kind.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim()
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

/** Paginated read — PostgREST silently caps at 1000 rows. */
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

const csp = await all('client_service_pricing', 'id, client_id, service_id, price, commission_percentage, is_active')
const tasks = await all('tasks', 'id, client_id, service_id, billing_amount_inr')
const scores = await all('contribution_scores', 'id, earnings_inr')
const invoices = await all('invoices', 'id, total_amount').catch(() => [])
const quotations = await all('quotations', 'id, total_amount').catch(() => [])
const clients = new Set((await all('clients', 'id')).map(r => r.id))
const services = new Set((await all('services', 'id')).map(r => r.id))
const { data: payroll } = await db.from('payroll').select('month, year, status')
const { count: requests } = await db.from('task_requests').select('*', { count: 'exact', head: true })
const { count: auditRows } = await db.from('service_scope_audit').select('*', { count: 'exact', head: true })

const pairs = new Set(csp.map(r => `${r.client_id}|${r.service_id}`))
const usedPairs = new Set(tasks.map(t => `${t.client_id}|${t.service_id}`))

const baseline = {
  capturedAt: new Date().toISOString(),

  // ── EXPECTED-DELTA: the only rows the backfill touches ────────────────────
  commitments_total: csp.length,                                  // 809 -> 814
  commitments_active: csp.filter(r => r.is_active !== false).length,   // 809 -> 189
  commitments_inactive: csp.filter(r => r.is_active === false).length, // 0   -> 625
  audit_rows: auditRows,                                          // 0   -> 630

  // ── INVARIANT: must be byte-identical after the run ───────────────────────
  duplicate_pairs: csp.length - pairs.size,
  orphan_client_ids: csp.filter(r => !clients.has(r.client_id)).length,
  orphan_service_ids: csp.filter(r => !services.has(r.service_id)).length,
  null_client_or_service: csp.filter(r => !r.client_id || !r.service_id).length,

  // Money. Nothing the backfill does may move any of these.
  contribution_scores_count: scores.length,
  contribution_scores_sum: sum(scores, 'earnings_inr'),
  tasks_count: tasks.length,
  tasks_billing_sum: sum(tasks, 'billing_amount_inr'),
  invoices_count: invoices.length,
  invoices_sum: sum(invoices, 'total_amount'),
  quotations_count: quotations.length,
  quotations_sum: sum(quotations, 'total_amount'),
  task_requests_count: requests,

  // Prices and commissions are PRESERVED on deactivated rows — deactivation
  // sets is_active/deactivated_at only. A change here means the run destroyed
  // agreed terms.
  price_sum: sum(csp, 'price'),
  commission_sum: sum(csp, 'commission_percentage'),
  rows_with_null_price: csp.filter(r => r.price == null).length,
  rows_with_zero_commission: csp.filter(r => Number(r.commission_percentage) === 0).length,

  // Pairs carrying real work. The backfill keeps exactly these active.
  pairs_with_a_task: [...pairs].filter(k => usedPairs.has(k)).length,

  finalized_payroll_months: [...new Set((payroll || []).filter(p => p.status === 'paid').map(p => `${p.year}-${p.month}`))].length,

  // Full row snapshot so a rollback can be reconstructed even if the script's
  // own recovery file is lost.
  rows: csp.map(r => ({ id: r.id, c: r.client_id, s: r.service_id, p: r.price, cm: r.commission_percentage, a: r.is_active })),
}

const path = `backfill-baseline-${baseline.capturedAt.replace(/[:.]/g, '-')}.json`
writeFileSync(path, JSON.stringify(baseline, null, 2))

const { rows, ...summary } = baseline
console.log('BASELINE CAPTURED (read-only, nothing written to the database)')
console.log('='.repeat(72))
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(32)} ${v}`)
console.log(`\n  full row snapshot: ${rows.length} rows`)
console.log(`\nSaved: ${path}`)
console.log('KEEP THIS FILE. backfill-verify.mjs diffs against it.')
