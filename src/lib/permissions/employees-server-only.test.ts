import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * The browser may only read `employees` columns that are actually granted.
 *
 * A whole employee row carries base_salary, hourly_rate, bank_details and
 * date_of_birth. Until 2026-08-30 the bulk import/export screen queried the
 * table directly with the anon-key client, and that screen is reachable with
 * `tasks.create` — a permission most employees hold. Anyone who could create a
 * task could export every colleague's pay to a spreadsheet.
 *
 * It also blocked least privilege: 20260830120000 narrows `authenticated` to
 * eleven columns of `employees`, and a column-level GRANT is role-level, so
 * `select('*')` fails outright against a partial grant — for admins too. The
 * read had to move server-side before that migration could be applied at all.
 *
 * Both halves now live in dashboard/import/employee-data-actions.ts, on the
 * service role, behind permissions that describe the data rather than the page.
 *
 * This test fails if any 'use client' module that builds the browser Supabase
 * client goes near the table again.
 */

const SRC = join(process.cwd(), 'src')

/**
 * The columns 20260830120000 grants to `authenticated`. A browser query may
 * name these and nothing else; `select('*')` is never acceptable, because the
 * grant is partial and Postgres rejects the whole statement.
 */
const GRANTED = [
  'id', 'auth_id', 'cqid', 'name', 'email', 'avatar_url', 'role',
  'is_active', 'is_archived', 'designation_id', 'current_workspace_id',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

describe('employees is server-only', () => {
  const offenders: string[] = []

  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    const isClient = /^\s*['"]use client['"]/m.test(src.slice(0, 400))
    if (!isClient) continue
    if (!src.includes('lib/supabase/client')) continue

    // Find the variable holding the browser client, then look for reads or
    // writes made through it against `employees` specifically. A file-wide
    // grep would also flag `employees(name)` inside a PostgREST embed on some
    // other table, which is a join the server resolves and is not a direct read.
    const vars = [
      ...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createClient\s*\(\s*\)/g),
    ].map((m) => m[1])

    for (const v of vars) {
      // Capture what follows the .from('employees') call so we can look at the
      // columns it asks for.
      const re = new RegExp(
        `\\b${v}\\s*\\n?\\s*\\.from\\(\\s*['"]employees['"]\\s*\\)([\\s\\S]{0,300})`,
        'g',
      )
      for (const m of src.matchAll(re)) {
        const tail = m[1]
        const sel = /\.select\(\s*['"`]([^'"`]*)['"`]/.exec(tail)
        // No select() at all, or select('*'), means every column — which fails
        // against a partial grant.
        if (!sel || sel[1].trim() === '*') {
          offenders.push(`${relative(process.cwd(), file)} (select ${sel ? "'*'" : 'unscoped'})`)
          continue
        }
        const cols = sel[1]
          .split(',')
          .map((c) => c.trim().split(':')[0].trim())
          .filter((c) => c && !c.includes('(') && !c.includes(')'))
        const ungranted = cols.filter((c) => !GRANTED.includes(c))
        if (ungranted.length) {
          offenders.push(`${relative(process.cwd(), file)} (ungranted: ${ungranted.join(', ')})`)
        }
      }
    }
  }

  it('no browser read of employees touches an ungranted column', () => {
    expect(
      [...new Set(offenders)],
      'These read `employees` columns the browser is not granted, or use\n' +
        "select('*') against a partial grant. Both fail once 20260830120000 is\n" +
        'applied, and the ungranted columns are pay and PII. Move the call into a\n' +
        'server action on the service role:\n  ' +
        [...new Set(offenders)].join('\n  '),
    ).toEqual([])
  })

  it('the import screen has server actions for every employees operation', () => {
    const actions = readFileSync(
      join(SRC, 'app/(dashboard)/dashboard/import/employee-data-actions.ts'),
      'utf8',
    )
    for (const fn of [
      'exportEmployeeRows',
      'fetchEmployeeRowsByIds',
      'insertEmployeeRows',
      'updateEmployeeRows',
      'deleteEmployeeRows',
    ]) {
      expect(actions, `${fn} is missing`).toContain(`export async function ${fn}`)
    }
    // Each one must actually check a permission, not just run as the service
    // role. requireReadPermission counts: it enforces the same key and differs
    // only in surviving a view-as preview, which reads must.
    const guards = actions.match(/await require(Read)?Permission\(/g) ?? []
    expect(guards.length, 'every exported action must check a permission').toBeGreaterThanOrEqual(5)
  })

  it('is gated on employee permissions, not on the page gate', () => {
    const actions = readFileSync(
      join(SRC, 'app/(dashboard)/dashboard/import/employee-data-actions.ts'),
      'utf8',
    )
    // /dashboard/import is gated on tasks.create, which is far too wide for
    // payroll data — the whole point of moving this server-side.
    expect(
      /require(Read)?Permission\([^)]*tasks\.create/.test(actions),
      'these actions must not be gated on tasks.create — that is the page gate, ' +
        'and it is far too wide for payroll data',
    ).toBe(false)
    expect(actions).toContain('EMPLOYEES_VIEW_FULL')
    expect(actions).toContain('EMPLOYEES_CREATE')
    expect(actions).toContain('EMPLOYEES_EDIT')
    expect(actions).toContain('EMPLOYEES_ARCHIVE')
  })
})
