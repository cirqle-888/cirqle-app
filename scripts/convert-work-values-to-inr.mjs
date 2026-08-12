/**
 * Convert agreement-item work values from their billing currency to INR.
 *
 * Freezes team pay against FX drift: the rupee amount stays exactly what it is
 * worth today, then stops moving. Client billing (`currency`, `unit_price`,
 * `extra_unit_price`) is NOT touched — only what the team is paid from.
 *
 *   DRY RUN (default):  node scripts/convert-work-values-to-inr.mjs
 *   APPLY:              node scripts/convert-work-values-to-inr.mjs --apply
 *
 * Tasks are re-stamped through the DB's own restamp_agreement_item_work_values,
 * which skips paid/locked months — so historical payslips can never be
 * restated by this script.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', quiet: true })
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const APPLY = process.argv.includes('--apply')

const r2 = n => Math.round(n * 100) / 100
const inr = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })

const { data: fx } = await db.from('exchange_rates').select('currency, rate_to_inr')
const rate = c => (c === 'INR' || !c) ? 1 : (fx?.find(r => r.currency === c)?.rate_to_inr ?? null)

const { data: items } = await db
  .from('client_agreement_items')
  .select('id, agreement_id, currency, work_unit_currency, work_unit_value, effective_from, effective_to, invoice_label')
  .not('work_unit_value', 'is', null)
  .order('effective_from')

const { data: agreements } = await db
  .from('client_agreements')
  .select('id, agreement_number')
  .in('id', [...new Set((items ?? []).map(i => i.agreement_id))])
const agrNo = id => agreements?.find(a => a.id === id)?.agreement_number ?? id.slice(0, 8)

const targets = (items ?? []).filter(i => (i.work_unit_currency ?? i.currency) !== 'INR')

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — items with a work value: ${items?.length ?? 0}, needing conversion: ${targets.length}\n`)

let totalTasksRestamped = 0
for (const it of targets) {
  const from = it.work_unit_currency ?? it.currency
  const fxRate = rate(from)
  if (fxRate == null) { console.log(`SKIP ${agrNo(it.agreement_id)} — no FX rate for ${from}`); continue }
  const newValue = r2(it.work_unit_value * fxRate)

  // Tasks this item currently stamps, and whether their month is frozen.
  const { data: tasks } = await db
    .from('tasks')
    .select('id, task_number, task_date, work_value_inr, quantity')
    .eq('retainer_item_id', it.id).is('deleted_at', null)
  const states = []
  for (const t of tasks ?? []) {
    const { data: frozen } = await db.rpc('is_task_date_payroll_finalized', { p_date: t.task_date })
    states.push({ ...t, frozen })
  }
  const open = states.filter(s => !s.frozen)
  const frozen = states.filter(s => s.frozen)

  console.log(`${agrNo(it.agreement_id)} · ${it.invoice_label ?? '(item)'} · ${it.effective_from} → ${it.effective_to ?? 'current'}`)
  console.log(`   work value : ${from} ${it.work_unit_value}  →  INR ${newValue}   (rate ${fxRate})`)
  console.log(`   tasks      : ${states.length}  (${open.length} open → will re-stamp, ${frozen.length} frozen → untouched)`)
  for (const t of open) {
    const next = r2(newValue * (t.quantity ?? 1))
    console.log(`      #${t.task_number} ${t.task_date}  ${inr(t.work_value_inr ?? 0)} → ${inr(next)}`)
  }
  for (const t of frozen) {
    console.log(`      #${t.task_number} ${t.task_date}  ${inr(t.work_value_inr ?? 0)} — FROZEN (paid/locked), unchanged`)
  }

  if (APPLY) {
    const { error } = await db.from('client_agreement_items')
      .update({ work_unit_value: newValue, work_unit_currency: 'INR' })
      .eq('id', it.id)
    if (error) { console.log(`   ✗ item update failed: ${error.message}\n`); continue }
    const { data: n, error: rErr } = await db.rpc('restamp_agreement_item_work_values', { p_item_id: it.id })
    if (rErr) console.log(`   ✗ re-stamp failed: ${rErr.message}`)
    else { totalTasksRestamped += n ?? 0; console.log(`   ✓ converted; ${n ?? 0} task(s) re-stamped`) }
  }
  console.log('')
}

if (!APPLY) console.log('Nothing was written. Re-run with --apply to commit.')
else console.log(`Done. Items converted: ${targets.length}. Tasks re-stamped: ${totalTasksRestamped}.`)
