/**
 * Image Exporter (WhatsApp-ready PNG)
 *
 * Generates PNG images using Next.js's bundled ImageResponse (@vercel/og).
 * Two sizes: portrait (1080×1920) and square (1080×1080).
 *
 * Template "daily" uses the Cirqle Daily Report style (white background,
 * campaign header, KPI row, last-3-days table — matching the branded PDF).
 * All other templates use the dark analytics style.
 */

/* eslint-disable react/display-name */
import React from 'react'
// @ts-ignore — next/og is available in the Next.js bundle
import { ImageResponse } from 'next/og'
import type { RenderData } from '../types'

/**
 * Generates a portrait PNG (1080×1920) — WhatsApp story / full-screen.
 */
export async function generateImagePortrait(data: RenderData): Promise<Buffer> {
  return generateImage(data, 1080, 1920)
}

/**
 * Generates a square PNG (1080×1080) — WhatsApp post / Instagram.
 */
export async function generateImageSquare(data: RenderData): Promise<Buffer> {
  return generateImage(data, 1080, 1080)
}

// ─── Core dispatcher ──────────────────────────────────────────────────────────

async function generateImage(data: RenderData, width: number, height: number): Promise<Buffer> {
  const element = data.template.name === 'daily'
    ? buildDailyLayout(data, width, height)
    : buildDarkLayout(data, width, height)

  const response = new ImageResponse(element, { width, height })
  const arrayBuffer = await (response as Response).arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ─── Daily layout (Cirqle branded — white bg) ─────────────────────────────────

function buildDailyLayout(data: RenderData, width: number, height: number) {
  const { brand, project, kpi, config, template } = data
  const p  = kpi.primary
  const d  = kpi.derived
  const s  = template.sections
  const purple = '#6D28D9'
  const navy   = '#1E1B4B'

  // Date range label
  const dateLabel = `${fmtDate(config.dateFrom)} – ${fmtDate(config.dateTo)}`

  // Campaign duration from project or date range
  const startDate = project.startDate ?? config.dateFrom
  const endDate   = project.endDate   ?? config.dateTo
  const planDays  = Math.round(
    (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000
  ) + 1

  // Last 3 rows of daily series
  const last3 = kpi.dailySeries.slice(-3).reverse()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: `${width}px`,
        height: `${height}px`,
        background: '#FFFFFF',
        fontFamily: 'sans-serif',
        color: navy,
        padding: '64px 56px',
        boxSizing: 'border-box',
      }}
    >
      {/* ── Top brand bar ── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
      }}>
        <div style={{ fontSize: '26px', fontWeight: 700, color: purple }}>
          {brand.agencyName}
        </div>
        <div style={{ fontSize: '22px', color: '#6B7280' }}>{dateLabel}</div>
        <div style={{
          fontSize: '26px', fontWeight: 700,
          color: project.platform === 'Meta' ? '#1877F2' : '#1A1A2E',
        }}>
          {project.platform}
        </div>
      </div>

      {/* Tagline */}
      <div style={{ fontSize: '18px', color: '#9CA3AF', marginBottom: '28px' }}>
        {brand.contactWebsite ?? 'www.cirqle.work'}
      </div>

      {/* ── Report title ── */}
      <div style={{
        fontSize: height > 1200 ? '56px' : '44px',
        fontWeight: 900,
        color: navy,
        marginBottom: '32px',
        lineHeight: 1.1,
      }}>
        {project.platform} Ads Daily Report
      </div>

      {/* ── Campaign meta grid ── */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px 40px',
        fontSize: '22px',
        marginBottom: '40px',
        color: '#374151',
      }}>
        <MetaPair label="Client"          value={project.clientName} />
        <MetaPair label="Campaign"        value={project.campaignName} />
        <MetaPair label="Campaign Period" value={dateLabel} />
        <MetaPair label="Campaign Plan"   value={`${planDays} Days`} />
        <MetaPair label="Daily Budget"    value={`₹${project.adBudget > 0 ? inr(project.adBudget / planDays) : '—'}`} />
        <MetaPair label="Expected Budget" value={`₹${inr(project.adBudget)}`} />
      </div>

      {/* ── KPI cards ── */}
      {s.kpiScorecard && (
        <div style={{ display: 'flex', gap: '16px', marginBottom: '32px' }}>
          <DailyKPI label="Reach"       value={fmtLarge(p.reach)}       color="#7C3AED" />
          <DailyKPI label="Impressions" value={fmtLarge(p.impressions)} color="#2563EB" />
          <DailyKPI label="Clicks"      value={fmtLarge(p.clicks)}      color="#0EA5E9" />
          <DailyKPI label="Spend"       value={`₹${inr(p.spend)}`}      color="#059669" />
          <DailyKPI label="CPR"         value={`₹${d.costPerResult.toFixed(2)}`} color="#DC2626" />
        </div>
      )}

      {/* ── Budget badges ── */}
      {s.budgetAnalysis && (
        <div style={{ display: 'flex', gap: '16px', marginBottom: '40px' }}>
          <div style={{
            background: '#4B5563',
            borderRadius: '12px',
            padding: '14px 28px',
            color: '#FFFFFF',
            fontSize: '24px',
            fontWeight: 600,
          }}>
            Total Remaining: ₹{inr(d.remainingBudget)}
          </div>
          <div style={{
            background: '#EF4444',
            borderRadius: '12px',
            padding: '14px 28px',
            color: '#FFFFFF',
            fontSize: '24px',
            fontWeight: 600,
          }}>
            Remaining Days: {Math.max(0, Math.round(
              (new Date(endDate).getTime() - Date.now()) / 86400000
            ))} Days
          </div>
        </div>
      )}

      {/* ── Last 3 days breakdown ── */}
      {s.dailyBreakdown && last3.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0px', flex: 1 }}>
          <div style={{ fontSize: '28px', fontWeight: 700, marginBottom: '16px', borderBottom: `3px solid ${purple}`, paddingBottom: '8px' }}>
            Last {last3.length} Days Performance
          </div>
          {/* Table header */}
          <div style={{
            display: 'flex',
            background: navy,
            color: '#FFFFFF',
            fontSize: '20px',
            fontWeight: 600,
            borderRadius: '8px 8px 0 0',
            padding: '14px 16px',
            gap: '0px',
          }}>
            <span style={{ flex: 2 }}>Date</span>
            <span style={{ flex: 1.5, textAlign: 'right' }}>Spend</span>
            <span style={{ flex: 1.5, textAlign: 'right' }}>Reach</span>
            <span style={{ flex: 2, textAlign: 'right' }}>Impressions</span>
            <span style={{ flex: 1.2, textAlign: 'right' }}>CPR</span>
          </div>
          {last3.map((row, i) => (
            <div key={row.date} style={{
              display: 'flex',
              background: i % 2 === 0 ? '#F9FAFB' : '#FFFFFF',
              fontSize: '21px',
              padding: '14px 16px',
              borderLeft: '1px solid #E5E7EB',
              borderRight: '1px solid #E5E7EB',
              borderBottom: i === last3.length - 1 ? '1px solid #E5E7EB' : 'none',
              gap: '0px',
            }}>
              <span style={{ flex: 2, color: '#374151' }}>{row.date}</span>
              <span style={{ flex: 1.5, textAlign: 'right', fontWeight: 600 }}>₹{inr(row.spend)}</span>
              <span style={{ flex: 1.5, textAlign: 'right' }}>{fmtLarge(row.roas > 0 ? row.spend / row.roas : 0)}</span>
              <span style={{ flex: 2, textAlign: 'right', fontWeight: 600 }}>{fmtLarge(row.roas > 0 ? row.spend / row.roas : 0)}</span>
              <span style={{ flex: 1.2, textAlign: 'right', color: '#6D28D9', fontWeight: 700 }}>₹{(row.spend > 0 && row.roas > 0 ? row.spend / (row.spend / (row.ctr > 0 ? row.spend / row.ctr * 100 : 1)) : d.costPerResult).toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Footer ── */}
      <div style={{
        marginTop: 'auto',
        paddingTop: '24px',
        borderTop: `2px solid #E5E7EB`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '20px',
        color: '#9CA3AF',
      }}>
        <div>
          <div style={{ fontWeight: 700, color: purple, fontSize: '22px' }}>
            Marketing {brand.agencyName}
          </div>
          <div>Connected by Creativity</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {brand.contactPhone && <div>{brand.contactPhone}</div>}
          {brand.contactWebsite && <div>{brand.contactWebsite}</div>}
          {brand.contactEmail && <div>{brand.contactEmail}</div>}
        </div>
      </div>
    </div>
  )
}

// ─── Dark analytics layout (all other templates) ──────────────────────────────

function buildDarkLayout(data: RenderData, width: number, height: number) {
  const { brand, project, kpi, health, config, template, ai } = data
  const p = kpi.primary
  const d = kpi.derived
  const primary   = brand.primaryColor
  const secondary = brand.secondaryColor

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: `${width}px`,
        height: `${height}px`,
        background: '#0F0F1A',
        fontFamily: 'sans-serif',
        color: '#FFFFFF',
        padding: '60px',
        boxSizing: 'border-box',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          borderLeft: `8px solid ${primary}`,
          paddingLeft: '24px',
          marginBottom: '48px',
        }}
      >
        <div style={{ fontSize: '28px', color: '#A0A0C0', fontWeight: 400, marginBottom: '8px' }}>
          {brand.agencyName}
        </div>
        <div style={{ fontSize: '52px', fontWeight: 700, lineHeight: 1.1, marginBottom: '12px' }}>
          {project.campaignName}
        </div>
        <div style={{ fontSize: '28px', color: '#A0A0C0' }}>
          {template.displayName} · {config.dateFrom} – {config.dateTo}
        </div>
      </div>

      {/* Health badge */}
      {template.sections.campaignHealth && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px', marginBottom: '48px' }}>
          <div
            style={{
              background: gradeColor(health.grade),
              borderRadius: '16px',
              padding: '16px 32px',
              fontSize: '36px',
              fontWeight: 700,
              color: '#fff',
            }}
          >
            Grade {health.grade}
          </div>
          <div style={{ fontSize: '28px', color: '#A0A0C0' }}>
            Health {health.score}/100 · {health.risk} risk
          </div>
        </div>
      )}

      {/* KPI grid */}
      {template.sections.kpiScorecard && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', marginBottom: '48px' }}>
          <KPICard label="SPEND"   value={`₹${inr(p.spend)}`}     sub={`${d.budgetUtilisation.toFixed(0)}% budget`} />
          <KPICard label="ROAS"    value={p.roas.toFixed(2)}       sub="return on ad spend" />
          <KPICard label="CLICKS"  value={fmtLarge(p.clicks)}      sub={`CTR ${p.ctr.toFixed(1)}%`} />
          <KPICard label="LEADS"   value={fmtLarge(p.leads)}       sub={`₹${p.cpl.toFixed(0)} per lead`} />
          <KPICard label="IMPR."   value={fmtK(p.impressions)}     sub={`Reach ${fmtK(p.reach)}`} />
          <KPICard label="REVENUE" value={`₹${inr(p.revenue)}`}   sub={`Profit ₹${inr(d.profit)}`} />
        </div>
      )}

      {/* AI summary */}
      {template.sections.aiInsights && (
        <div
          style={{
            background: 'rgba(124,58,237,0.12)',
            border: `1px solid rgba(124,58,237,0.25)`,
            borderRadius: '16px',
            padding: '32px',
            fontSize: '26px',
            lineHeight: 1.6,
            color: '#D0D0E8',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ fontWeight: 700, color: '#FFFFFF', marginBottom: '12px', fontSize: '28px' }}>
            AI Analysis
          </div>
          <div>{truncate(ai.executiveSummary, 220)}</div>
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          marginTop: 'auto',
          paddingTop: '32px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          fontSize: '22px',
          color: '#606080',
        }}
      >
        <div>{brand.showPoweredBy ? `Powered by ${brand.agencyName}` : brand.agencyName}</div>
        <div>{project.clientName}</div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DailyKPI({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      flex: 1,
      background: '#F9FAFB',
      border: `2px solid ${color}20`,
      borderRadius: '16px',
      padding: '20px 12px',
    }}>
      <div style={{ fontSize: '18px', color: '#6B7280', fontWeight: 500, marginBottom: '6px' }}>
        {label}
      </div>
      <div style={{ fontSize: '36px', fontWeight: 800, color, lineHeight: 1.1 }}>
        {value}
      </div>
    </div>
  )
}

function MetaPair({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '6px' }}>
      <span style={{ color: '#6B7280' }}>{label} :</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  )
}

function KPICard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '16px',
        padding: '24px 28px',
        flex: '1 1 280px',
        minWidth: '280px',
      }}
    >
      <div style={{ fontSize: '20px', color: '#8080A8', fontWeight: 500, marginBottom: '8px', letterSpacing: '2px' }}>
        {label}
      </div>
      <div style={{ fontSize: '44px', fontWeight: 700, color: '#FFFFFF', lineHeight: 1.1, marginBottom: '6px' }}>
        {value}
      </div>
      <div style={{ fontSize: '22px', color: '#6060A0' }}>
        {sub}
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  const map: Record<string, string> = {
    A: '#16A34A', B: '#2563EB', C: '#D97706', D: '#EA580C', F: '#DC2626',
  }
  return map[grade] ?? '#6B7280'
}

function fmtDate(iso: string): string {
  // e.g. "2026-02-19" → "19 Feb 2026"
  const [y, m, day] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${day} ${months[parseInt(m, 10) - 1]} ${y}`
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…'
}

const inr      = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmtLarge = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmtK     = (n: number) =>
  n >= 1000000 ? `${(n / 1000000).toFixed(1)}M`
  : n >= 1000  ? `${(n / 1000).toFixed(0)}K`
  : String(Math.round(n))
