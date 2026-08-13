/** READ ONLY — impact of re-valuing Elara agreement item versions. */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', quiet: true })
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const AGR = '20f443d6-3e85-487b-9080-86101b58f4d3'
const TARGET = { 'Social Media Service': 300, 'Brand Identity Essentials': 2000 }

const { data: items } = await db.from('client_agreement_items')
  .select('id, invoice_label, effective_from, effective_to, work_unit_value, work_commission_pct')
  .eq('agreement_id', AGR).order('effective_from')

let changed = 0, frozenHits = 0
for (const it of items) {
  const target = TARGET[it.invoice_label]
  const { data: tasks } = await db.from('tasks')
    .select('id, task_number, title, task_date, quantity, work_value_inr')
    .eq('retainer_item_id', it.id).is('deleted_at', null).order('task_date')
  if (!tasks?.length && it.work_unit_value === target) continue

  const stale = it.work_unit_value !== target
  console.log(`\n${stale ? '⚠ ' : '  '}${it.invoice_label} [${it.id.slice(0,8)}] ${it.effective_from} → ${it.effective_to ?? 'current'}`)
  console.log(`   work value ${it.work_unit_value} ${stale ? `→ ${target}` : '(already correct)'}   commission_pct ${it.work_commission_pct ?? 'null → matrix/50'}`)
  if (!tasks?.length) { console.log('   tasks: none'); continue }
  for (const t of tasks) {
    const { data: frozen } = await db.rpc('is_task_date_payroll_finalized', { p_date: t.task_date })
    const next = Math.round(target * (t.quantity ?? 1) * 100) / 100
    if (frozen) frozenHits++
    else if (stale) changed++
    console.log(`   #${t.task_number} ${t.task_date} ${t.title.slice(0,28).padEnd(28)} ₹${t.work_value_inr} ${stale ? `→ ₹${next}` : ''} ${frozen ? '  ** FROZEN (paid/locked) — would NOT change **' : ''}`)
  }
}
console.log(`\nSUMMARY: ${changed} open task(s) would be re-stamped, ${frozenHits} frozen task(s) untouched.`)
console.log('NOTHING WAS WRITTEN.')
