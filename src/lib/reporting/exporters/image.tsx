/**
 * Image Exporter (WhatsApp-ready PNG)
 *
 * Generates PNG images using Next.js's bundled ImageResponse (@vercel/og).
 * Two sizes: portrait (1080×1920) and square (1080×1080).
 *
 * Template "daily" uses the shared Cirqle Daily Report layout (the same one
 * embedded into the PDF, so image + PDF are pixel-identical). All other
 * templates use the dark analytics style.
 */

import React from 'react'
import { ImageResponse } from 'next/og'
import type { RenderData } from '../types'
import { buildDailyReportElement } from '../layouts/daily-report'

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
    ? buildDailyReportElement(data, { width, height })
    : buildDarkLayout(data, width, height)

  const response = new ImageResponse(element, { width, height })
  const arrayBuffer = await (response as Response).arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ─── Dark analytics layout (all other templates) ──────────────────────────────

function buildDarkLayout(data: RenderData, width: number, height: number) {
  const { brand, project, kpi, health, config, template, ai } = data
  const p = kpi.primary
  const d = kpi.derived
  const primary   = brand.primaryColor

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

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…'
}

const inr      = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmtLarge = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmtK     = (n: number) =>
  n >= 1000000 ? `${(n / 1000000).toFixed(1)}M`
  : n >= 1000  ? `${(n / 1000).toFixed(0)}K`
  : String(Math.round(n))
