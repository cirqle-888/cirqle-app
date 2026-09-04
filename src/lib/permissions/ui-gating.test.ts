import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Controls are gated on the permission they actually need.
 *
 * A button you are not allowed to use is worse than no button: it reads as
 * available, and the refusal only arrives after the click. Worse still when the
 * screen behind it was never gated either — hiding a link leaves the URL
 * working, which is presentation, not permission.
 *
 * Two concrete cases this pins, both found on 2026-08-31 while reviewing what a
 * Task Manager could reach:
 *
 *   · Cash Book offered Accounts and Reconciliation to anyone with
 *     `cashbook.view`. Both screens exist to show money — balances, a ledger,
 *     amounts matched against the bank — so a user whose Amount column was
 *     deliberately stripped was being handed two routes straight to the totals,
 *     and could reach them by URL regardless.
 *
 *   · The invoice portfolio aggregates (total outstanding / overdue / draft
 *     value) rode on `billing.view_amounts`, the same grant that reveals the
 *     figures on a single invoice. Collections needs the second to write a
 *     reminder; it does not follow that they should see the company's cash
 *     position. `billing.view_totals` now carries the aggregates alone.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('cash book money screens are gated on cashbook.view_amounts / cashbook.view_totals', () => {
  const middleware = read('src/lib/supabase/middleware.ts')
  const client = read('src/app/(dashboard)/dashboard/cashbook/cashbook-client.tsx')

  // Accounts shows BALANCES — an aggregate across entries — so it moved onto
  // cashbook.view_totals on 2026-09-04, the same split this file's own header
  // comment describes for billing.view_totals. Reconciliation stays on
  // view_amounts: its page is requireAdmin() regardless, so the finer split
  // does not matter there.
  const routePerm: Record<string, string> = {
    accounts: 'cashbook.view_totals',
    reconciliation: 'cashbook.view_amounts',
  }

  it.each(['accounts', 'reconciliation'])('the /%s route requires the correct permission', (sub) => {
    const line = middleware
      .split('\n')
      .find((l) => l.includes(`dashboard\\/cashbook\\/${sub}`))
    expect(line, `no middleware entry for /dashboard/cashbook/${sub}`).toBeTruthy()
    expect(line).toContain(routePerm[sub])
  })

  it('the specific cashbook routes are matched before the general one', () => {
    // ROUTE_PERMS is consumed with .find(), so a general /dashboard/cashbook
    // entry placed first would shadow both and silently re-open the screens.
    const lines = middleware.split('\n')
    const general = lines.findIndex((l) => /dashboard\\\/cashbook\/,/.test(l) || /dashboard\\\/cashbook\/ *,/.test(l))
    const accounts = lines.findIndex((l) => l.includes('dashboard\\/cashbook\\/accounts'))
    const recon = lines.findIndex((l) => l.includes('dashboard\\/cashbook\\/reconciliation'))
    expect(accounts).toBeGreaterThan(-1)
    expect(recon).toBeGreaterThan(-1)
    if (general > -1) {
      expect(accounts, 'accounts must be matched before the general cashbook route').toBeLessThan(general)
      expect(recon, 'reconciliation must be matched before the general cashbook route').toBeLessThan(general)
    }
  })

  it('the Accounts and Reconciliation links are hidden without their permission', () => {
    const linkGuard: Record<string, string> = {
      '/dashboard/cashbook/accounts':       'showTotals &&',
      '/dashboard/cashbook/reconciliation': 'showAmounts &&',
    }
    for (const [href, guard] of Object.entries(linkGuard)) {
      const at = client.indexOf(href)
      expect(at, `${href} link not found`).toBeGreaterThan(-1)
      const before = client.slice(Math.max(0, at - 400), at)
      expect(before.includes(guard), `${href} is rendered without a ${guard} guard`).toBe(true)
    }
  })

  it('entry-writing buttons follow cashbook.edit, not the amount permission', () => {
    // Someone who may record entries but not see totals must keep these.
    expect(client).toContain('canEditEntries && (')
    expect(client).toContain('canEditEntries: boolean')
  })
})

describe('invoice portfolio aggregates are gated on billing.view_totals', () => {
  const invoices = read('src/app/(dashboard)/dashboard/invoices/invoices-client.tsx')
  const followups = read('src/app/(dashboard)/dashboard/invoices/follow-ups/follow-ups-client.tsx')

  it('every aggregate render sits behind showTotals, not showAmounts', () => {
    // stats.* are sums across every client; visibility.amounts is per-invoice.
    for (const agg of ['stats.outstanding', 'stats.overdueAmt', 'stats.draftTotal']) {
      const idx = invoices.indexOf(`fmt(${agg})`)
      expect(idx, `${agg} is not rendered`).toBeGreaterThan(-1)
      const before = invoices.slice(Math.max(0, idx - 500), idx)
      expect(before.includes('showTotals'), `${agg} is not guarded by showTotals`).toBe(true)
    }
  })

  it("follow-ups hides the total but keeps the counts", () => {
    // The counts say how much work there is; only the money is portfolio data.
    expect(followups).toContain("value={showTotals ? fmtINR(totalOutstanding) : '—'}")
    expect(followups).toContain('value={String(groups.urgent.length)}')
    expect(followups).toContain('value={String(invoices.length)}')
  })

  it('the reminder text still uses per-invoice amounts', () => {
    // The whole point of the split: a collections role can tell a client what
    // they owe without being shown what everyone owes.
    expect(followups).toContain('showAmounts,')
    expect(followups).toContain('buildReminderText(')
  })
})

describe('cross-module links match the permission their target enforces', () => {
  const read2 = (x: string) => readFileSync(join(ROOT, x), 'utf8')

  it('Follow-ups hides Client Ranking unless the target would allow it', () => {
    const client = read2('src/app/(dashboard)/dashboard/invoices/follow-ups/follow-ups-client.tsx')
    const at = client.indexOf('/dashboard/clients/ranking')
    expect(at, 'ranking link not found').toBeGreaterThan(-1)
    expect(client.slice(Math.max(0, at - 300), at)).toContain('canSeeRanking &&')
  })

  it('and gates it on exactly what that page checks — reports.view', () => {
    // clients/ranking/page.tsx accepts `reports.view` and nothing else.
    // Gating the link on a wider set would offer it to someone the page
    // bounces, which is the fault this whole file exists to prevent.
    const page = read2('src/app/(dashboard)/dashboard/invoices/follow-ups/page.tsx')
    const target = read2('src/app/(dashboard)/dashboard/clients/ranking/page.tsx')
    expect(target).toContain("'reports.view'")
    expect(page).toContain('PERMS.REPORTS_VIEW)')
    expect(page).not.toContain('REPORTS_VIEW_CLIENT_FINANCIALS')
  })

  it('every sidebar item agrees with the route gate it points at', () => {
    // A sidebar entry whose permission differs from the middleware rule for its
    // href is either a link that bounces, or a page reachable while hidden.
    // /dashboard/settings/workspaces was the former: the nav asked for
    // workspaces.manage while the general /dashboard/settings rule caught the
    // route first and demanded settings.access.
    const nav = read2('src/lib/nav-sections.ts')
    const mw = read2('src/lib/supabase/middleware.ts')
    const rules = [...mw.matchAll(/\[\/\^([^,]+?)\/,\s*'([a-z_.]+)'\]/g)]
      .map(m => ({ re: new RegExp('^' + m[1].replace(/\\\//g, '/')), key: m[2] }))

    const mismatches: string[] = []
    for (const m of nav.matchAll(/\{[^{}]*href:\s*'([^']+)'[^{}]*\}/g)) {
      const block = m[0]
      if (/adminOnly:\s*true/.test(block)) continue
      const href = m[1]
      const rule = rules.find(r => r.re.test(href))
      if (!rule) continue
      const perm = /requiredPerm:\s*'([^']+)'/.exec(block)?.[1]
      const any = [...(/requiredAnyPerm:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? '').matchAll(/'([a-z_.]+)'/g)].map(x => x[1])
      const keys = [perm, ...any].filter(Boolean) as string[]
      if (keys.length && !keys.includes(rule.key)) {
        mismatches.push(`${href}: sidebar wants ${keys.join('|')}, route requires ${rule.key}`)
      }
    }
    expect(mismatches, 'sidebar and middleware disagree:\n  ' + mismatches.join('\n  ')).toEqual([])
  })
})

describe('portfolio aggregates are gated on showTotals, not showAmounts', () => {
  const read3 = (x: string) => readFileSync(join(ROOT, x), 'utf8')

  /**
   * The distinction the billing keys draw, and the one that kept slipping:
   *
   *   billing.view_amounts  — what THIS invoice is worth. A collections role
   *                           needs it to chase a client and write a reminder.
   *   billing.view_totals   — what the BOOK is worth. Portfolio position:
   *                           outstanding, overdue, dues by month, a section
   *                           sum, the total of a hand-picked selection.
   *
   * Gating an aggregate on showAmounts looks correct and is not — it hands the
   * portfolio to exactly the role the split exists to keep it from. Every case
   * below was doing that, or nothing at all, before 2026-08-31.
   */
  const cases: Array<[string, string, string]> = [
    ['invoices-client.tsx', 'list footer portfolio total', 'Total: {fmt(filtered.reduce'],
    ['invoices-client.tsx', 'bulk-selection sum', 'Due: {fmt(invoices.filter(i => selectedForBulk'],
    ['follow-ups/follow-ups-client.tsx', 'section aggregate', '{fmtINR(groupOutstanding)}'],
  ]

  for (const [file, what, needle] of cases) {
    it(`${what} is behind showTotals`, () => {
      const src = read3(`src/app/(dashboard)/dashboard/invoices/${file}`)
      const at = src.indexOf(needle)
      expect(at, `${what}: anchor not found — did the markup change?`).toBeGreaterThan(-1)
      const before = src.slice(Math.max(0, at - 400), at)
      expect(before, `${what} must be guarded by showTotals`).toContain('showTotals &&')
    })
  }

  it('the stage-value cards show counts without showTotals, but not amounts', () => {
    const src = read3('src/app/(dashboard)/dashboard/invoices/invoices-client.tsx')
    const at = src.indexOf("{s.count > 0 ? fmt(s.amount) : '—'}")
    expect(at, 'stage card amount not found').toBeGreaterThan(-1)
    expect(src.slice(Math.max(0, at - 300), at)).toContain('showTotals &&')
    // The count itself must stay — nine drafts to send is the work, not a figure.
    expect(src).toContain("<span className=\"ml-auto font-semibold text-foreground/70\">{s.count}</span>")
  })

  it('dues-by-month is hidden wholesale, being nothing but money', () => {
    const src = read3('src/app/(dashboard)/dashboard/invoices/invoices-client.tsx')
    expect(src).toContain('{showTotals && stats.monthDues.length > 0 && (')
  })

  it('per-client and per-invoice figures still follow showAmounts', () => {
    // The other half of the contract: these must NOT be swept up, or the
    // reminder text loses the numbers that make it worth sending.
    const src = read3('src/app/(dashboard)/dashboard/invoices/follow-ups/follow-ups-client.tsx')
    expect(src).toContain('{showAmounts && ` · ${fmtINR(cluster.items.reduce')
    expect(src).toContain('{showAmounts && ` · ${fmtINR(partnerPending.reduce')
  })
})

/**
 * Contribution earnings never reach a toast that outranks the screen behind it.
 *
 * Found 2026-09-04. Saving contributions popped "Contributions saved · CQID002
 * ₹99" — every scored employee's pay, and the saver's own. Every on-screen
 * amount in that view checks the earnings permission; the toast checked
 * nothing. It is computed in the browser from the task's billing, so the number
 * exists there whether or not the person may see it.
 *
 * The role that hit it is the one that hits it most: a Task Manager scores
 * other people's contributions all day and holds neither
 * contributions.view_earnings nor payroll.view_amounts. A confirmation popup is
 * also the worst possible carrier — it appears unbidden, over whatever is on
 * screen, on a monitor other people can see.
 */
describe('contribution earnings toasts obey the earnings permission', () => {
  const cases: { file: string; flag: string }[] = [
    { file: 'src/app/(dashboard)/dashboard/contributions/contributions-client.tsx', flag: 'canSeeFinancials && showFinancials' },
    { file: 'src/components/ui/contribution-entry-panel.tsx', flag: 'showEarnings && showFinancials' },
  ]

  for (const { file, flag } of cases) {
    it(`${file.split('/').pop()} decides the ₹ from the permission before building the toast`, () => {
      const src = read(file)
      const at = src.indexOf("toast.success('Contributions saved', lines")
      expect(at, 'the saved-contributions toast has moved or been renamed').toBeGreaterThan(-1)

      // The 900 characters before the toast build its `lines`. The money must
      // be behind a permission decision taken there, not printed regardless.
      const build = src.slice(Math.max(0, at - 900), at)
      expect(build, `${file}: no showMoney gate found before the toast`).toContain('showMoney')
      expect(build, `${file}: showMoney must derive from ${flag}`).toContain(flag)
      // The unconditional template that leaked is gone: every ₹ in that block
      // is now behind the ternary.
      expect(
        /\$\{cqid\} ₹\$\{Math\.round\(e\.earnings\)/.test(build) && !build.includes('showMoney ?'),
        `${file}: earnings are interpolated without the showMoney check`,
      ).toBe(false)
    })
  }

  it('the money panels check the permission, not just the Show-₹ toggle', () => {
    // `showFinancials` is a display toggle. It was the ONLY guard on the
    // earnings breakdown and the "Total payable" footer, which made those
    // amounts depend on a button being hidden rather than on the grant itself
    // — the same shape of mistake as the toast.
    const src = read('src/app/(dashboard)/dashboard/contributions/contributions-client.tsx')
    expect(src).not.toContain('{calculatedResult && showFinancials && (')
    expect(src).toContain('{calculatedResult && canSeeFinancials && showFinancials && (')
  })
})
