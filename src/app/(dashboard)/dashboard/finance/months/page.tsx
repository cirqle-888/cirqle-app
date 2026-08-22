import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getMonthlyProfit } from '@/lib/finance/profit'
import { loadPendingAdjustments } from '@/lib/payroll/adjustments'
import MonthsClient, { type MonthCard } from './months-client'

export const dynamic = 'force-dynamic'

const MONTHS_SHOWN = 12

/**
 * Financial Timeline — the owner's monthly control centre.
 *
 * COMPOSITION ONLY. This page owns no business logic and no data of its own:
 * every figure comes from an engine (profit, payroll, adjustments, locks) and
 * every action calls an existing server action. That is what keeps it from
 * ever disagreeing with the reports — and what makes adding a future module a
 * matter of rendering one more row.
 */
export default async function FinanceMonthsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.PAYROLL_VIEW)
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()
  const now = new Date()

  // Trailing window, newest first.
  const periods: { month: number; year: number }[] = []
  for (let i = 0; i < MONTHS_SHOWN; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    periods.push({ month: d.getMonth() + 1, year: d.getFullYear() })
  }

  // Locks and payroll status in two queries rather than per-month round trips.
  const oldest = periods[periods.length - 1]
  let lockedKeys = new Set<string>()
  try {
    const { data } = await admin.from('period_locks').select('month, year')
    lockedKeys = new Set((data || []).map((r: { month: number; year: number }) => `${r.year}-${r.month}`))
  } catch { /* pre-migration — nothing is explicitly locked */ }

  const { data: payrollRows } = await admin
    .from('payroll')
    .select('month, year, status, net_salary')
    .gte('year', oldest.year)

  const pending = await loadPendingAdjustments(admin)

  // Twelve INDEPENDENT profit reads. Awaiting them one at a time cost 10.9s
  // against live data; in parallel the same twelve take 1.4s. Nothing here
  // depends on the previous month's result, so the sequencing bought nothing.
  const profits = await Promise.all(
    periods.map(p => getMonthlyProfit(admin, p.month, p.year)),
  )

  const cards: MonthCard[] = []
  for (const [idx, p] of periods.entries()) {
    const profit = profits[idx]
    const rows = (payrollRows || []).filter(
      (r: { month: number; year: number }) => r.month === p.month && r.year === p.year,
    ) as { status: string; net_salary: number | null }[]
    const paidCount = rows.filter(r => r.status === 'paid').length
    const adjustments = pending.filter(a => a.sourceMonth === p.month && a.sourceYear === p.year)

    cards.push({
      month: p.month,
      year: p.year,
      revenueInr: profit.revenueInr,
      contributionInr: profit.contributionInr,
      baseSalariesInr: profit.baseSalariesInr,
      expensesInr: profit.expensesInr,
      profitInr: profit.profitInr,
      frozen: profit.frozen,
      // Locked by an explicit lock OR by money having moved — the same two
      // signals isMonthFinalized() uses, so the badge never contradicts what
      // the writers will actually allow.
      locked: lockedKeys.has(`${p.year}-${p.month}`) || paidCount > 0,
      explicitlyLocked: lockedKeys.has(`${p.year}-${p.month}`),
      payrollTotal: rows.length,
      payrollPaid: paidCount,
      payrollNetInr: rows.reduce((s, r) => s + Number(r.net_salary || 0), 0),
      pendingAdjustments: adjustments.length,
      pendingAdjustmentInr: adjustments.reduce((s, a) => s + a.amountInr, 0),
    })
  }

  return (
    <MonthsClient
      cards={cards}
      canManage={isAdmin || hasPermission(me, PERMS.PAYROLL_EDIT)}
      canSeeAmounts={isAdmin || hasPermission(me, PERMS.PAYROLL_VIEW_AMOUNTS)}
    />
  )
}
