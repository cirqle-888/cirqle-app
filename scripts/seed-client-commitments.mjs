/**
 * Seed client→service commitments from REAL OPERATIONAL EVIDENCE.
 *
 * WHY NOT FROM PRICING ROWS
 * A pricing row appears whenever someone types a price, so the priced set is
 * far broader than reality — 378 priced pairs vs ~105 actually used, and 342
 * rows point at generic "Service at ₹X" buckets that have never had a task.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVIDENCE RULES (a client is committed to a service if ANY holds)
 *   1. tasks            — a non-deleted task for (client, service). Any status:
 *                         a cancelled job still proves the service was sold.
 *   2. offer_campaigns  — an offer submission proves the offer-flyer service,
 *                         mapped ONLY to the canonical service (see below).
 *   3. social_calendar_items — a planned content item carrying a service_id.
 *   4. task_requests    — an intake request carrying a service_id.
 *   5. ad_projects      — an advertising campaign carrying a service_id.
 * Generic "Service at ₹X" placeholder services are excluded from evidence and
 * always deactivated: they are pricing scaffolding, not services.
 *
 * OFFER-CAMPAIGN MAPPING: offer_campaigns has no service_id, only an implied
 * link via services.intake_kind='offer_intake'. FIVE services carry that kind,
 * so fanning a campaign across all of them would FABRICATE commitments a client
 * never bought (e.g. crediting "Revised Offer Flyer" off a plain submission).
 * We therefore map to the single canonical service only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTAKE-PRESERVATION GUARDRAIL (safety, not evidence)
 * Never deactivate a client's LAST committed service of a given intake_kind.
 * Client capability (offer-intake screens, the Client Hub link) is derived from
 * the commitment predicate, so dropping the last one silently breaks a live
 * client's intake form — and 3 affected clients have NO operational record of
 * any kind, so no amount of evidence widening rescues them. Preserving is
 * reversible; breaking a client's link is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMMISSION ON NEW ROWS: written as explicit NULL, never omitted.
 * The column defaults to 0, and every reader guards with `?? 50` / `!= null` —
 * neither catches 0 — so a defaulted row would collapse that pair's historical
 * commission pool to zero. NULL is byte-identical to "no row" at every reader,
 * including the UI branches that literal 50 would trip (fabricating a
 * "pre-defined rate" nobody agreed).
 *
 * Deactivation NEVER deletes: price and commission are preserved, and the row
 * is reversible from the client edit modal.
 *
 * Usage:
 *   node scripts/seed-client-commitments.mjs           # dry run — prints the plan
 *   node scripts/seed-client-commitments.mjs --apply   # writes
 *   node scripts/seed-client-commitments.mjs --apply --yes   # skip confirmation
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'

const APPLY = process.argv.includes('--apply')
const SKIP_CONFIRM = process.argv.includes('--yes')
const CHUNK = 200            // .in() beyond ~400 ids exceeds the request header limit

const env = readFileSync('.env.local', 'utf8')
const get = k => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim()
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

const GENERIC = /^\s*service at\b/i
/** The one service an offer submission proves. Others sharing the intake kind
 *  are upsells that must be evidenced on their own. */
const CANONICAL_OFFER_SERVICE = /^\s*offer flyer\s*$/i

/** Stable-ordered pagination — an unordered range() scan can skip rows. */
async function fetchAll(table, select, tweak = q => q) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(db.from(table).select(select))
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return rows
}

/**
 * Read an evidence source that may not exist yet (pre-migration).
 *
 * A MISSING TABLE is tolerated; any other failure ABORTS. The distinction is
 * critical and was previously absent: a bare `catch { return [] }` turned a
 * transient 5xx, a renamed column or an RLS change into "this source proved
 * nothing", which silently moves every pair it would have evidenced from
 * `keep` into `toDeactivate`. A clean dry run could not warn about it either,
 * because --apply issues a fresh set of requests.
 */
async function tryFetch(table, select, tweak = q => q) {
  try {
    return await fetchAll(table, select, tweak)
  } catch (e) {
    const msg = String(e.message || e)
    // PostgREST 42P01 / PGRST205: relation genuinely absent.
    if (/does not exist|42P01|PGRST205|Could not find the table/i.test(msg)) {
      console.log(`  (evidence source ${table} not present — skipping)`)
      return []
    }
    console.error(`\n❌ evidence source ${table} FAILED to read: ${msg}`)
    console.error('   Refusing to continue: treating this as "no evidence" would')
    console.error('   deactivate commitments this source would have proven.')
    process.exit(1)
  }
}

/**
 * Run an update over ids in chunks; one failing chunk never aborts the rest.
 *
 * `auditFor(slice)` is invoked immediately after EACH successful chunk, not
 * after the loop. service_scope_audit is append-only by trigger, so a trail
 * lost to a crash between the last update and a deferred audit call can never
 * be reconstructed — the rows would be silently changed with no record.
 */
async function chunkedUpdate(table, ids, patch, label, auditFor) {
  let ok = 0, auditOk = 0, auditFailed = 0
  const failures = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const n = Math.floor(i / CHUNK) + 1
    const total = Math.ceil(ids.length / CHUNK)
    // .select('id') so the response carries the rows actually changed. Without
    // it PostgREST returns no count and `ok += slice.length` reports a success
    // it never verified — the run's own output could not evidence the change.
    const { data, error } = await db.from(table).update(patch).in('id', slice).select('id')
    if (error) {
      failures.push({ chunk: n, ids: slice, error: error.message })
      console.log(`      ${label} chunk ${n}/${total} (${slice.length}) FAILED: ${error.message}`)
      continue
    }
    const changed = (data || []).length
    if (changed !== slice.length) {
      console.log(`      ⚠️  ${label} chunk ${n}/${total}: asked ${slice.length}, changed ${changed}`)
    }
    ok += changed
    let auditNote = ''
    if (auditFor) {
      const a = await writeAudit(auditFor(slice))
      auditOk += a.ok; auditFailed += a.failed
      auditNote = a.failed ? `, ${a.failed} audit FAILED` : `, ${a.ok} audited`
      // ABORT on a lost trail. The rows are already changed and
      // service_scope_audit is append-only, so a re-run cannot re-audit them
      // (they no longer match the selection). Continuing would multiply the
      // number of silently-changed rows.
      if (a.failed) {
        console.error(`\n❌ audit write failed after ${label} chunk ${n}. STOPPING.`)
        console.error('   Rows already changed are recorded in the recovery file above.')
        failures.push({ chunk: n, ids: slice, error: 'audit failed — run halted' })
        return { ok, failures, auditOk, auditFailed, halted: true }
      }
    }
    console.log(`      ${label} chunk ${n}/${total} (${changed}) ok${auditNote}`)
  }
  return { ok, failures, auditOk, auditFailed }
}

/** Audit rows are written per batch, never deferred — the table is append-only,
 *  so a trail lost to a later failure can never be reconstructed. */
async function writeAudit(entries) {
  if (entries.length === 0) return { ok: 0, failed: 0 }
  let ok = 0, failed = 0
  for (let i = 0; i < entries.length; i += CHUNK) {
    const { error } = await db.from('service_scope_audit').insert(entries.slice(i, i + CHUNK))
    if (error) { failed += entries.slice(i, i + CHUNK).length; console.log(`      audit chunk FAILED: ${error.message}`) }
    else ok += entries.slice(i, i + CHUNK).length
  }
  return { ok, failed }
}

// ── Load ─────────────────────────────────────────────────────────────────────

const [clients, services, pricing, tasks] = await Promise.all([
  fetchAll('clients', 'id, name, is_active'),
  fetchAll('services', 'id, name, is_active, intake_kind'),
  fetchAll('client_service_pricing', 'id, client_id, service_id, price, commission_percentage, is_active'),
  fetchAll('tasks', 'id, client_id, service_id', q => q.is('deleted_at', null)),
])

const clientName = new Map(clients.map(c => [c.id, c.name]))
const serviceName = new Map(services.map(s => [s.id, s.name]))
const intakeKind = new Map(services.map(s => [s.id, s.intake_kind || 'none']))
const genericIds = new Set(services.filter(s => GENERIC.test(s.name)).map(s => s.id))
const canonicalOfferService = services.find(s => CANONICAL_OFFER_SERVICE.test(s.name))

// ── Evidence ─────────────────────────────────────────────────────────────────

const used = new Set()
const evidenceOf = new Map()          // key → Set(source)
const note = (clientId, serviceId, source) => {
  if (!clientId || !serviceId || genericIds.has(serviceId)) return
  const key = `${clientId}|${serviceId}`
  used.add(key)
  const set = evidenceOf.get(key)
  if (set) set.add(source); else evidenceOf.set(key, new Set([source]))
}

for (const t of tasks) note(t.client_id, t.service_id, 'task')

// Offer campaigns → the canonical offer service only (never fanned out).
const offerCampaigns = await tryFetch('offer_campaigns', 'id, client_id')
if (canonicalOfferService) {
  for (const c of offerCampaigns) note(c.client_id, canonicalOfferService.id, 'offer_campaign')
}

const socialItems = await tryFetch(
  'social_calendar_items', 'id, service_id, calendar:social_calendars(client_id)')
for (const i of socialItems) note(i.calendar?.client_id, i.service_id, 'social_calendar')

const requests = await tryFetch('task_requests', 'id, client_id, service_id')
for (const r of requests) note(r.client_id, r.service_id, 'request')

const adProjects = await tryFetch('ad_projects', 'id, client_id, service_id')
for (const p of adProjects) note(p.client_id, p.service_id, 'ad_project')

// ── Classify ─────────────────────────────────────────────────────────────────

const priced = new Map()
for (const p of pricing) {
  if (!p.client_id || !p.service_id) continue
  priced.set(`${p.client_id}|${p.service_id}`, p)
}

const toDeactivate = [], toCreate = [], toReactivate = []
let keep = 0
for (const [key, row] of priced) {
  const isUsed = used.has(key)
  if (isUsed && row.is_active !== false) { keep++; continue }
  if (isUsed && row.is_active === false) { toReactivate.push(row); continue }
  if (row.is_active !== false) toDeactivate.push({ ...row, generic: genericIds.has(row.service_id) })
}
for (const key of used) {
  if (priced.has(key)) continue
  const [client_id, service_id] = key.split('|')
  toCreate.push({ client_id, service_id, evidence: [...(evidenceOf.get(key) || [])] })
}

// ── Intake-preservation guardrail ────────────────────────────────────────────
// Committed set per client AFTER the plan, used to detect the last-of-a-kind.
const committedAfter = new Map()
const addAfter = (c, s) => {
  const set = committedAfter.get(c); if (set) set.add(s); else committedAfter.set(c, new Set([s]))
}
for (const [key, row] of priced) {
  const [c, s] = key.split('|')
  const beingDeactivated = toDeactivate.some(r => r.id === row.id)
  if (row.is_active !== false && !beingDeactivated) addAfter(c, s)
}
for (const r of [...toCreate, ...toReactivate]) addAfter(r.client_id, r.service_id)

const preserved = []
for (let i = toDeactivate.length - 1; i >= 0; i--) {
  const row = toDeactivate[i]
  const kind = intakeKind.get(row.service_id)
  if (!kind || kind === 'none') continue
  const stillHasKind = [...(committedAfter.get(row.client_id) || [])]
    .some(sid => intakeKind.get(sid) === kind)
  if (!stillHasKind) {
    preserved.push({ ...row, kind })
    addAfter(row.client_id, row.service_id)      // it stays committed
    toDeactivate.splice(i, 1)
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

const fmt = (c, s) => `${(clientName.get(c) || c).slice(0, 30).padEnd(30)} · ${serviceName.get(s) || s}`

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — commitment seeding from operational evidence`)
console.log('='.repeat(72))
console.log(`evidence pairs found            : ${used.size}`)
console.log(`  sources: task=${[...evidenceOf.values()].filter(s => s.has('task')).length}`
  + ` offer=${[...evidenceOf.values()].filter(s => s.has('offer_campaign')).length}`
  + ` social=${[...evidenceOf.values()].filter(s => s.has('social_calendar')).length}`
  + ` request=${[...evidenceOf.values()].filter(s => s.has('request')).length}`
  + ` ad=${[...evidenceOf.values()].filter(s => s.has('ad_project')).length}`)
console.log(`already correct (keep)          : ${keep}`)
console.log(`create  (evidence, no row)      : ${toCreate.length}`)
console.log(`reactivate                      : ${toReactivate.length}`)
console.log(`deactivate                      : ${toDeactivate.length}`
  + `  (generic buckets: ${toDeactivate.filter(r => r.generic).length})`)
console.log(`PRESERVED by intake guardrail   : ${preserved.length}`)

if (toCreate.length) {
  console.log(`\n── CREATE (commission_percentage = NULL, price = NULL) ${'─'.repeat(18)}`)
  for (const r of toCreate) console.log(`  + ${fmt(r.client_id, r.service_id)}   [${r.evidence.join(',')}]`)
}
if (preserved.length) {
  console.log(`\n── PRESERVED — last commitment of an intake kind ${'─'.repeat(24)}`)
  for (const r of preserved) console.log(`  ✋ ${fmt(r.client_id, r.service_id)}   [${r.kind}]`)
}

// Intake capability check — must be empty.
const losingIntake = []
for (const c of clients) {
  const before = new Set(pricing.filter(p => p.client_id === c.id && p.is_active !== false)
    .map(p => intakeKind.get(p.service_id)).filter(k => k && k !== 'none'))
  const after = new Set([...(committedAfter.get(c.id) || [])]
    .map(sid => intakeKind.get(sid)).filter(k => k && k !== 'none'))
  for (const k of before) if (!after.has(k)) losingIntake.push({ client: c, kind: k })
}
console.log(`\nclients losing an intake kind   : ${losingIntake.length}`
  + (losingIntake.length === 0 ? '  ✅' : '  ⚠️'))
for (const l of losingIntake) console.log(`  ⚠️  ${l.client.name} loses ${l.kind}`)

console.log(`\n── RESULTING SERVICE COUNT (active clients) ${'─'.repeat(28)}`)
for (const c of clients.filter(c => c.is_active !== false)) {
  const before = pricing.filter(p => p.client_id === c.id && p.is_active !== false).length
  const after = (committedAfter.get(c.id) || new Set()).size
  if (before || after) {
    console.log(`  ${c.name.slice(0, 34).padEnd(34)} ${String(before).padStart(3)} → ${String(after).padStart(3)}`
      + (after === 0 ? '   ⚠ zero — will show ALL services' : ''))
  }
}

if (!APPLY) {
  console.log(`\nNothing written. Re-run with --apply to commit these changes.\n`)
  process.exit(0)
}

if (!SKIP_CONFIRM) {
  console.log(`\nAbout to modify production: +${toCreate.length} create, `
    + `${toReactivate.length} reactivate, ${toDeactivate.length} deactivate.`)
  console.log('Re-run with --yes to proceed.\n')
  process.exit(0)
}

// ── Apply ────────────────────────────────────────────────────────────────────

const now = new Date().toISOString()

// RECOVERY FILE — written BEFORE the first write, so undo never depends on the
// append-only audit table having succeeded. `deactivated_by` is left null on
// the rows themselves and created rows carry no marker, so without this file a
// lost audit trail makes the creates unidentifiable.
const recoveryPath = `backfill-recovery-${now.replace(/[:.]/g, '-')}.json`
writeFileSync(recoveryPath, JSON.stringify({
  ranAt: now,
  note: 'Undo: reactivate the deactivateIds, delete the created pairs.',
  deactivateIds: toDeactivate.map(x => x.id),
  reactivateIds: toReactivate.map(x => x.id),
  created: toCreate.map(r => ({ client_id: r.client_id, service_id: r.service_id })),
  preserved: preserved.map(p => ({ client_id: p.client_id, service_id: p.service_id })),
}, null, 2))
console.log(`\nRecovery file written: ${recoveryPath}`)

let created = 0, reactivated = 0, deactivated = 0, auditOk = 0, auditFailed = 0
const problems = []

if (toCreate.length) {
  console.log(`\n[1/3] creating ${toCreate.length}…`)
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const slice = toCreate.slice(i, i + CHUNK)
    const { error } = await db.from('client_service_pricing').insert(slice.map(r => ({
      client_id: r.client_id,
      service_id: r.service_id,
      price: null,
      // EXPLICIT null — the DB default is 0, and 0 collapses the historical
      // commission pool because every reader guards with `?? 50` / `!= null`.
      commission_percentage: null,
      is_active: true,
    })))
    // ABORT, never continue. The intake guardrail reasoned against a world in
    // which these rows exist (committedAfter counts toCreate as present). If a
    // create fails and we proceed to step [3/3], we deactivate 625 rows using
    // a safety analysis whose premise is now false — which for an
    // intake-bearing create would break a live client portal while the report
    // still claimed "0 clients losing an intake kind".
    if (error) {
      console.error(`\n❌ create FAILED: ${error.message}`)
      console.error('   STOPPING before deactivation — the intake guardrail assumed these rows exist.')
      console.error(`   Nothing has been deactivated. Recovery file: ${recoveryPath}`)
      process.exit(1)
    }
    created += slice.length
    const a = await writeAudit(slice.map(r => ({
      scope_kind: 'client_service', action: 'added',
      client_id: r.client_id, service_id: r.service_id,
      old_value: null,
      new_value: { committed: true, evidence: r.evidence, commission_percentage: null },
      actor_id: null, source: 'backfill',
    })))
    auditOk += a.ok; auditFailed += a.failed
    if (a.failed) {
      console.error(`\n❌ audit write failed for created rows. STOPPING before deactivation.`)
      console.error(`   Recovery file: ${recoveryPath}`)
      process.exit(1)
    }
  }
}

if (toReactivate.length) {
  console.log(`\n[2/3] reactivating ${toReactivate.length}…`)
  const byId = new Map(toReactivate.map(x => [x.id, x]))
  const r = await chunkedUpdate('client_service_pricing', toReactivate.map(x => x.id),
    { is_active: true, deactivated_at: null, deactivated_by: null }, 'reactivate',
    slice => slice.map(id => byId.get(id)).filter(Boolean).map(x => ({
      scope_kind: 'client_service', action: 'activated',
      client_id: x.client_id, service_id: x.service_id,
      old_value: { is_active: false }, new_value: { is_active: true, via: 'evidence' },
      actor_id: null, source: 'backfill',
    })))
  reactivated = r.ok; auditOk += r.auditOk; auditFailed += r.auditFailed
  problems.push(...r.failures.map(f => `reactivate chunk ${f.chunk}: ${f.error}`))
  if (r.halted) {
    console.error(`\n❌ halted during reactivation — NOT proceeding to deactivation.`)
    console.error(`   Recovery file: ${recoveryPath}`)
    process.exit(1)
  }
}

if (toDeactivate.length) {
  console.log(`\n[3/3] deactivating ${toDeactivate.length}…`)
  const byId = new Map(toDeactivate.map(x => [x.id, x]))
  const r = await chunkedUpdate('client_service_pricing', toDeactivate.map(x => x.id),
    { is_active: false, deactivated_at: now }, 'deactivate',
    slice => slice.map(id => byId.get(id)).filter(Boolean).map(x => ({
      scope_kind: 'client_service', action: 'deactivated',
      client_id: x.client_id, service_id: x.service_id,
      old_value: { is_active: true, price: x.price, commission_percentage: x.commission_percentage },
      new_value: { is_active: false, reason: x.generic ? 'generic_bucket' : 'no_evidence' },
      actor_id: null, source: 'backfill',
    })))
  deactivated = r.ok; auditOk += r.auditOk; auditFailed += r.auditFailed
  problems.push(...r.failures.map(f => `deactivate chunk ${f.chunk}: ${f.error}`))
}

console.log(`\n${'='.repeat(72)}`)
console.log(`created ${created} · reactivated ${reactivated} · deactivated ${deactivated}`)
console.log(`audit rows: ${auditOk} written${auditFailed ? `, ${auditFailed} FAILED` : ''}`)
console.log('Prices and commissions are preserved on every deactivated row.')
console.log(`Recovery file: ${recoveryPath}`)
if (problems.length) {
  console.log(`\n⚠️  ${problems.length} problem(s):`)
  for (const p of problems) console.log(`   · ${p}`)
  // Deliberately NOT "re-run to retry". A re-run retries failed DATA writes
  // (the rows still match their selection), but it can never re-audit a row
  // whose data write SUCCEEDED and whose audit write failed — that row no
  // longer matches, and service_scope_audit is append-only. Use the recovery
  // file for those.
  console.log('\n   Data failures: safe to re-run (state is re-derived from live data).')
  console.log(`   Audit failures: NOT recoverable by re-running — use ${recoveryPath}.`)
  process.exit(1)
}
if (auditFailed) { console.log('\n⚠️  Some audit rows failed to write.'); process.exit(1) }
console.log('\nDone.\n')
