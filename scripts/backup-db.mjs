// Database backup — READ ONLY against the database. Writes gzipped JSON locally.
//
// Why this exists: the project is on Supabase's Free plan, which takes no
// backups you can download, and the base schema was created outside
// migrations, so nothing in this repository can rebuild the data. One bad
// migration, a mistaken bulk edit, or a paused-then-lost project would lose
// the ledger, invoices and payroll history with no way back.
//
// What it does: asks PostgREST which tables exist (its OpenAPI spec, the same
// discovery sweep-anon.mjs uses, so new tables are covered automatically),
// reads every row of every TABLE with the service role, and writes one
// <table>.json.gz per table plus a manifest with row counts and checksums.
// Views are skipped: they are derived from tables and are rebuilt by the
// migrations that define them.
//
// What it is not: a SQL dump. It restores data, not schema, functions or
// policies. For a full dump use `npx supabase db dump` with the database
// password (see the comment at the end). This script needs nothing installed.
//
// THE OUTPUT CONTAINS EVERYTHING: salaries, bank details, client data, OAuth
// tokens. It is written to a private folder (owner-only permissions) OUTSIDE
// the repository. Keep it on encrypted storage. Never commit, upload or share it.
//
// Usage:
//   node scripts/backup-db.mjs                      → ~/CirqleBackups
//   node scripts/backup-db.mjs "/path/to/folder"    → that folder
//   node scripts/backup-db.mjs --keep 8             → also delete all but the newest 8 backups made by this script
// Then check it:
//   node scripts/backup-verify.mjs ~/CirqleBackups/cirqle-db-<stamp>

import { readFileSync } from 'fs'
import { mkdir, writeFile, chmod, readdir, rm, stat } from 'fs/promises'
import { gzipSync } from 'zlib'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { resolve, join } from 'path'

let fileEnv = ''
try {
  fileEnv = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
} catch {
  // No .env.local — the variables must come from the environment.
}
const get = (k) =>
  process.env[k]?.trim() || fileEnv.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '')

const URL = get('NEXT_PUBLIC_SUPABASE_URL')
const SERVICE = get('SUPABASE_SERVICE_ROLE_KEY')
if (!URL || !SERVICE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (run from the cirqle-app folder).')
  process.exit(2)
}

const args = process.argv.slice(2)
let keep = 0
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keep') keep = Math.max(1, Number(args[++i]) || 0)
  else positional.push(args[i])
}
const root = resolve(positional[0] || join(homedir(), 'CirqleBackups'))
const PREFIX = 'cirqle-db-'

const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
const PAGE = 1000

async function getJson(url, extra = {}, attempt = 1) {
  const res = await fetch(url, { headers: { ...headers, ...extra } })
  if (res.status >= 500 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * attempt))
    return getJson(url, extra, attempt + 1)
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// ── What exists ─────────────────────────────────────────────────────────────
const spec = await getJson(`${URL}/rest/v1/`, { Accept: 'application/openapi+json' })
const tables = []
const skippedViews = []
for (const [p, ops] of Object.entries(spec.paths || {})) {
  if (p === '/' || p.startsWith('/rpc/')) continue
  // Tables accept inserts; plain views do not. Views are derived data.
  if (ops.post) tables.push(p.slice(1))
  else skippedViews.push(p.slice(1))
}
tables.sort()

function orderFor(table) {
  const props = spec.definitions?.[table]?.properties || {}
  const pk = Object.entries(props)
    .filter(([, v]) => /Primary Key/.test(v?.description || ''))
    .map(([k]) => k)
  if (pk.length) return pk
  if (props.id) return ['id']
  const first = Object.keys(props)[0]
  return first ? [first] : []
}

// ── Read and write ──────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\..+$/, '')
const dir = join(root, `${PREFIX}${stamp}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
await chmod(root, 0o700).catch(() => {})
await chmod(dir, 0o700)

const manifest = {
  created_at: new Date().toISOString(),
  project_ref: new globalThis.URL(URL).hostname.split('.')[0],
  format: 'one gzipped JSON array per table; rows are PostgREST JSON',
  tables: {},
  skipped_views: skippedViews.sort(),
  errors: {},
}

let totalRows = 0
let totalBytes = 0
for (const t of tables) {
  try {
    const order = orderFor(t)
    const orderQs = order.length ? `&order=${order.map((c) => `${encodeURIComponent(c)}.asc`).join(',')}` : ''
    const rows = []
    for (let offset = 0; ; offset += PAGE) {
      const page = await getJson(`${URL}/rest/v1/${t}?select=*${orderQs}&limit=${PAGE}&offset=${offset}`)
      rows.push(...page)
      if (page.length < PAGE) break
    }
    const body = gzipSync(Buffer.from(JSON.stringify(rows)))
    const file = join(dir, `${t}.json.gz`)
    await writeFile(file, body, { mode: 0o600 })
    manifest.tables[t] = {
      rows: rows.length,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      ordered_by: order,
    }
    totalRows += rows.length
    totalBytes += body.length
    process.stdout.write(`  ${t.padEnd(40)} ${String(rows.length).padStart(7)} rows\n`)
  } catch (err) {
    manifest.errors[t] = String(err.message || err).slice(0, 300)
    process.stdout.write(`  ${t.padEnd(40)}  FAILED: ${manifest.errors[t]}\n`)
  }
}

await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })

const failed = Object.keys(manifest.errors).length
console.log(`\n${tables.length - failed} of ${tables.length} tables, ${totalRows.toLocaleString()} rows, ${(totalBytes / 1048576).toFixed(1)} MB compressed`)
console.log(`Saved to ${dir}`)
console.log(`Skipped ${skippedViews.length} views (derived from tables).`)

// ── Retention: only folders this script made, and only when asked ───────────
if (keep && failed === 0) {
  const mine = []
  for (const name of await readdir(root)) {
    if (!name.startsWith(PREFIX)) continue
    try {
      await stat(join(root, name, 'manifest.json'))
      mine.push(name)
    } catch {
      // Not a complete backup made by this script; leave it alone.
    }
  }
  mine.sort()
  const remove = mine.slice(0, Math.max(0, mine.length - keep))
  for (const name of remove) await rm(join(root, name), { recursive: true, force: true })
  if (remove.length) console.log(`Removed ${remove.length} older backup(s); kept the newest ${keep}.`)
}

if (failed) {
  console.error(`\n${failed} table(s) failed — this backup is INCOMPLETE. See manifest.json.`)
  process.exit(1)
}

// Full SQL dump (schema + data + functions), when you have the database password
// from Supabase → Project Settings → Database:
//   npx supabase db dump --linked -f schema.sql
//   npx supabase db dump --linked --data-only -f data.sql
