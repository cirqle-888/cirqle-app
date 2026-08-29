import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * CI guard for the database security boundary.
 *
 * The August 2026 audit found 22 relations — per-client billing totals, company
 * cash flow, partner PII, payroll allocations — readable by the PUBLIC anon key
 * with no login, plus every colleague's salary readable by any employee. The
 * root cause was not a missing policy; it was that the security model lived in
 * a HAND-MAINTAINED list. `scripts/probe-rls.mjs` reported "0 exposed" while all
 * of that was public, because views were never in its list.
 *
 * So the model is now derived (scripts/rls-keep-list.mjs walks the source for
 * browser queries and Realtime subscriptions) and this test asserts the derived
 * answer still matches what the migration actually grants. Add a client
 * component that queries a new table and this fails, naming the table — which
 * is the moment to decide whether the browser should really reach it.
 *
 * It is a static test on purpose: no database, no credentials, runs in CI.
 * Live verification is `node scripts/sweep-anon.mjs` (must report 0).
 */

const ROOT = process.cwd()
const MIGRATION = join(ROOT, 'supabase/migrations/20260815110000_authenticated_least_privilege.sql')
const ANON_MIGRATION = join(ROOT, 'supabase/migrations/20260815100000_revoke_anon_and_secure_views.sql')

/** The `keep text[] := ARRAY[ ... ]` block, as a list of relation names. */
function migrationKeepList(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8')
  const block = sql.slice(sql.indexOf('keep text[] := ARRAY['), sql.indexOf('];'))
  return [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort()
}

/** What the source says the browser genuinely needs. */
function derivedKeepList(): string[] {
  const out = execFileSync('node', [join(ROOT, 'scripts/rls-keep-list.mjs'), '--sql'], {
    encoding: 'utf8',
  })
  return [...out.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort()
}

describe('the least-privilege migration exists and is intact', () => {
  it('both security migrations are present', () => {
    expect(existsSync(MIGRATION), 'authenticated least-privilege migration missing').toBe(true)
    expect(existsSync(ANON_MIGRATION), 'anon revoke migration missing').toBe(true)
  })

  it('uses SQL string literals, not identifier quotes, in the keep array', () => {
    // "name" is an identifier in Postgres; a text[] needs 'name'. Getting this
    // wrong makes the migration fail at apply time with a confusing
    // "column ... does not exist".
    const sql = readFileSync(MIGRATION, 'utf8')
    const block = sql.slice(sql.indexOf('keep text[] := ARRAY['), sql.indexOf('];'))
    expect(block).not.toMatch(/"\s*[a-z0-9_]+\s*"/)
    expect(block).toMatch(/'[a-z0-9_]+'/)
  })

  it('revokes anon on tables, views AND materialized views', () => {
    const sql = readFileSync(ANON_MIGRATION, 'utf8')
    // "ALL TABLES IN SCHEMA" covers tables and views but NOT materialized
    // views — missing that pass is precisely how the mv_* leak survived.
    expect(sql).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon/)
    expect(sql).toMatch(/relkind\s*=\s*'m'/)
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]*REVOKE ALL ON TABLES FROM anon/)
  })

  it('withholds pay and bank details from the authenticated role', () => {
    const sql = readFileSync(MIGRATION, 'utf8')
    const grant = sql.slice(sql.indexOf('GRANT SELECT ('), sql.indexOf(') ON public.employees'))
    for (const secret of [
      'base_salary', 'hourly_rate', 'bank_details', 'date_of_birth', 'invite_token',
    ]) {
      expect(grant, `${secret} must not be granted to authenticated`).not.toContain(secret)
    }
    // …while still granting what the browser genuinely reads.
    for (const needed of ['id', 'auth_id', 'cqid', 'name', 'email', 'avatar_url']) {
      expect(grant).toContain(needed)
    }
  })
})

describe('the migration matches what the source actually needs', () => {
  it('grants every relation the browser queries or subscribes to', () => {
    const derived = derivedKeepList()
    const kept = migrationKeepList()
    // A derived name absent from the migration means a browser query would
    // start failing with a permission error once the migration is applied.
    const missing = derived.filter((t) => !kept.includes(t))

    // These are referenced in client code but do NOT exist in the database
    // (verified against the PostgREST schema on 2026-08-15) — those queries
    // already fail at runtime today and are tracked separately, so they must
    // not block this guard.
    const NON_EXISTENT = [
      'task_groups', 'task_group_assignments', 'task_parameter_assignments', 'invoice_payments',
    ]
    const realMissing = missing.filter((t) => !NON_EXISTENT.includes(t))

    expect(
      realMissing,
      `These are read from the browser but the migration revokes them.\n` +
        `Either add them to the migration's ARRAY[...] (run: node scripts/rls-keep-list.mjs --sql)\n` +
        `or move the query to a server action:\n  ${realMissing.join('\n  ')}`,
    ).toEqual([])
  })

  it('does not grant relations nothing reads — least privilege stays least', () => {
    const derived = derivedKeepList()
    const kept = migrationKeepList()
    const extra = kept.filter((t) => !derived.includes(t))
    expect(
      extra,
      `Granted to authenticated but nothing in src/ reads them from the browser:\n  ${extra.join('\n  ')}`,
    ).toEqual([])
  })
})
