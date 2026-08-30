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
// The employees column grant was split out of MIGRATION on 2026-08-30: it is
// blocked on moving the browser import/export off `.from('employees')
// .select('*')`, while the broad revoke in MIGRATION could ship immediately.
const EMPLOYEE_GRANTS = join(ROOT, 'supabase/migrations/20260830120000_employees_column_grants.sql')

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
    const sql = readFileSync(EMPLOYEE_GRANTS, 'utf8')
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

const RLS_CLOSE = join(ROOT, 'supabase/migrations/20260830100000_rls_close_remaining_tables.sql')

/** The two ARRAY[...] blocks in the RLS-close migration, as name lists. */
function rlsCloseGroups(): { a: string[]; b: string[] } {
  const sql = readFileSync(RLS_CLOSE, 'utf8')
  const groups = [...sql.matchAll(/targets text\[\] := ARRAY\[([\s\S]*?)\]/g)].map((m) =>
    [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]).sort(),
  )
  return { a: groups[0] ?? [], b: groups[1] ?? [] }
}

describe('the RLS-close migration groups tables by who can actually reach them', () => {
  it('every deny-all table is genuinely unreachable as `authenticated`', () => {
    // Group B gets RLS with NO policy, which denies `authenticated` outright.
    // If any of them is later read from the browser, from Realtime, or from a
    // server module on the cookie-session client, that read starts returning
    // nothing — silently, because PostgREST reports an empty result, not an
    // error. This is the test that catches it at commit time instead.
    const derived = derivedKeepList()
    const { b } = rlsCloseGroups()
    const wrongGroup = b.filter((t) => derived.includes(t))
    expect(
      wrongGroup,
      `These are in the migration's deny-all group but something now reads them\n` +
        `as \`authenticated\`. Move them to group A (permissive policy) or move the\n` +
        `query to the service role:\n  ${wrongGroup.join('\n  ')}`,
    ).toEqual([])
  })

  it('covers every table the audit found with RLS disabled', () => {
    // The 18 measured against production on 2026-08-29.
    const FOUND_DISABLED = [
      'ad_accounts', 'ad_ai_cache', 'ad_ai_insights', 'ad_ai_usage', 'ad_benchmarks',
      'ad_businesses', 'ad_forecast_accuracy', 'ad_sync_logs', 'ai_prompts',
      'cashbook_categories', 'cashbook_payroll_allocations', 'contribution_groups',
      'deductions', 'invoice_change_logs', 'parameter_services', 'quotation_items',
      'task_tools', 'tool_services',
    ].sort()
    const { a, b } = rlsCloseGroups()
    expect([...a, ...b].sort()).toEqual(FOUND_DISABLED)
  })

  it('puts a table in exactly one group', () => {
    const { a, b } = rlsCloseGroups()
    expect(a.filter((t) => b.includes(t))).toEqual([])
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

  it('keeps the permission catalogue reachable — the lockout guard', () => {
    // The failure this exists to prevent, found 2026-08-30:
    //
    // rls-keep-list.mjs derived the keep list from browser queries and Realtime
    // subscriptions only, on the stated assumption that all server code uses
    // the service role. Eight modules do not — they call `await createClient()`,
    // the cookie-session client, which connects as `authenticated`.
    //
    // src/lib/permissions/check.ts was one of them. loadCurrentUser(), imported
    // by 158 modules, read `permissions` and `designation_permissions` to decide
    // what the signed-in user may do. Neither was in the derived list, so this
    // migration would have revoked the permission catalogue from the query that
    // reads it: hasPermission() returns the empty set, for every user, on every
    // page. A total lockout — and the guard above passed, because it only ever
    // compared the migration against a derivation that shared the same blind
    // spot.
    //
    // check.ts now does its reads on the service role, but two Settings pages
    // still read these through the session client, so the grants must stay.
    const kept = migrationKeepList()
    for (const table of ['permissions', 'designation_permissions', 'designations', 'employees']) {
      expect(
        kept,
        `${table} is read by a server module on the cookie-session client, which ` +
          `runs as \`authenticated\`. Revoking it locks users out of the app.`,
      ).toContain(table)
    }
  })

  it('derives from session-client server reads, not just the browser', () => {
    // Guards the derivation itself: delete rule 3 and the keep list silently
    // shrinks back to the shape that caused the lockout above.
    const script = readFileSync(join(ROOT, 'scripts/rls-keep-list.mjs'), 'utf8')
    expect(script, 'rls-keep-list.mjs must still detect `await createClient()` readers').toMatch(
      /await\\s\+createClient/,
    )
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
