import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import Header from '@/components/layout/header'
import { RANGE_PRESETS, resolveReportRange } from '@/lib/finance/report-range'
import { buildDepartmentTrend, buildMix, type MixInput, type MixRow } from '@/lib/finance/department-trend'
import { RevenueMarginChart } from '../_chart-loader'
import { loadDepartmentWindow } from '../_data'
import { ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, Info, TriangleAlert } from 'lucide-react'

// Live financials — always read fresh.
export const dynamic = 'force-dynamic'

const INDEX = '/dashboard/reports/department-growth'

const inr = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const MONTH_LABEL = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', {
    month: 'short', year: '2-digit', timeZone: 'UTC',
  })
}

const signClass = (n: number) =>
  n < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'

export default async function DepartmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ deptId: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || me?.permissions.has('reports.view')
  if (!canView) redirect('/dashboard')

  const { deptId } = await params
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

  const raw = resolveReportRange({ months: one('months'), from: one('from'), to: one('to') })
  const admin = createAdminClient()
  const w = await loadDepartmentWindow(admin, raw)

  const selected = w.departments.find(d => d.id === deptId)
  // A real department with no activity in THIS window is not a 404 — it is an
  // empty period, and the page says so while keeping the window picker usable.
  const known = selected != null || w.labelFor(deptId) !== 'Unknown category'
  if (!known) notFound()

  const label = selected?.label ?? w.labelFor(deptId)
  const trend = buildDepartmentTrend(w.pointsFor(deptId))

  const mine = w.tasks.filter(t => t.departmentId === deptId)
  const myScores = w.scores.filter(s => s.departmentId === deptId)

  const serviceMix = buildMix(mine.map<MixInput>(t => ({
    id: t.serviceId ?? 'none',
    label: t.serviceId ? w.serviceName.get(t.serviceId) ?? 'Unknown service' : 'No service',
    revenueInr: t.billingInr,
    taskCount: 1,
  })))

  const clientMix = buildMix(mine.map<MixInput>(t => ({
    id: t.clientId ?? 'none',
    label: t.clientId ? w.clientName.get(t.clientId) ?? 'Unknown client' : 'No client',
    revenueInr: t.billingInr,
    taskCount: 1,
  })))

  // CQID only — employee names must never render (privacy gate).
  const peopleMix = buildMix(myScores
    .filter(s => s.employeeId)
    .map<MixInput>(s => ({
      id: s.employeeId!,
      label: w.cqidOf.get(s.employeeId!) ?? '—',
      revenueInr: s.earningsInr,          // earnings, not billing
      taskCount: 1,
    })))

  const chartData = trend.rows.map(r => ({
    label: MONTH_LABEL(r.month) + (w.partial.active && r.month === w.partial.month ? '*' : ''),
    revenue: r.revenueInr,
    margin: r.contributionMarginInr,
    marginPct: r.contributionMarginPct,
    tasks: r.taskCount,
  }))

  const measuresDisagree = trend.halfOverHalfPct != null && trend.avgMonthlyGrowthPct != null
    && Math.sign(trend.halfOverHalfPct) !== Math.sign(trend.avgMonthlyGrowthPct)

  return (
    <div className="space-y-6">
      <Header
        title={label}
        subtitle="How this discipline's revenue, margin and mix are moving"
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
          <Link href={`${INDEX}${qs()}`} className="flex items-center gap-1 text-primary hover:underline mr-1">
            <ArrowLeft className="h-3.5 w-3.5" /> All departments
          </Link>
          <span className="text-muted-foreground ml-1">Window:</span>
          {RANGE_PRESETS.filter(m => m >= 3).map(m => (
            <Link
              key={m}
              href={`${INDEX}/${encodeURIComponent(deptId)}?months=${m}`}
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
        </div>

        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted-foreground mr-0.5">Jump to:</span>
          {w.departments.map(d => (
            <Link
              key={d.id}
              href={`${INDEX}/${encodeURIComponent(d.id)}${qs()}`}
              className={`rounded-lg border px-2.5 py-1 ${d.id === deptId
                ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                : 'border-border text-muted-foreground hover:text-foreground'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>

        <form method="GET" action={`${INDEX}/${deptId}`} className="flex items-end gap-2 flex-wrap text-xs">
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
        </form>

        {w.snapped && (
          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 mt-px shrink-0" />
            Widened to whole months ({w.windowStart} → {w.windowEnd}). A part-month bar next to full
            ones always looks like a collapse, so a trend is only shown over complete months.
          </p>
        )}
      </div>

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="Revenue" value={inr(trend.totalRevenueInr)} hint={`${trend.totalTaskCount} tasks`} />
        <Kpi label="Contribution margin" value={inr(trend.totalMarginInr)} hint={`${trend.marginPct}% of revenue`} />
        <GrowthKpi label="Trend (2nd half vs 1st)" value={trend.halfOverHalfPct} hint="Spike-resistant" />
        <GrowthKpi
          label="Latest month"
          value={trend.latestGrowthPct}
          hint={w.partial.active ? `Partial — ${w.partial.daysElapsed}/${w.partial.daysInMonth} days` : 'vs previous month'}
        />
        <GrowthKpi label="Avg monthly growth" value={trend.avgMonthlyGrowthPct} hint="Mean of defined months" />
        <Kpi
          label="Active months"
          value={`${trend.activeMonths} / ${trend.rows.length}`}
          hint={trend.bestMonth ? `Best ${MONTH_LABEL(trend.bestMonth.month)}` : undefined}
        />
      </div>

      {w.partial.active && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm flex items-start gap-2">
          <TriangleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {MONTH_LABEL(w.partial.month)} is still in progress — {w.partial.daysElapsed} of {w.partial.daysInMonth} days.
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Its bar and every growth figure that ends on it are measuring a part-month against full
              ones, so they read low by construction. For a like-for-like read, compare the months
              before it, or wait until the month closes.
            </p>
          </div>
        </div>
      )}

      {measuresDisagree && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm flex items-start gap-2">
          <TriangleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">The two growth measures disagree — read the months, not the headline.</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Average monthly growth is {trend.avgMonthlyGrowthPct}% while the second half against the
              first is {trend.halfOverHalfPct}%. That gap means one month is carrying the average; a
              single spike can do this.
            </p>
          </div>
        </div>
      )}

      {/* ── Chart ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Revenue and margin</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Revenue (indigo) against contribution margin (green), same scale. When the gap between
            them widens faster than the bars grow, the department is getting busier without getting
            more profitable — the Margin % column below is where to confirm it.
          </p>
        </div>
        <div className="px-2 py-4">
          <RevenueMarginChart data={chartData} />
        </div>
      </div>

      {/* ── Monthly table ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Month by month</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Revenue and labour are measured. No overhead is allocated here — this view is about
            movement, and an apportioned cost would move with company revenue, not this department&apos;s.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">Month</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Revenue</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">MoM</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Index</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Direct labour</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Margin</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Margin %</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Tasks</th>
                <th className="text-right px-4 py-2 font-medium whitespace-nowrap">Avg ticket</th>
              </tr>
            </thead>
            <tbody>
              {trend.rows.map(r => {
                const dormant = r.revenueInr === 0 && r.taskCount === 0
                return (
                  <tr key={r.month} className={`border-b border-border/50 ${dormant ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-2.5 font-medium whitespace-nowrap">
                      {MONTH_LABEL(r.month)}
                      {w.partial.active && r.month === w.partial.month && (
                        <span className="ml-1.5 text-[10px] font-normal text-amber-500">in progress</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(r.revenueInr)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                      <GrowthCell value={r.revenueGrowthPct} isNewStart={r.isNewStart} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {r.indexVsStart == null ? '—' : r.indexVsStart}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(r.directLabourInr)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(r.contributionMarginInr)}`}>
                      {inr(r.contributionMarginInr)}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(r.contributionMarginInr)}`}>
                      {r.contributionMarginPct}%
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{r.taskCount}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{inr(r.avgTicketInr)}</td>
                  </tr>
                )
              })}
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-4 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(trend.totalRevenueInr)}</td>
                <td colSpan={2} />
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(trend.totalLabourInr)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(trend.totalMarginInr)}`}>
                  {inr(trend.totalMarginInr)}
                </td>
                <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(trend.totalMarginInr)}`}>
                  {trend.marginPct}%
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{trend.totalTaskCount}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Mix ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <MixPanel title="Services" subtitle="What this department actually sells" rows={serviceMix} valueLabel="revenue" />
        <MixPanel title="Clients" subtitle="Who buys it — concentration risk lives here" rows={clientMix} valueLabel="revenue" />
        <MixPanel title="People" subtitle="Who does the work (contribution earnings)" rows={peopleMix} valueLabel="earned" />
      </div>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** A growth KPI that says "not enough history" instead of showing a false 0%. */
function GrowthKpi({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  const tone = value == null ? '' : value > 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : value < 0 ? 'text-red-500' : ''
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums flex items-center gap-1 ${tone}`}>
        {value == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            {value > 0 ? <ArrowUpRight className="h-4 w-4" />
              : value < 0 ? <ArrowDownRight className="h-4 w-4" />
              : <ArrowRight className="h-4 w-4" />}
            {value > 0 ? '+' : ''}{value}%
          </>
        )}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {value == null ? 'Not enough history' : hint}
      </div>
    </div>
  )
}

function GrowthCell({ value, isNewStart }: { value: number | null; isNewStart: boolean }) {
  if (isNewStart) {
    return <span className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">new</span>
  }
  if (value == null) return <span className="text-muted-foreground/40">—</span>
  return (
    <span className={value > 0 ? 'text-emerald-600 dark:text-emerald-400' : value < 0 ? 'text-red-500' : 'text-muted-foreground'}>
      {value > 0 ? '+' : ''}{value}%
    </span>
  )
}

function MixPanel({ title, subtitle, rows, valueLabel }: {
  title: string; subtitle: string; rows: MixRow[]; valueLabel: string
}) {
  const top = rows.slice(0, 8)
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      {top.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Nothing in this window.</p>
      ) : (
        <div className="divide-y divide-border">
          {top.map(r => (
            <div key={r.id} className="px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm truncate">{r.label}</span>
                <span className="text-sm tabular-nums whitespace-nowrap">{inr(r.revenueInr)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, r.sharePct)}%` }} />
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums w-20 text-right">
                  {r.sharePct}% · {r.taskCount}
                </span>
              </div>
            </div>
          ))}
          {rows.length > top.length && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              + {rows.length - top.length} more by {valueLabel}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
