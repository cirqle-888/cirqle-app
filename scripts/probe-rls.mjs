// RLS exposure probe — READ ONLY. No row data is retrieved or printed.
//
// Compares what the PUBLIC anon key can read against what the service role can
// read. RLS denies rows by returning an EMPTY SET, not an error, so "no error"
// does not mean "exposed" — the row counts are what matter.
//
//   service > 0, anon > 0   -> EXPOSED   (public key reads real rows)
//   service > 0, anon = 0   -> protected (policy is denying)
//   service = 0             -> empty     (table has no data; cannot tell)
//
// Usage: node scripts/probe-rls.mjs      (exit 0 = nothing exposed)
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = k => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim()

const url = get('NEXT_PUBLIC_SUPABASE_URL')
const anon = createClient(url, get('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
const svc  = createClient(url, get('SUPABASE_SERVICE_ROLE_KEY'))

const TABLES = [
  // secured by migration 006
  'employees', 'tasks', 'invoices', 'invoice_items', 'payments', 'cashbook_entries',
  'contributions', 'contribution_scores', 'payroll', 'salary_advances', 'credit_ledger',
  'notifications', 'performance_metrics', 'designations', 'designation_permissions',
  // secured by 20260718120000 (offer tables)
  'product_catalog', 'offer_campaigns',
  // still awaiting DB-01
  'clients', 'quotations', 'services', 'task_requests', 'intake_links', 'bank_accounts',
  'company_settings', 'provider_connections', 'client_agreements', 'ad_projects',
  'employee_commission_agreements', 'payslip_emails', 'discount_logs', 'client_service_pricing',
  'parameters', 'tools', 'exchange_rates', 'invoice_followups', 'request_activity',
  'client_product_catalog', 'system_jobs', 'cron_runs', 'activity_logs', 'audit_log',
]

async function count(client, table) {
  const { error, count } = await client.from(table).select('*', { count: 'exact', head: true })
  if (error) return { err: error.message.slice(0, 50) }
  return { n: count ?? 0 }
}

const exposed = [], guarded = [], empty = [], missing = []

for (const t of TABLES) {
  const s = await count(svc, t)
  if (s.err) { missing.push(t); continue }
  const a = await count(anon, t)
  if (s.n === 0) { empty.push({ t, anonOk: !a.err }); continue }
  if (!a.err && a.n > 0) exposed.push({ t, n: a.n })
  else guarded.push({ t, n: s.n })
}

const pad = s => s.padEnd(34)
console.log('\n=== RLS EXPOSURE — public anon key vs service role ===\n')

if (exposed.length) {
  console.log('EXPOSED — the public key reads real rows:')
  for (const { t, n } of exposed.sort((a, b) => b.n - a.n)) console.log(`   ${pad(t)} ${n} rows`)
} else {
  console.log('EXPOSED — none.')
}

console.log('\nPROTECTED — table has data, public key sees nothing:')
for (const { t, n } of guarded.sort((a, b) => b.n - a.n)) console.log(`   ${pad(t)} (${n} rows hidden)`)

if (empty.length) {
  console.log('\nEMPTY — no data, so exposure cannot be measured from counts:')
  console.log('   ' + empty.map(e => e.t).join(', '))
  const reachable = empty.filter(e => e.anonOk).map(e => e.t)
  if (reachable.length) console.log('   anon query still succeeds on: ' + reachable.join(', ') + ' — secure these anyway')
}
if (missing.length) console.log('\nNOT FOUND: ' + missing.join(', '))

console.log('\n=== VERDICT ===')
console.log(`   exposed: ${exposed.length}   protected: ${guarded.length}   empty/unknown: ${empty.length}`)
console.log(exposed.length === 0
  ? '   No table with data is readable by the public key.'
  : `   ${exposed.length} table(s) with real data are readable by anyone holding the public key.`)
console.log()
process.exit(exposed.length === 0 ? 0 : 1)
