import { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import {
  loadRetainerAnalytics, loadEmployeeRetainerContribution, loadRetainerAnalyticsTrend,
  type RetainerAnalytics, type EmployeeRetainerRow, type RetainerTrendPoint,
} from '@/lib/agreements/analytics'
import RetainerAnalyticsClient from './retainer-analytics-client'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Retainer Analytics | Cirqle' }

export default async function RetainerAnalyticsReportPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW) || hasPermission(me, PERMS.REPORTS_VIEW)
  if (me && !canView) redirect('/dashboard')
  const canViewPricing = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW_PRICING)

  const sp = searchParams ? await searchParams : undefined
  const month = (typeof sp?.month === 'string' && /^\d{4}-\d{2}$/.test(sp.month))
    ? sp.month
    : new Date().toISOString().slice(0, 7)
  const range = (typeof sp?.range === 'string' && ['3', '6', '12'].includes(sp.range)) ? Number(sp.range) : 6

  let analytics: RetainerAnalytics[] = []
  let employees: EmployeeRetainerRow[] = []
  let trend: RetainerTrendPoint[] = []
  try {
    [analytics, employees, trend] = await Promise.all([
      loadRetainerAnalytics({ month, pricingVisible: canViewPricing }),
      loadEmployeeRetainerContribution({ month, pricingVisible: canViewPricing }),
      loadRetainerAnalyticsTrend({ endMonth: month, months: range, pricingVisible: canViewPricing }),
    ])
  } catch (err) {
    console.error('Failed to load retainer analytics report', err)
  }

  return (
    <RetainerAnalyticsClient
      analytics={analytics}
      employees={employees}
      trend={trend}
      month={month}
      range={range}
      canViewPricing={canViewPricing}
    />
  )
}
