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

describe('cash book money screens are gated on cashbook.view_amounts', () => {
  const middleware = read('src/lib/supabase/middleware.ts')
  const client = read('src/app/(dashboard)/dashboard/cashbook/cashbook-client.tsx')

  it.each(['accounts', 'reconciliation'])('the /%s route requires the amount permission', (sub) => {
    const line = middleware
      .split('\n')
      .find((l) => l.includes(`dashboard\\/cashbook\\/${sub}`))
    expect(line, `no middleware entry for /dashboard/cashbook/${sub}`).toBeTruthy()
    expect(line).toContain('cashbook.view_amounts')
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

  it('the Accounts and Reconciliation links are hidden without it', () => {
    for (const href of ['/dashboard/cashbook/accounts', '/dashboard/cashbook/reconciliation']) {
      const at = client.indexOf(href)
      expect(at, `${href} link not found`).toBeGreaterThan(-1)
      // The nearest preceding conditional must be the amount flag.
      const before = client.slice(Math.max(0, at - 400), at)
      expect(
        before.includes('showAmounts &&'),
        `${href} is rendered without a showAmounts guard`,
      ).toBe(true)
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
