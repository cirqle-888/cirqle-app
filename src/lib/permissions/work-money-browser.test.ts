import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * The browser may read task prices and contribution earnings ONLY through the
 * permission-checked views (src/lib/supabase/priced.ts).
 *
 * 20261116120000 withholds these columns of `tasks` and `contribution_scores`
 * from `authenticated`. Any browser query that still names one of them on the
 * base table — directly, in a PostgREST embed, in an ORDER BY, or through
 * `select('*')` — fails outright once that migration is applied, for admins
 * too. This test finds them before the migration does.
 *
 * It mirrors employees-server-only.test.ts, which guarded the salary columns
 * the same way.
 */

const SRC = join(process.cwd(), 'src')

/** Keep in step with 20261116120000_work_money_column_grants.sql. */
export const TASK_MONEY = [
  'billing_amount', 'billing_amount_inr', 'billing_exchange_rate', 'billing_percent',
  'billing_snapshot', 'billing_rule', 'loss_amount', 'work_value', 'work_value_inr',
  'referral_percent',
]
export const SCORE_MONEY = ['earnings_inr']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('.test.')) out.push(p)
  }
  return out
}

/** Top-level column names of a PostgREST select list ('a, b, rel(x, y)' → a, b). */
function topLevelColumns(list: string): string[] {
  const cols: string[] = []
  let depth = 0, cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; continue }
    if (depth === 0 && ch !== '(' && ch !== ')') cur += ch
  }
  cols.push(cur)
  return cols
    .map(c => c.trim())
    .filter(Boolean)
    // `alias:column` and `column::cast` both name `column`; embeds were
    // flattened to their name above and are checked separately.
    .map(c => c.split('::')[0].split(':').pop()!.trim())
}

/** The contents of every embed of `table` in a select string, e.g. task:tasks!task_id(…). */
function embeds(sel: string, table: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?:^|[\\s,(])(?:[\\w]+:)?${table}(?:![\\w]+)?\\(`, 'g')
  for (const m of sel.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length, depth = 1, body = ''
    while (i < sel.length && depth > 0) {
      const ch = sel[i++]
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (depth > 0) body += ch
    }
    out.push(body)
  }
  return out
}

function moneyIn(cols: string[], money: string[]): string[] {
  return cols.filter(c => c === '*' || money.includes(c))
}

export function browserMoneyOffenders(): string[] {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    const isClient = /^\s*['"]use client['"]/m.test(src.slice(0, 400))
    const isMarked = src.includes('// rls: browser-client')
    if (!(isClient || isMarked) || !src.includes('lib/supabase/client') && !isMarked) continue
    const rel = relative(process.cwd(), file)

    // 1. Direct reads of the base tables.
    for (const [table, money] of [['tasks', TASK_MONEY], ['contribution_scores', SCORE_MONEY]] as const) {
      const re = new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)([\\s\\S]{0,500})`, 'g')
      for (const m of src.matchAll(re)) {
        // The chain ends at the next .from( — good enough for this codebase.
        const tail = m[1].split(/\.from\(/)[0]
        for (const s of tail.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)) {
          const bad = moneyIn(topLevelColumns(s[2]), money)
          if (bad.length) offenders.push(`${rel}: ${table} select ${bad.join(', ')}`)
        }
        for (const o of tail.matchAll(/\.order\(\s*['"]([\w]+)['"]/g)) {
          if ((money as readonly string[]).includes(o[1])) offenders.push(`${rel}: ${table} order by ${o[1]}`)
        }
      }
    }

    // 2. Embeds of the base tables inside any select string in the file.
    for (const s of src.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)) {
      for (const body of embeds(s[2], 'tasks')) {
        const bad = moneyIn(topLevelColumns(body), TASK_MONEY)
        if (bad.length) offenders.push(`${rel}: embed tasks(${bad.join(', ')})`)
      }
      for (const body of embeds(s[2], 'contribution_scores')) {
        const bad = moneyIn(topLevelColumns(body), SCORE_MONEY)
        if (bad.length) offenders.push(`${rel}: embed contribution_scores(${bad.join(', ')})`)
      }
    }
  }
  return [...new Set(offenders)].sort()
}

describe('task prices and earnings reach the browser only through the priced views', () => {
  it('no browser query names a money column on the base tables', () => {
    const offenders = browserMoneyOffenders()
    expect(
      offenders,
      'These browser queries read money columns of `tasks` / `contribution_scores`\n' +
        'directly. They fail once 20261116120000 is applied. Read through\n' +
        'viaPriced() from src/lib/supabase/priced.ts instead:\n  ' + offenders.join('\n  '),
    ).toEqual([])
  })

  it('the column lists match the migration', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261116120000_work_money_column_grants.sql'), 'utf8')
    for (const c of [...TASK_MONEY, ...SCORE_MONEY]) expect(sql, c).toContain(`'${c}'`)
  })
})
