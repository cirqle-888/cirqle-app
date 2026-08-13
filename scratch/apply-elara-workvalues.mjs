/**
 * Set Elara (AGR-2607-062) agreement values to the owner-specified figures.
 *
 *   Social Media Service      → work value INR 300,  commission 75%
 *   Brand Identity Essentials → work value INR 2000, commission 100%
 *
 * Client billing is NOT touched: currency, unit_price (AED 400/mo and AED 150),
 * extra_unit_price, and the AED creative/management allocations that produce
 * the AED 20 per-unit figure all stay exactly as they are. This only changes
 * what the TEAM is paid from, and at what share.
 *
 *   DRY RUN:  node scratch/apply-elara-workvalues.mjs
 *   APPLY:    node scratch/apply-elara-workvalues.mjs --apply
 *
 * Re-stamping goes through the DB's restamp_agreement_item_work_values, which
 * skips paid/locked months, so a finalized payslip cannot be restated here.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', quiet: true })
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const APPLY = process.argv.includes('--apply')

const AGR = '20f443d6-3e85-487b-9080-86101b58f4d3'
const TARGET = {
  'Social Media Service':      { work_unit_value: 300,  work_commission_pct: 75 },
  'Brand Identity Essentials': { work_unit_value: 2000, work_commission_pct: 100 },
}

const { data: items, error: readErr } = await db.from('client_agreement_items')
  .select('id, invoice_label, effective_from, effective_to, work_unit_value, work_unit_currency, work_commission_pct')
  .eq('agreement_id', AGR).order('effective_from')
if (readErr) { console.error('read failed:', readErr.message); process.exit(1) }

const todo = items.filter(i => {
  const t = TARGET[i.invoice_label]
  if (!t) return false
  return i.work_unit_value !== t.work_unit_value
    || i.work_unit_currency !== 'INR'
    || i.work_commission_pct !== t.work_commission_pct
})

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${todo.length} of ${items.length} item version(s) to update\n`)
console.log('ROLLBACK (before values):')
todo.forEach(i => console.log(`  ${i.id}  value=${i.work_unit_value} ${i.work_unit_currency}  pct=${i.work_commission_pct}`))
console.log('')

let restamped = 0, failures = 0
for (const it of todo) {
  const t = TARGET[it.invoice_label]
  console.log(`${it.invoice_label} [${it.id.slice(0,8)}] ${it.effective_from} → ${it.effective_to ?? 'current'}`)
  console.log(`   value ${it.work_unit_value} → ${t.work_unit_value} INR   pct ${it.work_commission_pct} → ${t.work_commission_pct}`)
  if (!APPLY) continue
  const { error } = await db.from('client_agreement_items')
    .update({ ...t, work_unit_currency: 'INR' }).eq('id', it.id)
  if (error) { console.log(`   ✗ update failed: ${error.message}`); failures++; continue }
  const { data: n, error: rErr } = await db.rpc('restamp_agreement_item_work_values', { p_item_id: it.id })
  if (rErr) { console.log(`   ✗ re-stamp failed: ${rErr.message}`); failures++ }
  else { restamped += n ?? 0; console.log(`   ✓ ${n ?? 0} task(s) re-stamped`) }
}
console.log(APPLY
  ? `\nDone. Item versions updated: ${todo.length - failures}. Tasks re-stamped: ${restamped}. Failures: ${failures}.`
  : '\nNothing was written. Re-run with --apply.')
