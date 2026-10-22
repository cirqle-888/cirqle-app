import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Static checks on the profit-sharing migration (design §12–13). No database:
 * these pin the properties that keep the module Admin-only and keep PostgREST
 * embeds unambiguous, so a later edit cannot quietly drop one.
 */
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261022100000_profit_sharing.sql'), 'utf8')
const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(profit_share_\w+)/g)].map(m => m[1])

describe('profit-sharing migration', () => {
  it('creates the fifteen module tables', () => {
    expect(tables).toHaveLength(15)
  })

  it('locks every table to the service role (RLS on, no grant to anon/authenticated)', () => {
    const loop = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP\s*EXECUTE format\('ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY', t\);\s*EXECUTE format\('REVOKE ALL ON public\.%I FROM anon, authenticated', t\);/.exec(sql)
    expect(loop, 'RLS + REVOKE loop not found').not.toBeNull()
    const locked = [...loop![1].matchAll(/'(profit_share_\w+)'/g)].map(m => m[1])
    expect(new Set(locked)).toEqual(new Set(tables))
    expect(sql).not.toMatch(/CREATE POLICY/i)
  })

  it('has exactly one foreign key to employees and one to cashbook_entries', () => {
    expect(sql.match(/REFERENCES public\.employees\(/g)).toHaveLength(1)
    expect(sql.match(/REFERENCES public\.cashbook_entries\(/g)).toHaveLength(1)
  })

  it('never has two foreign keys from one table to the same table', () => {
    const blocks = sql.split(/CREATE TABLE IF NOT EXISTS /).slice(1)
    for (const b of blocks) {
      const body = b.slice(0, b.indexOf(');\n'))
      const targets = [...body.matchAll(/REFERENCES public\.(\w+)\(/g)].map(m => m[1])
      expect(new Set(targets).size, `duplicate FK target in ${body.slice(0, 40)}`).toBe(targets.length)
    }
  })

  it('enforces Capital Share + Business Reserve = 100%', () => {
    expect(sql).toContain('CHECK (capital_share_pct + reserve_pct = 100.00)')
  })

  it('refuses overlapping confirmed periods', () => {
    expect(sql).toMatch(/EXCLUDE USING gist \(daterange\(period_start, period_end, '\[\]'\) WITH &&\) WHERE \(status = 'confirmed'\)/)
  })

  it('takes EXECUTE on the write functions away from PUBLIC', () => {
    for (const fn of ['profit_share_confirm_run', 'profit_share_settle', 'profit_share_record_capital']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`))
    }
  })

  it('grants the three permissions to admin designations only', () => {
    expect(sql).toMatch(/WHERE d\.is_admin = TRUE\s+AND p\.key IN \('profit_sharing\.view','profit_sharing\.manage','profit_sharing\.approve'\)/)
  })

  it('creates Cash Book categories only when missing', () => {
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM public\.cashbook_categories c WHERE lower\(c\.name\) = lower\(v\.name\)\)/)
  })

  it('writes payout entries without an employee, so they are never offered for payslip allocation', () => {
    const insert = /INSERT INTO public\.cashbook_entries\s*\(([^)]*)\)/.exec(sql)
    expect(insert).not.toBeNull()
    expect(insert![1]).not.toMatch(/employee_id/)
  })
})
