// Anonymous-exposure sweep — READ ONLY. Exit 1 if anything leaks.
//
// Why this exists alongside probe-rls.mjs: that script checks a HAND-MAINTAINED
// list of table names, so it can only find holes someone already thought of. On
// 2026-08-15 it reported "0 exposed" while 22 relations — including per-client
// billing totals and the company's monthly cash flow — were readable by the
// public anon key. The gap was VIEWS and MATERIALIZED VIEWS: they are not in
// pg_tables, so neither the RLS migrations nor the probe list covered them, and
// a view bypasses the underlying tables' RLS unless it is security_invoker.
//
// This version asks PostgREST what it actually exposes (its OpenAPI spec) and
// tries to read every single relation with the public key and no session. There
// is no list to keep up to date, so a table or view added tomorrow is covered.
//
// It prints row COUNTS and COLUMN NAMES only — never cell values — so it is
// safe to run in CI and paste into a ticket.
//
// Usage:  node scripts/sweep-anon.mjs        (exit 0 = nothing readable)

import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim()

const URL = get('NEXT_PUBLIC_SUPABASE_URL')
const ANON = get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const SERVICE = get('SUPABASE_SERVICE_ROLE_KEY')

if (!URL || !ANON || !SERVICE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY in .env.local')
  process.exit(2)
}

// The service role is used ONLY to enumerate what exists (the OpenAPI spec is
// not readable with the anon key on all projects). Every actual read below is
// made with the anon key.
const spec = await fetch(`${URL}/rest/v1/`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Accept: 'application/openapi+json' },
}).then((r) => r.json())

const relations = Object.keys(spec.paths || {})
  .filter((p) => p !== '/' && !p.startsWith('/rpc/'))
  .map((p) => p.slice(1))
  .sort()

const leaks = []
for (const rel of relations) {
  const res = await fetch(`${URL}/rest/v1/${rel}?select=*&limit=1`, {
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  })
  if (!res.ok) continue // 401/403/404 — anon cannot reach it at all
  let rows
  try {
    rows = JSON.parse(await res.text())
  } catch {
    continue
  }
  // RLS denies by returning an EMPTY SET rather than an error, so an empty
  // result is the PASS case, not a failure to detect.
  if (!Array.isArray(rows) || rows.length === 0) continue
  const total = Number((res.headers.get('content-range') || '').split('/')[1]) || rows.length
  leaks.push({ rel, total, cols: Object.keys(rows[0]) })
}

console.log(`\n=== ANONYMOUS EXPOSURE SWEEP — ${relations.length} relations checked ===\n`)

if (leaks.length === 0) {
  console.log('   Nothing is readable without a login.\n')
  process.exit(0)
}

console.log(`*** ${leaks.length} relation(s) READABLE BY THE PUBLIC ANON KEY, NO LOGIN ***\n`)
for (const l of leaks.sort((a, b) => b.total - a.total)) {
  console.log(`   ${l.rel.padEnd(34)} ${String(l.total).padStart(6)} rows`)
  console.log(`   ${' '.repeat(34)} ${l.cols.join(', ').slice(0, 110)}`)
}
console.log('\n   The anon key ships in the client bundle — treat this as public.\n')
process.exit(1)
