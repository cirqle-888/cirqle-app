/**
 * Shared branded-report primitives (Satori / next-og JSX).
 *
 * Brand tokens, layout building blocks, and formatters used by every report
 * layout (`daily-report.tsx`, `monthly-report.tsx`, `report-cards.tsx`) so
 * every template — Daily, Monthly, and the six "cards" templates — renders
 * through one consistent visual system.
 *
 * Satori notes honoured throughout:
 *   • Every element with >1 child sets an explicit `display: 'flex'`.
 *   • Colours use hex literals or CSS gradients (well supported); this app's
 *     own theme is oklch()/lab()-based, which Satori can't parse — never
 *     reference CSS custom properties or Tailwind theme classes here.
 *   • No JSX fragments — Satori lays out a fragment's children as siblings
 *     of the parent flex container, not as a group.
 *   • Sizes scale off a `width`-derived `s` factor so one layout serves both
 *     1080-wide image exports and ~1240-wide A4 PDF renders.
 */

/* eslint-disable @next/next/no-img-element */
import React from 'react'
import type { RenderData } from '../types'
import { META_LOGO_DATA_URI } from './meta-logo'

// ─── Brand tokens ───────────────────────────────────────────────────────────
export const PURPLE   = '#6D28D9'
export const PURPLE_D = '#5B21B6'
export const NAVY     = '#1E1B4B'
export const INK      = '#111827'
export const GREY_PILL = '#4B5563'
export const RED_PILL  = '#EF4444'

/** Health-grade → colour, consolidated from the two identical copies that
 * previously lived in `exporters/pdf.ts` (`gradeToRgb`) and
 * `exporters/image.tsx` (`gradeColor`). */
export const GRADE_COLORS: Record<'A' | 'B' | 'C' | 'D' | 'F', string> = {
  A: '#16A34A', B: '#2563EB', C: '#D97706', D: '#EA580C', F: '#DC2626',
}
export function gradeColor(grade: string): string {
  return GRADE_COLORS[grade as 'A' | 'B' | 'C' | 'D' | 'F'] ?? '#6B7280'
}

/**
 * Global Safe Content Area — page margins in 1080-design-units, scaled by `s`
 * at call sites. The single named source of truth every report layout's
 * content wrapper uses (`daily-report.tsx`, `monthly-report.tsx`, both page
 * builders in `report-cards.tsx`), so the safe margins can never drift apart
 * between templates.
 */
export const SAFE_AREA = { top: 64, bottom: 64, left: 56, right: 56 } as const

// ─── Layout primitives ────────────────────────────────────────────────────────

export function MetaLine({ s, pairs }: { s: number; pairs: [string, string][] }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
      gap: `${40 * s}px`, rowGap: `${6 * s}px`, fontSize: `${24 * s}px`, color: '#374151', maxWidth: '100%',
    }}>
      {pairs.map(([k, v], i) => (
        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: `${6 * s}px`, maxWidth: '100%' }}>
          <span style={{ display: 'flex', color: '#6B7280', flexShrink: 0 }}>{k} :</span>
          <span style={{ display: 'flex', fontWeight: 700, color: INK, wordBreak: 'break-word', maxWidth: `${420 * s}px` }}>
            {truncate(v, 80)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function KpiCircle({
  s, label, value, grad, icon, dia,
}: { s: number; label: string; value: string; grad: [string, string]; icon: IconName; dia?: number }) {
  const diameter = (dia ?? 84) * s
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: `${172 * s}px` }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: `${diameter}px`, height: `${diameter}px`, borderRadius: `${diameter}px`,
        background: `linear-gradient(135deg, ${grad[0]}, ${grad[1]})`,
        marginBottom: `${12 * s}px`,
      }}>
        <Icon name={icon} size={diameter * 0.48} />
      </div>
      <div style={{
        display: 'flex', fontSize: `${21 * s}px`, fontWeight: 600, color: '#6B7280', marginBottom: `${3 * s}px`,
        textAlign: 'center', wordBreak: 'break-word', maxWidth: `${172 * s}px`,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', fontSize: `${32 * s}px`, fontWeight: 800, color: INK, wordBreak: 'break-word', maxWidth: `${172 * s}px`, textAlign: 'center' }}>
        {value}
      </div>
    </div>
  )
}

export function KpiDivider({ s }: { s: number }) {
  return <div style={{ display: 'flex', width: `${1 * s}px`, height: `${72 * s}px`, background: '#E5E7EB', marginTop: `${6 * s}px` }} />
}

export function Pill({ s, bg, label, value }: { s: number; bg: string; label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: `${8 * s}px`,
      background: bg, color: '#FFFFFF', borderRadius: `${14 * s}px`,
      padding: `${14 * s}px ${28 * s}px`, fontSize: `${24 * s}px`, maxWidth: `${480 * s}px`,
    }}>
      <span style={{ display: 'flex', fontWeight: 500, flexShrink: 0 }}>{label} :</span>
      <span style={{ display: 'flex', fontWeight: 800, wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

export function TableRow({
  s, cells, header, zebra, last, flex,
}: { s: number; cells: string[]; header?: boolean; zebra?: boolean; last?: boolean; flex?: number[] }) {
  // Default column flex weights: Date, Meta Spend, GST, Reach, Impressions, CPR, Remaining Amount (7 columns)
  const colFlex = flex ?? [1.8, 1.4, 1.0, 1.1, 1.2, 1.1, 1.8]
  const bg = header ? PURPLE : zebra ? '#F5F3FF' : '#FFFFFF'
  return (
    <div style={{
      display: 'flex',
      background: bg,
      color: header ? '#FFFFFF' : '#374151',
      fontSize: `${(header ? 19 : 20) * s}px`,
      fontWeight: header ? 700 : 500,
      padding: `${13 * s}px ${16 * s}px`,
      gap: `${20 * s}px`,
      borderLeft: header ? 'none' : `${1 * s}px solid #EDE9FE`,
      borderRight: header ? 'none' : `${1 * s}px solid #EDE9FE`,
      borderBottom: last ? `${1 * s}px solid #EDE9FE` : 'none',
      borderTopLeftRadius: header ? `${8 * s}px` : 0,
      borderTopRightRadius: header ? `${8 * s}px` : 0,
    }}>
      {cells.map((c, i) => (
        <div key={i} style={{
          display: 'flex',
          // Percentage flexBasis (not `flex: n`, whose basis is 0) — during
          // Satori's auto-height measure pass a zero-basis cell offers the
          // text zero width, and `wordBreak` wrapping at width 0 never
          // terminates (hangs the whole render; confirmed by direct
          // isolation). A basis proportional to the flex weight resolves to
          // the same column widths while giving measurement a real width.
          flexGrow: colFlex[i],
          flexShrink: 1,
          flexBasis: `${(colFlex[i] / colFlex.reduce((a, b) => a + b, 0)) * 100}%`,
          minWidth: 0,
          justifyContent: i === 0 ? 'flex-start' : 'flex-end',
          fontWeight: header ? 700 : i === 0 ? 500 : 700,
          color: header ? '#FFFFFF' : i === cells.length - 1 ? PURPLE_D : '#374151',
          // Header labels are short, fixed strings (never user/AI-generated) —
          // wordBreak here previously caused Yoga to mis-measure adjacent
          // columns' flex-basis and visually collide two labels (confirmed by
          // direct render inspection). Only data cells carry variable-length
          // content (long model names, metric labels), so only they need the
          // wrap guard.
          wordBreak: header ? 'normal' : 'break-word',
        }}>
          {c}
        </div>
      ))}
    </div>
  )
}

// ─── Cards (new primitives — additive, for the six rebuilt templates) ─────────

/** Rounded panel with a coloured left border, used for every non-tabular
 * report "card" (executive summary, campaign health, forecast, etc). */
export function Card({ s, accent, children }: { s: number; accent: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: '#FFFFFF',
      border: `${1 * s}px solid #EDE9FE`,
      borderLeft: `${6 * s}px solid ${accent}`,
      borderRadius: `${14 * s}px`,
      padding: `${28 * s}px ${32 * s}px`,
      marginBottom: `${24 * s}px`,
    }}>
      {children}
    </div>
  )
}

/** Card title row: small gradient icon circle + label, optional right-aligned meta text. */
export function SectionHeading({
  s, icon, label, meta, accent,
}: { s: number; icon: IconName; label: string; meta?: string; accent: string }) {
  const dia = 40 * s
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: `${18 * s}px` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: `${14 * s}px` }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: `${dia}px`, height: `${dia}px`, borderRadius: `${dia}px`,
          background: `linear-gradient(135deg, ${accent}, ${PURPLE_D})`,
        }}>
          <Icon name={icon} size={dia * 0.5} />
        </div>
        <span style={{ display: 'flex', fontSize: `${24 * s}px`, fontWeight: 800, color: INK }}>{label}</span>
      </div>
      {meta ? <span style={{ display: 'flex', fontSize: `${18 * s}px`, color: '#6B7280' }}>{meta}</span> : null}
    </div>
  )
}

/** One stat box in a KPI-scorecard grid: uppercase label, big value, small sub-label. */
export function StatBlock({
  s, label, value, sub, basis,
}: { s: number; label: string; value: string; sub?: string; basis?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flexBasis: basis ?? '31%',
      background: '#F5F3FF', borderRadius: `${10 * s}px`,
      padding: `${16 * s}px ${18 * s}px`,
    }}>
      <div style={{ display: 'flex', fontSize: `${15 * s}px`, fontWeight: 700, color: '#6B7280', letterSpacing: `${1 * s}px`, textTransform: 'uppercase', marginBottom: `${6 * s}px`, wordBreak: 'break-word' }}>
        {label}
      </div>
      <div style={{ display: 'flex', fontSize: `${30 * s}px`, fontWeight: 800, color: INK, marginBottom: sub ? `${4 * s}px` : 0, wordBreak: 'break-word' }}>
        {value}
      </div>
      {sub ? <div style={{ display: 'flex', fontSize: `${15 * s}px`, color: '#9CA3AF', wordBreak: 'break-word' }}>{sub}</div> : null}
    </div>
  )
}

/** A single label:value row, e.g. inside a card body. */
export function StatRow({
  s, label, value, valueColor,
}: { s: number; label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', padding: `${8 * s}px 0`, gap: `${8 * s}px` }}>
      <span style={{ display: 'flex', fontSize: `${20 * s}px`, color: '#6B7280', wordBreak: 'break-word' }}>{label}</span>
      <span style={{ display: 'flex', fontSize: `${20 * s}px`, fontWeight: 700, color: valueColor ?? PURPLE_D, wordBreak: 'break-word', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

/** Capped bullet list — AI-generated content arrays are short by construction
 * (2-5 items per section), so a fixed cap avoids needing real text-flow
 * pagination inside Satori (which has no way to measure rendered text). */
export function BulletList({
  s, items, bullet, color, cap,
}: { s: number; items: string[]; bullet: string; color: string; cap: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: `${8 * s}px` }}>
      {items.slice(0, cap).map((text, i) => (
        <div key={i} style={{ display: 'flex', fontSize: `${18 * s}px`, color: '#374151', lineHeight: 1.4 }}>
          <span style={{ display: 'flex', color, marginRight: `${8 * s}px`, flexShrink: 0 }}>{bullet}</span>
          <span style={{ display: 'flex', wordBreak: 'break-word' }}>{truncate(text, 220)}</span>
        </div>
      ))}
    </div>
  )
}

/** Horizontal progress track, filled to `pct` (clamped 0-100 for the fill
 * width; the label showing the real value, if any, is the caller's job). */
export function ProgressBar({ s, pct, color, height }: { s: number; pct: number; color: string; height?: number }) {
  const h = (height ?? 10) * s
  const fillPct = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ display: 'flex', width: '100%', height: `${h}px`, borderRadius: `${h}px`, background: '#E5E7EB' }}>
      <div style={{ display: 'flex', width: `${fillPct}%`, height: `${h}px`, borderRadius: `${h}px`, background: color }} />
    </div>
  )
}

/** Diagonal low-opacity "CONFIDENTIAL" watermark, drawn over a full page. */
export function ConfidentialWatermark({ width, height }: { width: number; height: number }) {
  return (
    <div style={{
      position: 'absolute', display: 'flex', top: 0, left: 0, width: `${width}px`, height: `${height}px`,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        display: 'flex', fontSize: 90, fontWeight: 900, color: 'rgba(0,0,0,0.06)',
        letterSpacing: 4, transform: 'rotate(-30deg)',
      }}>
        CONFIDENTIAL
      </div>
    </div>
  )
}

/** Full-bleed background — decorative swooshes, or the workspace's custom
 * top/bottom images when `brand.backgroundDesign` opts into that. Shared by
 * every report layout so every template's page "feels" the same underneath
 * its content. */
export function PageChrome({
  s, width, height, brand,
}: { s: number; width: number; height: number; brand: RenderData['brand'] }) {
  if (brand.backgroundDesign === 'custom_images' || brand.backgroundDesign === 'Custom Images') {
    return (
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
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Swoosh position="top" s={s} width={width} />
      <Swoosh position="bottom" s={s} width={width} />
    </div>
  )
}

// ─── Logos ──────────────────────────────────────────────────────────────────

export function CirqleLogo({ s, brand }: { s: number; brand: RenderData['brand'] }) {
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
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: `${360 * s}px` }}>
        <span style={{ display: 'flex', fontSize: `${11 * s}px`, letterSpacing: `${3 * s}px`, color: '#9CA3AF', fontWeight: 700 }}>
          MARKETING
        </span>
        <span style={{
          display: 'flex', fontSize: `${30 * s}px`, fontWeight: 800, color: NAVY, marginTop: `${-2 * s}px`,
          wordBreak: 'break-word',
        }}>
          {truncate(brand.agencyName.replace(/^Marketing\s+/i, '').toLowerCase(), 40)}
        </span>
      </div>
    </div>
  )
}

export function MetaLogo({ s }: { s: number }) {
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

export type IconName =
  | 'users' | 'eye' | 'cursor' | 'rupee' | 'percent'
  | 'grid' | 'doc' | 'heart' | 'target' | 'trendUp' | 'trendDown' | 'flat' | 'bulb' | 'check'

export function Icon({ name, size }: { name: IconName; size: number }) {
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
    case 'grid':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      )
    case 'doc':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h6" />
        </svg>
      )
    case 'heart':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
        </svg>
      )
    case 'target':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1" />
        </svg>
      )
    case 'trendUp':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
        </svg>
      )
    case 'trendDown':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M3 7l6 6 4-4 8 8" />
          <path d="M15 17h6v-6" />
        </svg>
      )
    case 'flat':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M3 12h18" />
        </svg>
      )
    case 'bulb':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.2 1 2.3h6c0-1.1.4-1.9 1-2.3A7 7 0 0 0 12 2z" />
        </svg>
      )
    case 'check':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )
  }
}

// ─── Campaign meta derivation ─────────────────────────────────────────────────

/**
 * Campaign period / budget figures shared by every hero (Daily, Monthly, and
 * the cards templates) — plan length, daily budget, remaining days, etc.
 * Single source of truth so the three heroes never drift from each other.
 */
export function computeCampaignMeta(data: RenderData) {
  const { project } = data
  const startDate = project.startDate ?? data.config.dateFrom
  const endDate   = project.endDate   ?? data.config.dateTo
  // Campaign plan length uses the end−start convention (e.g. 07→20 Feb = 13 days).
  const planDays = Math.max(
    1,
    Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000),
  )
  const periodLabel = `${shortDate(startDate)} - ${shortDate(endDate)}`

  // "Expected Budget" is the raw ad-spend budget as configured (GST-exclusive).
  const expectedBudget = project.adBudget

  // "Daily Budget" / "Campaign Plan" mirror the Budget tab exactly when the
  // project uses daily-budget mode, instead of being re-derived from dates.
  const usesDailyBudget = project.budgetInputMode === 'daily' && project.dailyBudgetConfigured != null
  const budgetPlanDays = usesDailyBudget ? (project.budgetDaysConfigured || planDays) : planDays
  const dailyBudget = usesDailyBudget
    ? project.dailyBudgetConfigured!
    : (expectedBudget > 0 ? expectedBudget / planDays : 0)

  const remainingDays = Math.max(
    0,
    Math.round((new Date(endDate).getTime() - Date.now()) / 86400000),
  )

  return { startDate, endDate, planDays, periodLabel, expectedBudget, budgetPlanDays, dailyBudget, remainingDays }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** "2026-02-14" → "Saturday, February 14, 2026" */
export function longDate(iso: string): string {
  const dt = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return iso
  return `${WEEKDAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`
}

/** "2026-02-07" → "07 Feb 2026" */
export function shortDate(iso: string): string {
  const [y, m, day] = iso.split('-')
  if (!y || !m || !day) return iso
  return `${day} ${MONTHS_SHORT[parseInt(m, 10) - 1]} ${y}`
}

/** "2026-02-14" → "14-02-2026" */
export function ddmmyyyy(iso: string): string {
  const [y, m, day] = iso.split('-')
  if (!y || !m || !day) return iso
  return `${day}-${m}-${y}`
}

/** "2026-02" → "Feb 2026" */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-')
  if (!y || !m) return monthKey
  return `${MONTHS_SHORT[parseInt(m, 10) - 1]} ${y}`
}

/** Whole-number INR grouping, e.g. 630862 → "630,862". */
export const num = (n: number) => Math.round(n || 0).toLocaleString('en-IN')

/** Two-decimal money, e.g. 1426.666 → "1,426.67". */
export const money = (n: number) =>
  (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Truncate with an ellipsis — consolidated from the identical copy that
 * previously lived in `exporters/image.tsx`'s `buildDarkLayout`. */
export function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…'
}
