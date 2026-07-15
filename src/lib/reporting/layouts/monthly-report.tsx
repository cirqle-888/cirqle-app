/**
 * Shared "Meta Ads Monthly Report" layout (Satori / next-og JSX).
 *
 * Same branded visual system as `daily-report.tsx` — identical hero, header,
 * footer, page chrome — but the day-by-day performance table becomes a
 * month-by-month rollup, for campaigns long enough that a per-day table stops
 * being useful.
 */

import React from 'react'
import type { RenderData } from '../types'
import { computeDailyRows, type DailyRowWithBalance } from './daily-report'
import {
  PURPLE, NAVY, INK, GREY_PILL, RED_PILL, SAFE_AREA,
  PageChrome, CirqleLogo, MetaLogo, MetaLine, KpiCircle, KpiDivider, Pill, TableRow,
  capitalize, longDate, num, money, monthLabel, truncate, computeCampaignMeta,
} from './shared'
import { AD_SPEND_GST_RATE } from '@/lib/advertising/budget'

export interface MonthlyRowWithBalance {
  date: string       // "YYYY-MM" — the month key, doubling as the row's identity/sort field
  monthLabel: string  // "Feb 2026"
  spend: number; gstAmount: number; actualCost: number
  reach: number; impressions: number; clicks: number; leads: number; revenue: number
  roas: number; ctr: number; cpr: number
  balance: number      // terminal remainingAllocation as of the last day in that month
  days: number         // count of daily rows folded in
}

function sum(rows: DailyRowWithBalance[], pick: (r: DailyRowWithBalance) => number): number {
  return rows.reduce((total, r) => total + pick(r), 0)
}

/**
 * Groups the full chronological daily series (see `computeDailyRows`) into
 * calendar months. `roas`/`ctr`/`cpr` are RECOMPUTED as ratio-of-sums for the
 * month, never averaged from the daily ratios — matching how
 * `aggregateMetrics` in `lib/advertising/reporting.ts` treats these metrics
 * everywhere else in the app (averaging daily ratios would double-count
 * low-spend days). `balance` is the terminal (last-day) running balance for
 * that month, not summed.
 */
export function computeMonthlyRows(data: RenderData): MonthlyRowWithBalance[] {
  const daily = computeDailyRows(data)
  const groups = new Map<string, DailyRowWithBalance[]>()
  for (const row of daily) {
    const key = row.date.slice(0, 7) // "YYYY-MM" — TZ-free string slice
    const existing = groups.get(key)
    if (existing) existing.push(row)
    else groups.set(key, [row])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const spend = sum(rows, r => r.spend)
      const gstAmount = sum(rows, r => r.gstAmount)
      const actualCost = sum(rows, r => r.actualCost)
      const reach = sum(rows, r => r.reach)
      const impressions = sum(rows, r => r.impressions)
      const clicks = sum(rows, r => r.clicks)
      const leads = sum(rows, r => r.leads)
      const revenue = sum(rows, r => r.revenue)
      return {
        date: key,
        monthLabel: monthLabel(key),
        spend, gstAmount, actualCost, reach, impressions, clicks, leads, revenue,
        roas: spend > 0 ? revenue / spend : 0,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        cpr: (leads || clicks) > 0 ? spend / (leads || clicks) : 0,
        balance: rows[rows.length - 1].balance,
        days: rows.length,
      }
    })
}

/** One monthly row's formatted table cells — shared by the page layout and
 * the standalone row builder so the measured row can never drift from the
 * rendered one. */
function monthlyRowCells(r: MonthlyRowWithBalance): string[] {
  return [
    r.monthLabel,
    `₹${money(r.spend)}`,
    `₹${money(r.gstAmount)}`,
    num(r.reach),
    num(r.impressions),
    `₹${money(r.cpr)}`,
    `₹${money(r.balance)}`,
  ]
}

/** A single data row rendered standalone — measured by the PDF exporter (via
 * `measureElementHeight` at the page's real content width) to derive the
 * report's true per-page row capacity instead of assuming a fixed row height. */
export function buildMonthlyRowElement(row: MonthlyRowWithBalance, s: number) {
  return <TableRow s={s} cells={monthlyRowCells(row)} />
}

export interface LayoutOpts {
  width: number
  height: number
  maxRows?: number
  rows?: MonthlyRowWithBalance[]
  continuation?: boolean
  tableHeading?: string
  /** Chrome-measurement mode — see `LayoutOpts.probe` in daily-report.tsx. */
  probe?: boolean
}

export function buildMonthlyReportElement(data: RenderData, opts: LayoutOpts) {
  const { width, height, maxRows = 5, rows, continuation = false, tableHeading, probe = false } = opts
  const s = width / 1080

  const { brand, project, kpi } = data
  const p = kpi.primary
  const d = kpi.derived

  const platform = (project.platform || 'meta').toLowerCase()
  const isMeta = ['meta', 'facebook', 'instagram'].includes(platform)
  const platformLabel = capitalize(project.platform || 'Meta')

  const reportDate = longDate(data.config.dateTo)
  const { periodLabel, expectedBudget, budgetPlanDays, dailyBudget, remainingDays } = computeCampaignMeta(data)

  const tableRows = rows ?? computeMonthlyRows(data).slice(-maxRows).reverse()

  return (
    <div
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        width: `${width}px`, ...(probe ? {} : { height: `${height}px` }), background: '#FFFFFF',
        fontFamily: 'sans-serif', color: INK, boxSizing: 'border-box', overflow: 'hidden',
      }}
    >
      {probe ? null : <PageChrome s={s} width={width} height={height} brand={brand} />}

      <div
        style={{
          position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1,
          padding: `${SAFE_AREA.top * s}px ${SAFE_AREA.right * s}px ${SAFE_AREA.bottom * s}px ${SAFE_AREA.left * s}px`,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: `${10 * s}px` }}>
          <div style={{ display: 'flex', flexShrink: 0 }}><CirqleLogo s={s} brand={brand} /></div>
          <div style={{ display: 'flex', fontSize: `${30 * s}px`, fontWeight: 700, color: INK, flexShrink: 0 }}>
            {reportDate}
          </div>
          {isMeta ? <MetaLogo s={s} /> : (
            <div style={{ display: 'flex', fontSize: `${34 * s}px`, fontWeight: 800, color: NAVY, flexShrink: 0, wordBreak: 'break-word', maxWidth: `${300 * s}px` }}>
              {truncate(platformLabel, 24)}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', height: `${2 * s}px`, background: '#E5E7EB', marginBottom: `${28 * s}px` }} />

        <div style={{
          display: 'flex', justifyContent: 'center', textAlign: 'center',
          fontSize: `${(continuation ? 44 : 64) * s}px`, fontWeight: 900, color: INK,
          letterSpacing: `${-1 * s}px`, marginBottom: `${22 * s}px`, wordBreak: 'break-word',
        }}>
          {platformLabel} Ads Monthly Report{continuation ? ' — continued' : ''}
        </div>

        {continuation ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${16 * s}px` }}>
            <MetaLine s={s} pairs={[['Client', project.clientName], ['Campaign', project.campaignName], ['Period', periodLabel]]} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${6 * s}px`, marginBottom: `${30 * s}px` }}>
              <MetaLine s={s} pairs={[['Client', project.clientName], ['Campaign', project.campaignName]]} />
              <MetaLine s={s} pairs={[['Campaign Period', periodLabel], ['Campaign Plan', `${budgetPlanDays} Days`]]} />
              <MetaLine s={s} pairs={[['Daily Budget', `₹${money(dailyBudget)}`], ['Expected Budget', `₹${num(expectedBudget)}`]]} />
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', marginBottom: `${30 * s}px` }}>
              <KpiCircle s={s} label="Reach"       value={num(p.reach)}        grad={['#8B5CF6', '#6D28D9']} icon="users" />
              <KpiDivider s={s} />
              <KpiCircle s={s} label="Impressions" value={num(p.impressions)}  grad={['#6366F1', '#4F46E5']} icon="eye" />
              <KpiDivider s={s} />
              <KpiCircle s={s} label="Clicks"      value={num(p.clicks)}       grad={['#22B8F2', '#2563EB']} icon="cursor" />
              <KpiDivider s={s} />
              <KpiCircle s={s} label="Meta Spend"  value={`₹${money(d.actualCost)}`} grad={['#A855F7', '#7C3AED']} icon="rupee" />
              <KpiDivider s={s} />
              <KpiCircle s={s} label="CPR"         value={`₹${money(d.costPerResult)}`} grad={['#FB923C', '#EF4444']} icon="percent" />
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', gap: `${20 * s}px`, marginBottom: `${36 * s}px`, flexWrap: 'wrap' }}>
              <Pill s={s} bg={RED_PILL}  label="Total Remaining Amount" value={`₹${money(project.walletAllocation - (p.spend * (1 + AD_SPEND_GST_RATE)))}`} />
              <Pill s={s} bg={GREY_PILL} label="Remaining Days" value={`${remainingDays} Days`} />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', fontSize: `${30 * s}px`, fontWeight: 800, color: INK,
            borderBottom: `${3 * s}px solid ${PURPLE}`, paddingBottom: `${8 * s}px`, marginBottom: `${16 * s}px`,
          }}>
            <span style={{ display: 'flex', flexShrink: 0 }}>{tableHeading ?? `Last ${tableRows.length} Months Performance`}</span>
            <span style={{
              display: 'flex', marginLeft: `${12 * s}px`, fontSize: `${22 * s}px`, fontWeight: 500, color: '#6B7280',
              wordBreak: 'break-word', maxWidth: `${520 * s}px`,
            }}>
              ({truncate(project.campaignName, 60)})
            </span>
          </div>

          <TableRow s={s} cells={['Month', 'Meta Spend', 'GST', 'Reach', 'Impressions', 'CPR', 'Remaining Amount']} header />
          {tableRows.length === 0 ? (
            probe ? null : <div style={{ display: 'flex', padding: `${24 * s}px`, color: '#9CA3AF', fontSize: `${22 * s}px` }}>
              No monthly metrics recorded for this period.
            </div>
          ) : tableRows.map((r, i) => (
            <TableRow
              key={r.date}
              s={s}
              zebra={i % 2 === 1}
              last={i === tableRows.length - 1}
              cells={monthlyRowCells(r)}
            />
          ))}
        </div>

        <div style={{
          display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end',
          marginTop: `${20 * s}px`, paddingTop: `${20 * s}px`, borderTop: `${2 * s}px solid #E5E7EB`,
          fontSize: `${20 * s}px`, color: '#6B7280',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: `${400 * s}px` }}>
            <div style={{ display: 'flex', fontWeight: 800, color: PURPLE, fontSize: `${24 * s}px`, wordBreak: 'break-word' }}>
              {truncate(brand.agencyName, 40)}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: `${400 * s}px` }}>
            {brand.contactPhone && <div style={{ display: 'flex', wordBreak: 'break-word' }}>{brand.contactPhone}</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: `${4 * s}px` }}>
              <span style={{ display: 'flex', wordBreak: 'break-word' }}>
                {(brand.contactWebsite ?? 'www.cirqle.work').replace(/^https?:\/\//, '')}
              </span>
              {brand.contactEmail ? <span style={{ display: 'flex', wordBreak: 'break-word' }}>{`  |  ${brand.contactEmail}`}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
