/**
 * Shared "Meta Ads Daily Report" layout (Satori / next-og JSX).
 *
 * Single source of truth for the branded daily report. Rendered to PNG by the
 * image exporter (WhatsApp story / square) and embedded full-page into the PDF
 * exporter — so the image and the PDF look pixel-identical.
 *
 * Satori notes honoured here:
 *   • Every element with >1 child sets an explicit `display: 'flex'`.
 *   • Colours use CSS gradients (well supported); inline SVG uses solid fills.
 *   • Sizes scale off `width` via the `s` factor so one layout serves
 *     1080-wide images and ~1240-wide A4 PDF renders.
 */

/* eslint-disable @next/next/no-img-element */
import React from 'react'
import type { RenderData, DailySeriesPoint } from '../types'
import { META_LOGO_DATA_URI } from './meta-logo'

// ─── Brand tokens ───────────────────────────────────────────────────────────
const PURPLE   = '#6D28D9'
const PURPLE_D = '#5B21B6'
const NAVY      = '#1E1B4B'
const INK       = '#111827'
const GREY_PILL = '#4B5563'
const RED_PILL  = '#EF4444'

export type DailyRowWithBalance = DailySeriesPoint & { balance: number; actualCost: number; gstAmount: number }

/**
 * Computes the full chronological (oldest → newest) daily performance series
 * with a running "remaining allocation" against the campaign's wallet allocation.
 */
export function computeDailyRows(data: RenderData): DailyRowWithBalance[] {
  const { project, kpi } = data
  let cumulativeCost = 0
  const taxPercent = project.taxPercent || 18
  return kpi.dailySeries.map(row => {
    const gstAmount = row.spend * (taxPercent / 100)
    const actualCost = row.spend + gstAmount
    cumulativeCost += actualCost
    return { ...row, actualCost, gstAmount, balance: project.walletAllocation - cumulativeCost }
  })
}

interface LayoutOpts {
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
}

/**
 * How many table rows fit on a page without clipping, derived from the same
 * vertical measurements the layout uses (all in 1080-width design units, so
 * the result is resolution-independent). Keep in sync with the JSX below.
 */
export function dailyReportRowCapacity(opts: { width: number; height: number; continuation?: boolean }): number {
  const unitsHigh = opts.height / (opts.width / 1080) // page height in design units
  const PAD    = 128 // content wrapper 64 top + 64 bottom
  const HEADER = 84  // logo box 64 + 10 margin, + divider spacing overlap
  const DIVIDE = 30  // 2px rule + 28 margin
  const FOOTER = 100 // marginTop 20 + paddingTop 20 + two ~29/24 text lines
  const HEADING = 63 // table heading 30×1.2 + 8 pad + 3 border + 16 margin
  const THEAD  = 51  // header row: 13×2 padding + 21×1.2 text
  const ROW_H  = 51
  const hero = opts.continuation
    ? 75 + 45           // smaller title (44×1.2 + 22 margin) + compact meta line
    : 99 + 129 + 192 + 93 // title + 3 meta lines + KPI circles + pills (incl. margins)
  const fixed = PAD + HEADER + DIVIDE + hero + HEADING + THEAD + FOOTER
  return Math.max(1, Math.floor((unitsHigh - fixed - 10) / ROW_H)) // −10 safety
}

/**
 * Builds the daily-report JSX element for ImageResponse.
 */
export function buildDailyReportElement(data: RenderData, opts: LayoutOpts) {
  const { width, height, maxRows = 5, rows, continuation = false, tableHeading } = opts
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
  const startDate = project.startDate ?? data.config.dateFrom
  const endDate   = project.endDate   ?? data.config.dateTo
  // Campaign plan length uses the end−start convention (e.g. 07→20 Feb = 13 days),
  // matching the established Cirqle daily-report template and its daily-budget math.
  const planDays  = Math.max(
    1,
    Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000),
  )
  const periodLabel = `${shortDate(startDate)} - ${shortDate(endDate)}`
  const reportTaxMult = 1 + ((project.taxPercent || 18) / 100)
  const expectedBudgetIncGst = project.adBudget * reportTaxMult
  const dailyBudget = expectedBudgetIncGst > 0 ? expectedBudgetIncGst / planDays : 0
  const remainingDays = Math.max(
    0,
    Math.round((new Date(endDate).getTime() - Date.now()) / 86400000),
  )

  // ── Performance table rows: explicit slice (pagination) or default last-N newest-first
  const tableRows = rows ?? computeDailyRows(data).slice(-maxRows).reverse()

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: `${width}px`,
        height: `${height}px`,
        background: '#FFFFFF',
        fontFamily: 'sans-serif',
        color: INK,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* Decorative swooshes or custom images — full-bleed behind the content */}
      {(brand.backgroundDesign === 'custom_images' || brand.backgroundDesign === 'Custom Images') ? (
        // Full-page overlay: top image pinned to the top edge, bottom image to
        // the bottom edge (space-between is reliable in Satori, unlike bottom:0).
        <div style={{
          position: 'absolute', top: 0, left: 0,
          width: `${width}px`, height: `${height}px`,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', width: `${width}px` }}>
            {brand.bgImageTopUrl ? <img src={brand.bgImageTopUrl} width={width} style={{ width: `${width}px` }} alt="" /> : null}
          </div>
          <div style={{ display: 'flex', width: `${width}px` }}>
            {brand.bgImageBottomUrl ? <img src={brand.bgImageBottomUrl} width={width} style={{ width: `${width}px` }} alt="" /> : null}
          </div>
        </div>
      ) : (
        <>
          <Swoosh position="top" s={s} width={width} />
          <Swoosh position="bottom" s={s} width={width} />
        </>
      )}

      {/* Content wrapper carries the page padding so the backgrounds stay edge-to-edge */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          padding: `${64 * s}px ${56 * s}px`,
          boxSizing: 'border-box',
        }}
      >
      {/* ── Header: Cirqle logo · date · platform logo ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: `${10 * s}px` }}>
        <CirqleLogo s={s} brand={brand} />
        <div style={{ display: 'flex', fontSize: `${30 * s}px`, fontWeight: 700, color: INK }}>
          {reportDate}
        </div>
        {isMeta ? <MetaLogo s={s} /> : (
          <div style={{ display: 'flex', fontSize: `${34 * s}px`, fontWeight: 800, color: NAVY }}>{platformLabel}</div>
        )}
      </div>

      <div style={{ display: 'flex', height: `${2 * s}px`, background: '#E5E7EB', marginBottom: `${28 * s}px` }} />

      {/* ── Title ── */}
      <div style={{
        display: 'flex', justifyContent: 'center',
        fontSize: `${(continuation ? 44 : 64) * s}px`, fontWeight: 900, color: INK,
        letterSpacing: `${-1 * s}px`, marginBottom: `${22 * s}px`,
      }}>
        {platformLabel} Ads Daily Report{continuation ? ' — continued' : ''}
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
            <MetaLine s={s} pairs={[['Campaign Period', periodLabel], ['Campaign Plan', `${planDays} Days`]]} />
            <MetaLine s={s} pairs={[['Daily Budget', `₹${money(dailyBudget)}`], ['Expected Budget', `₹${num(expectedBudgetIncGst)}`]]} />
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
            <Pill s={s} bg={RED_PILL}  label="Total Remaining Amount" value={`₹${money(project.walletAllocation - (p.spend * (1 + (project.taxPercent || 0) / 100)))}`} />
            <Pill s={s} bg={GREY_PILL} label="Remaining Days" value={`${remainingDays} Days`} />
          </div>
        </div>
      )}

      {/* ── Performance table ── */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{
          display: 'flex', fontSize: `${30 * s}px`, fontWeight: 800, color: INK,
          borderBottom: `${3 * s}px solid ${PURPLE}`, paddingBottom: `${8 * s}px`, marginBottom: `${16 * s}px`,
        }}>
          {tableHeading ?? `Last ${tableRows.length} Days Performance`}
          <span style={{ display: 'flex', marginLeft: `${12 * s}px`, fontSize: `${22 * s}px`, fontWeight: 500, color: '#6B7280' }}>
            ({project.campaignName})
          </span>
        </div>

        {/* Header row */}
        <TableRow s={s} cells={['Date', 'Meta Spend', 'GST', 'Reach', 'Impressions', 'CPR', 'Remaining Amount']} header />
        {tableRows.length === 0 ? (
          <div style={{ display: 'flex', padding: `${24 * s}px`, color: '#9CA3AF', fontSize: `${22 * s}px` }}>
            No daily metrics recorded for this period.
          </div>
        ) : tableRows.map((r, i) => (
          <TableRow
            key={r.date}
            s={s}
            zebra={i % 2 === 1}
            last={i === tableRows.length - 1}
            cells={[
              ddmmyyyy(r.date),
              `₹${money(r.spend)}`,
              `₹${money(r.gstAmount)}`,
              num(r.reach),
              num(r.impressions),
              `₹${money(r.cpr)}`,
              `₹${money(r.balance)}`,
            ]}
          />
        ))}
      </div>

      {/* ── Footer ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginTop: `${20 * s}px`, paddingTop: `${20 * s}px`, borderTop: `${2 * s}px solid #E5E7EB`,
        fontSize: `${20 * s}px`, color: '#6B7280',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontWeight: 800, color: PURPLE, fontSize: `${24 * s}px` }}>
            {brand.agencyName}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          {brand.contactPhone  && <div style={{ display: 'flex' }}>{brand.contactPhone}</div>}
          <div style={{ display: 'flex' }}>
            {(brand.contactWebsite ?? 'www.cirqle.work').replace(/^https?:\/\//, '')}
            {brand.contactEmail ? `  |  ${brand.contactEmail}` : ''}
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetaLine({ s, pairs }: { s: number; pairs: [string, string][] }) {
  return (
    <div style={{ display: 'flex', gap: `${40 * s}px`, fontSize: `${24 * s}px`, color: '#374151' }}>
      {pairs.map(([k, v], i) => (
        <div key={i} style={{ display: 'flex', gap: `${6 * s}px` }}>
          <span style={{ display: 'flex', color: '#6B7280' }}>{k} :</span>
          <span style={{ display: 'flex', fontWeight: 700, color: INK }}>{v}</span>
        </div>
      ))}
    </div>
  )
}

function KpiCircle({
  s, label, value, grad, icon,
}: { s: number; label: string; value: string; grad: [string, string]; icon: IconName }) {
  const dia = 84 * s
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: `${172 * s}px` }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: `${dia}px`, height: `${dia}px`, borderRadius: `${dia}px`,
        background: `linear-gradient(135deg, ${grad[0]}, ${grad[1]})`,
        marginBottom: `${12 * s}px`,
      }}>
        <Icon name={icon} size={40 * s} />
      </div>
      <div style={{ display: 'flex', fontSize: `${21 * s}px`, fontWeight: 600, color: '#6B7280', marginBottom: `${3 * s}px` }}>
        {label}
      </div>
      <div style={{ display: 'flex', fontSize: `${32 * s}px`, fontWeight: 800, color: INK }}>
        {value}
      </div>
    </div>
  )
}

function KpiDivider({ s }: { s: number }) {
  return <div style={{ display: 'flex', width: `${1 * s}px`, height: `${72 * s}px`, background: '#E5E7EB', marginTop: `${6 * s}px` }} />
}

function Pill({ s, bg, label, value }: { s: number; bg: string; label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: `${8 * s}px`,
      background: bg, color: '#FFFFFF', borderRadius: `${14 * s}px`,
      padding: `${14 * s}px ${28 * s}px`, fontSize: `${24 * s}px`,
    }}>
      <span style={{ display: 'flex', fontWeight: 500 }}>{label} :</span>
      <span style={{ display: 'flex', fontWeight: 800 }}>{value}</span>
    </div>
  )
}

function TableRow({
  s, cells, header, zebra, last,
}: { s: number; cells: string[]; header?: boolean; zebra?: boolean; last?: boolean }) {
  // Column flex weights: Date, Meta Spend, GST, Reach, Impressions, CPR, Remaining Amount (7 columns)
  const flex = [1.8, 1.4, 1.0, 1.1, 1.2, 1.1, 1.8]
  const bg = header ? PURPLE : zebra ? '#F5F3FF' : '#FFFFFF'
  return (
    <div style={{
      display: 'flex',
      background: bg,
      color: header ? '#FFFFFF' : '#374151',
      fontSize: `${(header ? 19 : 20) * s}px`,
      fontWeight: header ? 700 : 500,
      padding: `${13 * s}px ${16 * s}px`,
      borderLeft: header ? 'none' : `${1 * s}px solid #EDE9FE`,
      borderRight: header ? 'none' : `${1 * s}px solid #EDE9FE`,
      borderBottom: last ? `${1 * s}px solid #EDE9FE` : 'none',
      borderTopLeftRadius: header ? `${8 * s}px` : 0,
      borderTopRightRadius: header ? `${8 * s}px` : 0,
    }}>
      {cells.map((c, i) => (
        <div key={i} style={{
          display: 'flex',
          flex: flex[i],
          justifyContent: i === 0 ? 'flex-start' : 'flex-end',
          fontWeight: header ? 700 : i === 0 ? 500 : 700,
          color: header ? '#FFFFFF' : i === cells.length - 1 ? PURPLE_D : '#374151',
        }}>
          {c}
        </div>
      ))}
    </div>
  )
}

// ─── Logos ──────────────────────────────────────────────────────────────────

function CirqleLogo({ s, brand }: { s: number; brand: RenderData['brand'] }) {
  // Real agency logo from Settings → Company → Branding. Fixed box keeps the
  // header height stable regardless of the logo's aspect ratio.
  if (brand.agencyLogoUrl) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', width: `${230 * s}px`, height: `${64 * s}px` }}>
        <img
          src={brand.agencyLogoUrl}
          alt=""
          width={230 * s}
          height={64 * s}
          style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'left center' }}
        />
      </div>
    )
  }
  const box = 56 * s
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: `${14 * s}px` }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: `${box}px`, height: `${box}px`, borderRadius: `${16 * s}px`,
        background: `linear-gradient(135deg, #8B5CF6, ${PURPLE})`,
      }}>
        <svg width={box * 0.5} height={box * 0.5} viewBox="0 0 24 24" fill="#FFFFFF">
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ display: 'flex', fontSize: `${11 * s}px`, letterSpacing: `${3 * s}px`, color: '#9CA3AF', fontWeight: 700 }}>
          MARKETING
        </span>
        <span style={{ display: 'flex', fontSize: `${30 * s}px`, fontWeight: 800, color: NAVY, marginTop: `${-2 * s}px` }}>
          {brand.agencyName.replace(/^Marketing\s+/i, '').toLowerCase()}
        </span>
      </div>
    </div>
  )
}

function MetaLogo({ s }: { s: number }) {
  // Official Meta logo (infinity mark + wordmark), viewBox 0 0 50 11.
  const h = 30 * s
  const w = h * (50 / 11)
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: `${w}px`, height: `${h}px` }}>
      <img src={META_LOGO_DATA_URI} alt="Meta" width={w} height={h} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    </div>
  )
}

// ─── Decorative swoosh ────────────────────────────────────────────────────────

function Swoosh({ position, s, width }: { position: 'top' | 'bottom'; s: number; width: number }) {
  const h = 90 * s
  const common: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    width: `${width}px`,
    height: `${h}px`,
    display: 'flex',
  }
  const style: React.CSSProperties =
    position === 'top' ? { ...common, top: 0 } : { ...common, bottom: 0 }
  const d = position === 'top'
    ? `M0 0 L${width} 0 L${width} ${h * 0.5} C${width * 0.7} ${h * 1.1} ${width * 0.3} ${h * 0.1} 0 ${h * 0.7} Z`
    : `M0 ${h} L${width} ${h} L${width} ${h * 0.3} C${width * 0.7} ${h * -0.1} ${width * 0.3} ${h * 0.9} 0 ${h * 0.3} Z`
  return (
    <div style={style}>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} fill="none">
        <path d={d} fill={PURPLE} fillOpacity={0.10} />
      </svg>
    </div>
  )
}

// ─── Icons (white inline SVG) ─────────────────────────────────────────────────

type IconName = 'users' | 'eye' | 'cursor' | 'rupee' | 'percent'

function Icon({ name, size }: { name: IconName; size: number }) {
  const stroke = {
    fill: 'none' as const, stroke: '#FFFFFF', strokeWidth: 2,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'users':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    case 'eye':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )
    case 'cursor':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
          <path d="m13 13 6 6" />
        </svg>
      )
    case 'rupee':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4h12" />
          <path d="M6 8h12" />
          <path d="M8 8c5 0 5 7 0 7H7l7 6" />
        </svg>
      )
    case 'percent':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <line x1="19" y1="5" x2="5" y2="19" />
          <circle cx="6.5" cy="6.5" r="2.5" />
          <circle cx="17.5" cy="17.5" r="2.5" />
        </svg>
      )
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** "2026-02-14" → "Saturday, February 14, 2026" */
function longDate(iso: string): string {
  const dt = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return iso
  return `${WEEKDAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`
}

/** "2026-02-07" → "07 Feb 2026" */
function shortDate(iso: string): string {
  const [y, m, day] = iso.split('-')
  if (!y || !m || !day) return iso
  return `${day} ${MONTHS_SHORT[parseInt(m, 10) - 1]} ${y}`
}

/** "2026-02-14" → "14-02-2026" */
function ddmmyyyy(iso: string): string {
  const [y, m, day] = iso.split('-')
  if (!y || !m || !day) return iso
  return `${day}-${m}-${y}`
}

/** Whole-number INR grouping, e.g. 630862 → "630,862". */
const num = (n: number) => Math.round(n || 0).toLocaleString('en-IN')

/** Two-decimal money, e.g. 1426.666 → "1,426.67". */
const money = (n: number) =>
  (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
