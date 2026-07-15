/**
 * Shared "Meta Ads Daily Report" layout (Satori / next-og JSX).
 *
 * Single source of truth for the branded daily report. Rendered to PNG by the
 * image exporter (WhatsApp story / square) and embedded full-page into the PDF
 * exporter — so the image and the PDF look pixel-identical.
 *
 * Layout primitives, brand tokens and formatters live in `./shared` and are
 * shared with `monthly-report.tsx` and `report-cards.tsx` so every template
 * renders through the same visual system.
 *
 * Satori notes honoured here:
 *   • Every element with >1 child sets an explicit `display: 'flex'`.
 *   • Colours use CSS gradients (well supported); inline SVG uses solid fills.
 *   • Sizes scale off `width` via the `s` factor so one layout serves
 *     1080-wide images and ~1240-wide A4 PDF renders.
 */

import React from 'react'
import type { RenderData, DailySeriesPoint } from '../types'
import { AD_SPEND_GST_RATE } from '@/lib/advertising/budget'
import {
  PURPLE, NAVY, INK, GREY_PILL, RED_PILL, SAFE_AREA,
  PageChrome, CirqleLogo, MetaLogo, MetaLine, KpiCircle, KpiDivider, Pill, TableRow,
  capitalize, longDate, ddmmyyyy, num, money, truncate, computeCampaignMeta,
} from './shared'

export type DailyRowWithBalance = DailySeriesPoint & { balance: number; actualCost: number; gstAmount: number }

/**
 * Computes the full chronological (oldest → newest) daily performance series
 * with a running "remaining allocation" against the campaign's wallet allocation.
 *
 * `kpi.dailySeries` is sorted newest-first (see kpi-engine.ts), so it's sorted
 * into true ascending date order here before accumulating — the running
 * balance only comes out correct when each day's spend is added in the order
 * it actually happened. Getting this backwards silently attaches the wrong
 * balance to the wrong date (e.g. the most recent day showing a HIGHER
 * remaining balance than an earlier day).
 */
export function computeDailyRows(data: RenderData): DailyRowWithBalance[] {
  const { project, kpi } = data
  let cumulativeCost = 0
  // Fixed platform GST rate — independent of the project's own invoice tax_percent.
  return [...kpi.dailySeries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(row => {
      const gstAmount = row.spend * AD_SPEND_GST_RATE
      const actualCost = row.spend + gstAmount
      cumulativeCost += actualCost
      return { ...row, actualCost, gstAmount, balance: project.walletAllocation - cumulativeCost }
    })
}

/** One daily row's formatted table cells — shared by the page layout and the
 * standalone row builder so the measured row can never drift from the
 * rendered one. */
function dailyRowCells(r: DailyRowWithBalance): string[] {
  return [
    ddmmyyyy(r.date),
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
export function buildDailyRowElement(row: DailyRowWithBalance, s: number) {
  return <TableRow s={s} cells={dailyRowCells(row)} />
}

export interface LayoutOpts {
  width: number
  height: number
  /** Max rows in the performance table when `rows` isn't provided (default 5). Used for single-image exports, which show only the most recent days. */
  maxRows?: number
  /** Explicit rows to render, already sliced/ordered — used to paginate the full campaign history across multiple PDF pages instead of capping to `maxRows`. */
  rows?: DailyRowWithBalance[]
  /** Continuation page: omits the KPI circles and budget pills (shown on page 1), keeping header, compact campaign meta, table and footer so every page stays on-brand. */
  continuation?: boolean
  /** Overrides the default "Last N Days Performance" table heading. */
  tableHeading?: string
  /** Overrides the default "{Platform} Ads Daily Report" title — used when this
   * layout's continuation-page shape (header/compact-meta/table/footer) is
   * reused as the trailing "Daily Breakdown" pages of a cards-style template,
   * so the title reads e.g. "Performance Report — Daily Breakdown" instead of
   * "Meta Ads Daily Report — continued". */
  titleOverride?: string
  /** Chrome-measurement mode: renders the identical page chrome (header,
   * title, meta, table heading + header row, footer) WITHOUT the fixed page
   * height, decorative background, or any data rows — so `measureElementHeight`
   * returns the real chrome height for this report's actual (possibly
   * wrapped) names. Row capacity derives from this instead of fixed
   * estimates, which under-counted whenever a long client/campaign/agency
   * name wrapped onto extra lines. Pass with `rows: []`. */
  probe?: boolean
}

/**
 * Builds the daily-report JSX element for ImageResponse.
 */
export function buildDailyReportElement(data: RenderData, opts: LayoutOpts) {
  const { width, height, maxRows = 5, rows, continuation = false, tableHeading, titleOverride, probe = false } = opts
  const s = width / 1080 // uniform scale factor

  const { brand, project, kpi } = data
  const p = kpi.primary
  const d = kpi.derived

  // ── Platform / branding ──────────────────────────────────────────────────
  const platform = (project.platform || 'meta').toLowerCase()
  const isMeta = ['meta', 'facebook', 'instagram'].includes(platform)
  const platformLabel = capitalize(project.platform || 'Meta')

  // ── Dates ────────────────────────────────────────────────────────────────
  const reportDate = longDate(data.config.dateTo)
  const { periodLabel, expectedBudget, budgetPlanDays, dailyBudget, remainingDays } = computeCampaignMeta(data)

  // ── Performance table rows: explicit slice (pagination) or default last-N newest-first
  const tableRows = rows ?? computeDailyRows(data).slice(-maxRows).reverse()

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: `${width}px`,
        ...(probe ? {} : { height: `${height}px` }),
        background: '#FFFFFF',
        fontFamily: 'sans-serif',
        color: INK,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* Decorative swooshes or custom images — full-bleed behind the content */}
      {probe ? null : <PageChrome s={s} width={width} height={height} brand={brand} />}

      {/* Content wrapper carries the page padding so the backgrounds stay edge-to-edge */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          padding: `${SAFE_AREA.top * s}px ${SAFE_AREA.right * s}px ${SAFE_AREA.bottom * s}px ${SAFE_AREA.left * s}px`,
          boxSizing: 'border-box',
        }}
      >
      {/* ── Header: Cirqle logo · date · platform logo ── */}
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

      {/* ── Title ── */}
      <div style={{
        display: 'flex', justifyContent: 'center', textAlign: 'center',
        fontSize: `${(continuation ? 44 : 64) * s}px`, fontWeight: 900, color: INK,
        letterSpacing: `${-1 * s}px`, marginBottom: `${22 * s}px`, wordBreak: 'break-word',
      }}>
        {titleOverride ?? `${platformLabel} Ads Daily Report${continuation ? ' — continued' : ''}`}
      </div>

      {/* ── Campaign meta ── (Satori: no fragments — hero blocks live in ONE
           explicit flex column, otherwise their children lay out in a row) */}
      {continuation ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${16 * s}px` }}>
          <MetaLine s={s} pairs={[['Client', project.clientName], ['Campaign', project.campaignName], ['Period', periodLabel]]} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Centered key:value pairs */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${6 * s}px`, marginBottom: `${30 * s}px` }}>
            <MetaLine s={s} pairs={[['Client', project.clientName], ['Campaign', project.campaignName]]} />
            <MetaLine s={s} pairs={[['Campaign Period', periodLabel], ['Campaign Plan', `${budgetPlanDays} Days`]]} />
            <MetaLine s={s} pairs={[['Daily Budget', `₹${money(dailyBudget)}`], ['Expected Budget', `₹${num(expectedBudget)}`]]} />
          </div>

          {/* Performance KPI circle row */}
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

          {/* Financial summary pills */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: `${20 * s}px`, marginBottom: `${36 * s}px`, flexWrap: 'wrap' }}>
            <Pill s={s} bg={RED_PILL}  label="Total Remaining Amount" value={`₹${money(project.walletAllocation - (p.spend * (1 + AD_SPEND_GST_RATE)))}`} />
            <Pill s={s} bg={GREY_PILL} label="Remaining Days" value={`${remainingDays} Days`} />
          </div>
        </div>
      )}

      {/* ── Performance table ── */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', fontSize: `${30 * s}px`, fontWeight: 800, color: INK,
          borderBottom: `${3 * s}px solid ${PURPLE}`, paddingBottom: `${8 * s}px`, marginBottom: `${16 * s}px`,
        }}>
          <span style={{ display: 'flex', flexShrink: 0 }}>{tableHeading ?? `Last ${tableRows.length} Days Performance`}</span>
          <span style={{
            display: 'flex', marginLeft: `${12 * s}px`, fontSize: `${22 * s}px`, fontWeight: 500, color: '#6B7280',
            wordBreak: 'break-word', maxWidth: `${520 * s}px`,
          }}>
            ({truncate(project.campaignName, 60)})
          </span>
        </div>

        {/* Header row */}
        <TableRow s={s} cells={['Date', 'Meta Spend', 'GST', 'Reach', 'Impressions', 'CPR', 'Remaining Amount']} header />
        {tableRows.length === 0 ? (
          probe ? null : <div style={{ display: 'flex', padding: `${24 * s}px`, color: '#9CA3AF', fontSize: `${22 * s}px` }}>
            No daily metrics recorded for this period.
          </div>
        ) : tableRows.map((r, i) => (
          <TableRow
            key={r.date}
            s={s}
            zebra={i % 2 === 1}
            last={i === tableRows.length - 1}
            cells={dailyRowCells(r)}
          />
        ))}
      </div>

      {/* ── Footer ── */}
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
          {brand.contactPhone  && <div style={{ display: 'flex', wordBreak: 'break-word' }}>{brand.contactPhone}</div>}
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
