// Backup check — proves a backup made by backup-db.mjs can actually be read back.
//
// A backup nobody has opened is a hope, not a backup. This opens every file,
// checks its checksum against the manifest, decompresses and parses it, and
// confirms the row count. Then (read-only) it compares each table's row count
// with the live database, so a table that silently came back short shows up.
//
// Prints counts only, never row contents.
//
// Usage:  node scripts/backup-verify.mjs ~/CirqleBackups/cirqle-db-<stamp>
// Exit 0 = every file is intact.

import { readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import { resolve, join } from 'path'

const dir = process.argv[2] && resolve(process.argv[2])
if (!dir) {
  console.error('Usage: node scripts/backup-verify.mjs <backup folder>')
  process.exit(2)
}

let fileEnv = ''
try {
  fileEnv = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
} catch {
  // Live comparison is optional; the file checks still run.
}
const get = (k) =>
  process.env[k]?.trim() || fileEnv.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '')
const URL = get('NEXT_PUBLIC_SUPABASE_URL')
const SERVICE = get('SUPABASE_SERVICE_ROLE_KEY')

const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
const problems = []
let rows = 0

async function liveCount(table) {
  if (!URL || !SERVICE) return null
  const res = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' },
  })
  if (!res.ok) return null
  return Number((res.headers.get('content-range') || '').split('/')[1])
}

console.log(`Checking ${dir}\nMade ${manifest.created_at}\n`)
for (const [table, meta] of Object.entries(manifest.tables)) {
  try {
    const body = await readFile(join(dir, `${table}.json.gz`))
    const sum = createHash('sha256').update(body).digest('hex')
    if (sum !== meta.sha256) throw new Error('checksum does not match the manifest')
    const data = JSON.parse(gunzipSync(body).toString('utf8'))
    if (!Array.isArray(data) || data.length !== meta.rows) throw new Error(`expected ${meta.rows} rows, file has ${data.length}`)
    rows += data.length
    const live = await liveCount(table)
    // Small drift is normal (work continued after the backup); a backup holding
    // far FEWER rows than live is not, unless the backup is old.
    const note = live === null ? '' : live === data.length ? '' : `  (live now ${live})`
    console.log(`  ok  ${table.padEnd(40)} ${String(data.length).padStart(7)}${note}`)
  } catch (err) {
    problems.push(`${table}: ${err.message}`)
    console.log(`  !!  ${table.padEnd(40)} ${err.message}`)
  }
}

const failedAtBackup = Object.keys(manifest.errors || {})
if (failedAtBackup.length) problems.push(`not backed up: ${failedAtBackup.join(', ')}`)

console.log(`\n${Object.keys(manifest.tables).length} files, ${rows.toLocaleString()} rows read back.`)
if (problems.length) {
  console.error(`\nPROBLEMS (${problems.length}):\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('Every file is intact and readable.')
