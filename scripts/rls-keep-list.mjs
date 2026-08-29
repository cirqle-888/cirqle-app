// Which relations must keep an `authenticated` grant — DERIVED, not curated.
//
// The security model in 20260815110000_authenticated_least_privilege.sql is
// "the browser gets the tables the browser actually uses, and nothing else".
// That list is only trustworthy if it is recomputed from the source, because a
// hand-maintained one drifts the moment somebody adds a component — which is
// exactly how the anon hole survived (scripts/probe-rls.mjs checked a fixed
// list and reported all-clear while 22 relations were public).
//
// A relation is retained when either is true:
//   1. a 'use client' module that constructs the BROWSER supabase client calls
//      .from('<relation>') on it, or
//   2. it is subscribed via Realtime postgres_changes — Realtime evaluates RLS
//      per subscriber, so the role needs SELECT or events are never delivered.
// conversations/conversation_members are added because chat needs them
// alongside the message tables it subscribes to.
//
// Server actions, route handlers and every public/tokenized page use the
// service role, which bypasses grants and RLS entirely, so nothing they do
// affects this list.
//
// Usage:
//   node scripts/rls-keep-list.mjs           # print the report
//   node scripts/rls-keep-list.mjs --sql     # print the SQL array body
//
// Run it after adding a client component that queries a new table, then update
// the migration's ARRAY[...] block from --sql output.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

const SRC = resolve(process.cwd(), 'src')

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const browser = new Map() // relation -> Set(file)
const realtime = new Map()

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const isClient = /^\s*['"]use client['"]/m.test(src.slice(0, 400))

  // 1. Direct .from() calls, but only in modules that build the browser client.
  if (isClient && src.includes('lib/supabase/client')) {
    for (const m of src.matchAll(/\.from\(['"]([a-zA-Z0-9_]+)['"]\)/g)) {
      if (!browser.has(m[1])) browser.set(m[1], new Set())
      browser.get(m[1]).add(f)
    }
  }

  // 2. Realtime subscriptions name their table explicitly.
  if (src.includes('postgres_changes')) {
    for (const m of src.matchAll(/table:\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
      if (!realtime.has(m[1])) realtime.set(m[1], new Set())
      realtime.get(m[1]).add(f)
    }
  }
}

const CHAT_SUPPORT = ['conversations', 'conversation_members']
const keep = [...new Set([...browser.keys(), ...realtime.keys(), ...CHAT_SUPPORT])].sort()

if (process.argv.includes('--sql')) {
  console.log(keep.map((t) => `    '${t}'`).join(',\n'))
  process.exit(0)
}

const rel = (f) => f.replace(process.cwd() + '/', '')
console.log(`\n=== Relations that must keep an \`authenticated\` grant: ${keep.length} ===\n`)
for (const t of keep) {
  const why = []
  if (browser.has(t)) why.push(`browser x${browser.get(t).size}`)
  if (realtime.has(t)) why.push(`realtime x${realtime.get(t).size}`)
  if (!why.length) why.push('chat support')
  console.log(`  ${t.padEnd(34)} ${why.join(', ')}`)
}
console.log(`
Note: a name here that does not exist in the database is harmless — the
migration only revokes relations it finds, and a query against a missing table
already fails at runtime. Cross-check with scripts/sweep-anon.mjs.
`)
