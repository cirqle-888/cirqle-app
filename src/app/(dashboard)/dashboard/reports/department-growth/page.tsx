import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import Header from '@/components/layout/header'
import { RANGE_PRESETS, resolveReportRange } from '@/lib/finance/report-range'
import { buildDepartmentTrend } from '@/lib/finance/department-trend'
import { Sparkline } from './_chart-loader'
import { loadDepartmentWindow } from './_data'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Info, TriangleAlert } from 'lucide-react'

// Live financials — always read fresh.
export const dynamic = 'force-dynamic'

const ROUTE = '/dashboard/reports/department-growth'

const inr = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

const MONTH_LABEL = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', {
    month: 'short', year: '2-digit', timeZone: 'UTC',
  })
}

export default async function DepartmentCardsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || me?.permissions.has('reports.view')
  if (!canView) redirect('/dashboard')

  const sp = searchParams ? await searchParams : undefined
  const one = (k: string) => {
    const v = sp?.[k]
    return Array.isArray(v) ? v[0] : v
  }

  const qs = (extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ months: one('months'), from: one('from'), to: one('to'), ...extra })) {
      if (v) p.set(k, v)
    }
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  // A ?dept= link from before departments had their own routes — send it there.
  const legacyDept = one('dept')
  if (legacyDept) redirect(`${ROUTE}/${encodeURIComponent(legacyDept)}${qs({ dept: undefined })}`)

  const raw = resolveReportRange({ months: one('months'), from: one('from'), to: one('to') })
  const admin = createAdminClient()
  const w = await loadDepartmentWindow(admin, raw)

  const cards = w.departments.map(d => {
    const trend = buildDepartmentTrend(w.pointsFor(d.id))
    return {
      ...d,
      trend,
      spark: trend.rows.map(r => ({ label: MONTH_LABEL(r.month), revenue: r.revenueInr })),
    }
  })

  const totalRevenue = cards.reduce((s, c) => s + c.trend.totalRevenueInr, 0)
  const totalMargin = cards.reduce((s, c) => s + c.trend.totalMarginInr, 0)
  const totalTasks = cards.reduce((s, c) => s + c.trend.totalTaskCount, 0)

  return (
    <div className="space-y-6">
      <Header
        title="Departments"
        subtitle="One card per discipline — open any of them for its full growth analysis"
      />

      {w.readFailed && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm flex items-start gap-2">
          <TriangleAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-red-500">Partial read — figures below are incomplete.</p>
            <p className="text-xs text-muted-foreground mt-0.5">Reload before relying on these numbers.</p>
          </div>
        </div>
      )}

      {/* ── Controls ── */}
      <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-3">
        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted-foreground mr-0.5">Window:</span>
          {RANGE_PRESETS.filter(m => m >= 3).map(m => (
            <Link
              key={m}
              href={`${ROUTE}?months=${m}`}
              className={`rounded-lg border px-2.5 py-1 ${raw.presetMonths === m
                ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                : 'border-border text-muted-foreground hover:text-foreground'}`}
            >
              {m} months
            </Link>
          ))}
          <span className="font-medium ml-1">
            {MONTH_LABEL(w.months[0])} – {MONTH_LABEL(w.months[w.months.length - 1])}
          </span>
          <Link href="/dashboard/reports/department-pnl" className="ml-auto text-primary hover:underline">
            Comparison table →
          </Link>
        </div>

        <form method="GET" action={ROUTE} className="flex items-end gap-2 flex-wrap text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Custom from</span>
            <input type="date" name="from" defaultValue={w.windowStart}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-foreground" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">to</span>
            <input type="date" name="to" defaultValue={w.windowEnd}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-foreground" />
          </label>
          <button type="submit"
            className="rounded-lg border border-primary/40 bg-primary/10 text-primary font-medium px-3 py-1.5 hover:bg-primary/20">
            Apply
          </button>
          <span className="text-muted-foreground ml-1">
            {cards.length} departments · {totalTasks.toLocaleString('en-IN')} tasks ·{' '}
            {inr(totalRevenue)} revenue · {inr(totalMargin)} margin
          </span>
        </form>

        {w.snapped && (
          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 mt-px shrink-0" />
            Widened to whole months ({w.windowStart} → {w.windowEnd}) — a part-month bar next to full
            ones always looks like a collapse.
          </p>
        )}
      </div>

      {w.partial.active && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm flex items-start gap-2">
          <TriangleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {MONTH_LABEL(w.partial.month)} is still in progress — {w.partial.daysElapsed} of {w.partial.daysInMonth} days.
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every &ldquo;latest month&rdquo; figure on these cards compares a part-month against a full
              one, so it reads low by construction.
            </p>
          </div>
        </div>
      )}

      {/* ── Cards ── */}
      {cards.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          No tasks in this window.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map(c => {
            const t = c.trend
            const growing = (t.halfOverHalfPct ?? 0) >= 0
            const share = totalRevenue > 0 ? Math.round((c.revenueInr / totalRevenue) * 1000) / 10 : 0
            return (
              <Link
                key={c.id}
                href={`${ROUTE}/${encodeURIComponent(c.id)}${qs()}`}
                className="group rounded-xl border border-border bg-card overflow-hidden hover:border-primary/40 transition-colors flex flex-col"
              >
                <div className="px-4 pt-3.5 pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                        {c.label}
                      </h2>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t.totalTaskCount.toLocaleString('en-IN')} tasks · {share}% of revenue
                      </p>
                    </div>
                    <TrendBadge value={t.halfOverHalfPct} />
                  </div>

                  <div className="mt-3 flex items-baseline justify-between gap-2">
                    <div>
                      <div className="text-lg font-semibold tabular-nums">{inr(t.totalRevenueInr)}</div>
                      <div className="text-[10px] text-muted-foreground">Revenue</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {inr(t.totalMarginInr)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">Margin · {t.marginPct}%</div>
                    </div>
                  </div>
                </div>

                <div className="px-1 pb-1">
                  <Sparkline data={c.spark} id={c.id} positive={growing} />
                </div>

                <div className="border-t border-border px-4 py-2 grid grid-cols-3 gap-2 text-[11px] mt-auto">
                  <MiniStat label="Latest" value={t.latestGrowthPct} />
                  <MiniStat label="Avg/mo" value={t.avgMonthlyGrowthPct} />
                  <div>
                    <div className="text-muted-foreground">Active</div>
                    <div className="font-medium tabular-nums">{t.activeMonths}/{t.rows.length} mo</div>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TrendBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="rounded-lg border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground whitespace-nowrap">
        no history
      </span>
    )
  }
  const up = value > 0
  const flat = value === 0
  return (
    <span className={`rounded-lg border px-1.5 py-0.5 text-[10px] font-medium tabular-nums whitespace-nowrap flex items-center gap-0.5 ${
      flat ? 'border-border text-muted-foreground'
        : up ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        : 'border-red-500/40 bg-red-500/10 text-red-500'}`}>
      {flat ? <ArrowRight className="h-3 w-3" />
        : up ? <ArrowUpRight className="h-3 w-3" />
        : <ArrowDownRight className="h-3 w-3" />}
      {up ? '+' : ''}{value}%
    </span>
  )
}

function MiniStat({ label, value }: { label: string; value: number | null }) {
  const tone = value == null ? 'text-muted-foreground'
    : value > 0 ? 'text-emerald-600 dark:text-emerald-400'
    : value < 0 ? 'text-red-500' : ''
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={`font-medium tabular-nums ${tone}`}>
        {value == null ? '—' : `${value > 0 ? '+' : ''}${value}%`}
      </div>
    </div>
  )
}
