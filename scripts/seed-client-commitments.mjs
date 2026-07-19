/**
 * Seed client→service commitments from REAL TASK HISTORY.
 *
 * Why not from the pricing rows: a row appears whenever someone types a price,
 * so the priced set is far broader than reality — 378 priced pairs vs 105
 * actually used, and 342 rows point at generic "Service at ₹X" buckets that
 * have never had a single task. Narrowing Sea Star to its 24 priced services
 * would not feel like narrowing at all; its 11 genuinely-used services do.
 *
 * What this does:
 *   • ACTIVE   = every (client, service) pair with at least one real task
 *   • KEEP     = pairs already priced AND used (nothing to change)
 *   • DEACTIVATE = priced but never used → is_active = false (price preserved)
 *   • CREATE   = used but never priced → new committed row, price NULL
 *   • SKIP     = generic "Service at ₹X" buckets, always
 *
 * Deactivation is reversible from the client edit modal, and every change is
 * written to service_scope_audit with source='backfill'.
 *
 * Usage:
 *   node scripts/seed-client-commitments.mjs           # dry run — prints the plan
 *   node scripts/seed-client-commitments.mjs --apply   # writes
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const APPLY = process.argv.includes('--apply')

const env = readFileSync('.env.local', 'utf8')
const get = k => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim()
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

const GENERIC = /^\s*service at\b/i

async function fetchAll(table, select, tweak = q => q) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(db.from(table).select(select)).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return rows
}

const [clients, services, pricing, tasks] = await Promise.all([
  fetchAll('clients', 'id, name, is_active'),
  fetchAll('services', 'id, name, is_active'),
  fetchAll('client_service_pricing', 'id, client_id, service_id, price, is_active'),
  fetchAll('tasks', 'client_id, service_id', q => q.is('deleted_at', null)),
])

const clientName = new Map(clients.map(c => [c.id, c.name]))
const serviceName = new Map(services.map(s => [s.id, s.name]))
const genericIds = new Set(services.filter(s => GENERIC.test(s.name)).map(s => s.id))

// (client, service) pairs backed by real work
const used = new Set()
for (const t of tasks) {
  if (!t.client_id || !t.service_id) continue
  if (genericIds.has(t.service_id)) continue
  used.add(`${t.client_id}|${t.service_id}`)
}

const priced = new Map()                       // key → row
for (const p of pricing) {
  if (!p.client_id || !p.service_id) continue
  priced.set(`${p.client_id}|${p.service_id}`, p)
}

const toDeactivate = []   // priced, active, never used
const toCreate = []       // used, no row at all
const toReactivate = []   // used, but row currently inactive
let keep = 0

for (const [key, row] of priced) {
  const isUsed = used.has(key)
  const isGeneric = genericIds.has(row.service_id)
  if (isUsed && row.is_active !== false) { keep++; continue }
  if (isUsed && row.is_active === false) { toReactivate.push(row); continue }
  if (row.is_active !== false) toDeactivate.push({ ...row, generic: isGeneric })
}
for (const key of used) {
  if (priced.has(key)) continue
  const [client_id, service_id] = key.split('|')
  toCreate.push({ client_id, service_id })
}

// ── Report ───────────────────────────────────────────────────────────────────

const fmt = (c, s) => `${(clientName.get(c) || c).slice(0, 30).padEnd(30)} · ${serviceName.get(s) || s}`

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — commitment seeding from task history\n${'='.repeat(70)}`)
console.log(`already correct (priced + used) : ${keep}`)
console.log(`create   (used, never priced)   : ${toCreate.length}`)
console.log(`reactivate (used, was inactive) : ${toReactivate.length}`)
console.log(`deactivate (priced, never used) : ${toDeactivate.length}`
  + `  — of which generic buckets: ${toDeactivate.filter(r => r.generic).length}`)

if (toCreate.length) {
  console.log(`\n── CREATE ${'─'.repeat(56)}`)
  for (const r of toCreate) console.log('  + ' + fmt(r.client_id, r.service_id))
}
if (toReactivate.length) {
  console.log(`\n── REACTIVATE ${'─'.repeat(52)}`)
  for (const r of toReactivate) console.log('  ↑ ' + fmt(r.client_id, r.service_id))
}

console.log(`\n── RESULTING SERVICE COUNT PER CLIENT ${'─'.repeat(30)}`)
const after = new Map()
for (const key of used) {
  const [c] = key.split('|')
  after.set(c, (after.get(c) || 0) + 1)
}
const before = new Map()
for (const [key, row] of priced) {
  if (row.is_active === false) continue
  const [c] = key.split('|')
  before.set(c, (before.get(c) || 0) + 1)
}
for (const c of clients.filter(c => c.is_active !== false)) {
  const b = before.get(c.id) || 0, a = after.get(c.id) || 0
  if (b || a) console.log(`  ${c.name.slice(0, 34).padEnd(34)} ${String(b).padStart(3)} → ${String(a).padStart(3)}`
    + (a === 0 ? '   ⚠ no committed services — will show ALL (unconfigured fallback)' : ''))
}

if (!APPLY) {
  console.log(`\nNothing written. Re-run with --apply to commit these changes.\n`)
  process.exit(0)
}

// ── Apply ────────────────────────────────────────────────────────────────────

const audit = []
const now = new Date().toISOString()

if (toCreate.length) {
  const { error } = await db.from('client_service_pricing').insert(
    toCreate.map(r => ({ client_id: r.client_id, service_id: r.service_id, price: null, is_active: true })))
  if (error) { console.error('CREATE failed:', error.message); process.exit(1) }
  audit.push(...toCreate.map(r => ({
    scope_kind: 'client_service', action: 'added',
    client_id: r.client_id, service_id: r.service_id,
    old_value: null, new_value: { committed: true, via: 'task_history' },
    actor_id: null, source: 'backfill',
  })))
}

if (toReactivate.length) {
  const { error } = await db.from('client_service_pricing')
    .update({ is_active: true, deactivated_at: null, deactivated_by: null })
    .in('id', toReactivate.map(r => r.id))
  if (error) { console.error('REACTIVATE failed:', error.message); process.exit(1) }
  audit.push(...toReactivate.map(r => ({
    scope_kind: 'client_service', action: 'activated',
    client_id: r.client_id, service_id: r.service_id,
    old_value: { is_active: false }, new_value: { is_active: true, via: 'task_history' },
    actor_id: null, source: 'backfill',
  })))
}

if (toDeactivate.length) {
  const { error } = await db.from('client_service_pricing')
    .update({ is_active: false, deactivated_at: now })
    .in('id', toDeactivate.map(r => r.id))
  if (error) { console.error('DEACTIVATE failed:', error.message); process.exit(1) }
  audit.push(...toDeactivate.map(r => ({
    scope_kind: 'client_service', action: 'deactivated',
    client_id: r.client_id, service_id: r.service_id,
    old_value: { is_active: true, price: r.price },
    new_value: { is_active: false, reason: r.generic ? 'generic_bucket' : 'never_used' },
    actor_id: null, source: 'backfill',
  })))
}

for (let i = 0; i < audit.length; i += 500) {
  const { error } = await db.from('service_scope_audit').insert(audit.slice(i, i + 500))
  if (error) { console.warn('audit insert warning:', error.message); break }
}

console.log(`\nDone. ${toCreate.length} created, ${toReactivate.length} reactivated, `
  + `${toDeactivate.length} deactivated, ${audit.length} audit rows written.`)
console.log('Prices are preserved on every deactivated row — reversible from the client edit modal.\n')
