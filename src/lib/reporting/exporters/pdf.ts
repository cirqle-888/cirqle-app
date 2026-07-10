/**
 * PDF Exporter
 *
 * Generates a multi-section PDF from RenderData using jsPDF.
 * Runs server-side (Node.js) — no browser APIs.
 *
 * Layout: A4 portrait, 15mm margins.
 * Sections driven by template.sections config.
 */

import { jsPDF } from 'jspdf'
import type { RenderData } from '../types'

const MARGIN  = 15
const PAGE_W  = 210  // A4 mm
const CONTENT = PAGE_W - MARGIN * 2
const LINE_H  = 7

type Doc = InstanceType<typeof jsPDF>

/**
 * Generates a PDF buffer from RenderData.
 *
 * The "daily" template is rendered pixel-perfect: the shared branded layout is
 * rasterised to a high-res A4 PNG and embedded full-page, so the PDF matches the
 * WhatsApp image exactly. All other templates use the multi-page analytics build.
 */
export async function generatePDF(data: RenderData): Promise<Buffer> {
  if (data.template.name === 'daily') {
    return generateDailyPDF(data)
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Embed page 1: cover + KPI scorecard
  buildCoverPage(doc, data)

  // Page 2: KPI detail
  doc.addPage()
  buildKPIPage(doc, data)

  // Page 3: AI narrative
  if (data.template.sections.aiInsights) {
    doc.addPage()
    buildAINarrativePage(doc, data)
  }

  // Page 4: Forecast + Health
  if (data.template.sections.forecast || data.template.sections.campaignHealth) {
    doc.addPage()
    buildForecastPage(doc, data)
  }

  // Footer on all pages
  addFooters(doc, data)

  return Buffer.from(doc.output('arraybuffer'))
}

// ─── Daily template — image-based pixel-perfect PDF ─────────────────────────────

/**
 * Renders the shared daily-report layout to one or more high-resolution
 * A4-portrait PNGs (~150 DPI) and embeds them full-bleed as PDF pages — one
 * page per chunk of days, so the full campaign history is shown instead of
 * being truncated to the last few days. Row counts per page are derived from
 * the layout's own vertical metrics, so each page fills its available space:
 * page 1 keeps the full branded hero, continuation pages keep the header,
 * campaign line, repeated table header and footer.
 */
async function generateDailyPDF(data: RenderData): Promise<Buffer> {
  const { ImageResponse } = await import('next/og')
  const { buildDailyReportElement, computeDailyRows, dailyReportRowCapacity } = await import('../layouts/daily-report')

  // A4 portrait at ~150 DPI: 1240 × 1754 (ratio 0.707 matches 210/297).
  const W = 1240
  const H = 1754

  // computeDailyRows returns true chronological (oldest → newest) order with a
  // correct running balance per day. Reverse to newest-first for display —
  // the report reads like a statement (latest update first), matching the
  // WhatsApp/PNG export's own ordering.
  const allRows = computeDailyRows(data).reverse()
  const firstCap = dailyReportRowCapacity({ width: W, height: H, continuation: false })
  const contCap  = dailyReportRowCapacity({ width: W, height: H, continuation: true })

  const pages: { rows: typeof allRows; startIndex: number; continuation: boolean }[] = []
  if (allRows.length <= firstCap) {
    pages.push({ rows: allRows, startIndex: 0, continuation: false })
  } else {
    pages.push({ rows: allRows.slice(0, firstCap), startIndex: 0, continuation: false })
    for (let i = firstCap; i < allRows.length; i += contCap) {
      pages.push({ rows: allRows.slice(i, i + contCap), startIndex: i, continuation: true })
    }
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  for (let i = 0; i < pages.length; i++) {
    const { rows, startIndex, continuation } = pages[i]
    const tableHeading = pages.length > 1
      ? `Daily Performance — Day ${startIndex + 1}–${startIndex + rows.length} of ${allRows.length}`
      : undefined

    const element = buildDailyReportElement(data, { width: W, height: H, rows, continuation, tableHeading })
    const response = new ImageResponse(element, { width: W, height: H })
    const png = Buffer.from(await (response as Response).arrayBuffer())
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`

    if (i > 0) doc.addPage()
    doc.addImage(dataUrl, 'PNG', 0, 0, PAGE_W, 297, undefined, 'FAST')
  }

  return Buffer.from(doc.output('arraybuffer'))
}

// ─── Cover page ───────────────────────────────────────────────────────────────

function buildCoverPage(doc: Doc, d: RenderData) {
  const brand = d.brand
  const p = d.kpi.primary
  const derived = d.kpi.derived
  let y = MARGIN

  // Header bar
  setFill(doc, brand.primaryColor)
  doc.rect(0, 0, PAGE_W, 40, 'F')

  // Agency / client name
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(20)
  doc.setFont('helvetica', 'bold')
  const title = brand.whiteLabelMode === 'client'
    ? brand.clientName
    : brand.agencyName
  doc.text(title, MARGIN, 18)

  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.text(d.template.displayName, MARGIN, 28)
  doc.text(`${d.config.dateFrom} – ${d.config.dateTo}`, PAGE_W - MARGIN, 28, { align: 'right' })

  y = 50

  // Campaign name
  doc.setTextColor(30, 30, 30)
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text(d.project.campaignName, MARGIN, y)
  y += 8

  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(100, 100, 100)
  doc.text(`${d.project.platform.toUpperCase()} · ${d.project.clientName} · Status: ${d.project.status}`, MARGIN, y)
  y += 12

  // Health badge
  const gradeColor = gradeToRgb(d.health.grade)
  setFill(doc, gradeColor)
  doc.roundedRect(MARGIN, y, 48, 16, 3, 3, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.text(`Health ${d.health.score}/100 · ${d.health.grade}`, MARGIN + 4, y + 10)
  y += 24

  // ── KPI scorecard grid (3×2) ─────────────────────────────────────────────
  doc.setTextColor(30, 30, 30)
  sectionHeader(doc, 'Key Performance Indicators', y, brand.primaryColor)
  y += 10

  const kpis = [
    { label: 'Total Spend',   value: `₹${inr(derived.actualCost)}`,      sub: `${fmt1(derived.budgetUtilisation)}% of budget` },
    { label: 'Revenue',       value: `₹${inr(p.revenue)}`,    sub: `ROAS ${fmt2(p.roas)}` },
    { label: 'Impressions',   value: fmtN(p.impressions),      sub: `Reach ${fmtN(p.reach)}` },
    { label: 'Clicks',        value: fmtN(p.clicks),           sub: `CTR ${fmt2(p.ctr)}%` },
    { label: 'Leads',         value: fmtN(p.leads),            sub: `CPL ₹${fmt2(p.cpl)}` },
    { label: 'CPC',           value: `₹${fmt2(p.cpc)}`,        sub: `CPM ₹${fmt2(p.cpm)}` },
  ]

  const cols = 3
  const boxW = (CONTENT / cols) - 3
  const boxH = 22

  kpis.forEach((kpi, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = MARGIN + col * (boxW + 3)
    const ky = y + row * (boxH + 4)

    doc.setFillColor(248, 248, 252)
    doc.roundedRect(x, ky, boxW, boxH, 2, 2, 'F')
    doc.setDrawColor(220, 220, 235)
    doc.roundedRect(x, ky, boxW, boxH, 2, 2, 'S')

    doc.setTextColor(100, 100, 120)
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    doc.text(kpi.label.toUpperCase(), x + 4, ky + 6)

    doc.setTextColor(20, 20, 40)
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.text(kpi.value, x + 4, ky + 14)

    doc.setTextColor(120, 120, 140)
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    doc.text(kpi.sub, x + 4, ky + 20)
  })

  y += Math.ceil(kpis.length / cols) * (boxH + 4) + 6

  // Comparison deltas (if available)
  if (d.kpi.deltas) {
    doc.setTextColor(30, 30, 30)
    sectionHeader(doc, 'vs Previous Period', y, brand.primaryColor)
    y += 8
    const deltas = [
      { label: 'Spend',    v: d.kpi.deltas.spendDelta },
      { label: 'Clicks',   v: d.kpi.deltas.clicksDelta },
      { label: 'Leads',    v: d.kpi.deltas.leadsDelta },
      { label: 'ROAS',     v: d.kpi.deltas.roasDelta },
      { label: 'CTR',      v: d.kpi.deltas.ctrDelta },
      { label: 'CPL',      v: d.kpi.deltas.cplDelta },
    ]
    deltas.forEach((dt, i) => {
      const x = MARGIN + (i % 3) * ((CONTENT / 3) + 1)
      const dy = y + Math.floor(i / 3) * 10
      const sign = dt.v >= 0 ? '+' : ''
      doc.setFontSize(9)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(100, 100, 120)
      doc.text(dt.label, x, dy)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(dt.v >= 0 ? 22 : 180, dt.v >= 0 ? 160 : 40, dt.v >= 0 ? 80 : 40)
      doc.text(`${sign}${fmt1(dt.v)}%`, x + 25, dy)
    })
  }
}

// ─── KPI detail page ──────────────────────────────────────────────────────────

function buildKPIPage(doc: Doc, d: RenderData) {
  const brand = d.brand
  let y = MARGIN
  const p = d.kpi.primary
  const derived = d.kpi.derived
  const pageTitle = 'Performance Detail'

  pageHeader(doc, pageTitle, d)
  y = 30

  const rows = [
    ['Metric', 'Value', 'Benchmark', 'vs Benchmark'],
    ['ROAS', fmt2(p.roas), fmt2(d.benchmarks.metrics.roas), pctStr(d.benchmarks.roasVsBenchmark)],
    ['CTR (%)', fmt2(p.ctr), fmt2(d.benchmarks.metrics.ctr), pctStr(d.benchmarks.ctrVsBenchmark)],
    ['CPC (₹)', fmt2(p.cpc), fmt2(d.benchmarks.metrics.cpc), pctStr(d.benchmarks.cpcVsBenchmark)],
    ['CPL (₹)', fmt2(p.cpl), fmt2(d.benchmarks.metrics.cpa), pctStr(d.benchmarks.cplVsBenchmark)],
    ['Profit (₹)', inr(derived.profit), '—', '—'],
    ['Margin (%)', fmt1(derived.margin), '—', '—'],
    ['ROI (%)', fmt1(derived.roi), '—', '—'],
    ['Conv. Rate (%)', fmt1(derived.conversionRate), fmt1(d.benchmarks.metrics.conversion_rate), '—'],
    ['Budget Util. (%)', fmt1(derived.budgetUtilisation), '—', '—'],
    ['Avg Daily Spend', `₹${inr(derived.avgDailySpend)}`, '—', '—'],
    ['Remaining Budget', `₹${inr(derived.remainingBudget)}`, '—', '—'],
  ]

  y = drawTable(doc, rows, MARGIN, y, [70, 40, 40, 30], brand.primaryColor, d, pageTitle)
}

// ─── AI narrative page ────────────────────────────────────────────────────────

function buildAINarrativePage(doc: Doc, d: RenderData) {
  let y = MARGIN
  const pageTitle = 'AI Analysis & Recommendations'
  pageHeader(doc, pageTitle, d)
  y = 30

  const ai = d.ai
  const brand = d.brand

  y = sectionHeader(doc, 'Executive Summary', y, brand.primaryColor, d, pageTitle)
  y += 8
  y = addWrappedText(doc, ai.executiveSummary, MARGIN, y, CONTENT, 10, d, pageTitle)
  y += 4

  y = sectionHeader(doc, 'Key Insights', y, brand.primaryColor, d, pageTitle)
  y += 8
  for (const insight of ai.keyInsights) {
    y = addWrappedText(doc, `• ${insight}`, MARGIN + 3, y, CONTENT - 3, 9, d, pageTitle)
    y += 2
  }
  y += 4

  y = sectionHeader(doc, 'Risks', y, brand.primaryColor, d, pageTitle)
  y += 8
  for (const risk of ai.risks) {
    y = addWrappedText(doc, `⚠ ${risk}`, MARGIN + 3, y, CONTENT - 3, 9, d, pageTitle)
    y += 2
  }
  y += 4

  y = sectionHeader(doc, 'Opportunities', y, brand.primaryColor, d, pageTitle)
  y += 8
  for (const opp of ai.opportunities) {
    y = addWrappedText(doc, `↑ ${opp}`, MARGIN + 3, y, CONTENT - 3, 9, d, pageTitle)
    y += 2
  }
  y += 4

  y = sectionHeader(doc, 'Recommended Actions', y, brand.primaryColor, d, pageTitle)
  y += 8
  ai.recommendedActions.forEach((action, i) => {
    y = addWrappedText(doc, `${i + 1}. ${action}`, MARGIN + 3, y, CONTENT - 3, 9, d, pageTitle)
    y += 2
  })
  y += 4

  y = sectionHeader(doc, 'Budget Recommendation', y, brand.primaryColor, d, pageTitle)
  y += 8
  y = addWrappedText(doc, ai.budgetRecommendations, MARGIN, y, CONTENT, 9, d, pageTitle)
}

// ─── Forecast page ────────────────────────────────────────────────────────────

function buildForecastPage(doc: Doc, d: RenderData) {
  let y = MARGIN
  const pageTitle = 'Forecast & Health'
  pageHeader(doc, pageTitle, d)
  y = 30

  const brand = d.brand
  const fc = d.forecasts
  const health = d.health

  // Health detail
  y = sectionHeader(doc, `Campaign Health — Score ${health.score}/100 (Grade ${health.grade})`, y, brand.primaryColor, d, pageTitle)
  y += 8
  doc.setFontSize(9)
  doc.setTextColor(80, 80, 80)
  for (const exp of health.result.explanations) {
    // We use addWrappedText to handle potential page breaks for long health explanations
    y = addWrappedText(doc, `• ${exp}`, MARGIN + 3, y, CONTENT - 3, 9, d, pageTitle)
    y += (LINE_H - 9 * 0.45)
  }
  y += 6

  // Forecast table
  y = sectionHeader(doc, 'Spend Forecast', y, brand.primaryColor, d, pageTitle)
  y += 8
  y = drawTable(doc, [
    ['Period', 'Forecast Spend', 'Model', 'Confidence', 'Trend'],
    ['7 days',  `₹${inr(fc.spend7d.predicted_value)}`,  fc.spend7d.model_used,  `${fc.spend7d.confidence}%`,  fc.spend7d.trend],
    ['30 days', `₹${inr(fc.spend30d.predicted_value)}`, fc.spend30d.model_used, `${fc.spend30d.confidence}%`, fc.spend30d.trend],
    ['90 days', `₹${inr(fc.spend90d.predicted_value)}`, fc.spend90d.model_used, `${fc.spend90d.confidence}%`, fc.spend90d.trend],
  ], MARGIN, y, [40, 45, 45, 30, 20], brand.primaryColor, d, pageTitle)

  y += 12
  y = sectionHeader(doc, 'Leads Forecast', y, brand.primaryColor, d, pageTitle)
  y += 8
  y = drawTable(doc, [
    ['Period', 'Forecast Leads', 'Model', 'Confidence', 'Trend'],
    ['7 days',  fmt2(fc.leads7d.predicted_value),  fc.leads7d.model_used,  `${fc.leads7d.confidence}%`,  fc.leads7d.trend],
    ['30 days', fmt2(fc.leads30d.predicted_value), fc.leads30d.model_used, `${fc.leads30d.confidence}%`, fc.leads30d.trend],
  ], MARGIN, y, [40, 45, 45, 30, 20], brand.primaryColor, d, pageTitle)
}

// ─── Footers ──────────────────────────────────────────────────────────────────

function addFooters(doc: Doc, d: RenderData) {
  const total = doc.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setTextColor(160, 160, 160)
    doc.setFont('helvetica', 'normal')

    const footerText = d.brand.footerText
      ?? (d.brand.showPoweredBy ? `Powered by ${d.brand.agencyName}` : d.brand.agencyName)

    doc.text(footerText, MARGIN, 285)
    doc.text(`Page ${i} of ${total}`, PAGE_W - MARGIN, 285, { align: 'right' })

    if (d.brand.confidentialWatermark) {
      doc.setFontSize(48)
      doc.setTextColor(240, 240, 240)
      doc.text('CONFIDENTIAL', PAGE_W / 2, 150, { angle: 45, align: 'center' })
    }
  }
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function pageHeader(doc: Doc, title: string, d: RenderData) {
  setFill(doc, d.brand.primaryColor)
  doc.rect(0, 0, PAGE_W, 22, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(12)
  doc.setFont('helvetica', 'bold')
  doc.text(title, MARGIN, 14)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.text(`${d.project.campaignName} · ${d.config.dateFrom} – ${d.config.dateTo}`, PAGE_W - MARGIN, 14, { align: 'right' })
}

function sectionHeader(doc: Doc, label: string, y: number, color: string, d?: RenderData, pageTitle?: string): number {
  let currentY = y
  const MAX_Y = 265
  if (currentY + 15 > MAX_Y) {
    doc.addPage()
    currentY = MARGIN
    if (d && pageTitle) {
      pageHeader(doc, pageTitle + ' (continued)', d)
      currentY = 30
    }
  }

  setDraw(doc, color)
  doc.setLineWidth(0.5)
  doc.line(MARGIN, currentY + 4, PAGE_W - MARGIN, currentY + 4)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(40, 40, 40)
  doc.text(label, MARGIN, currentY + 1)
  
  return currentY
}

function drawTable(doc: Doc, rows: string[][], x: number, y: number, colWidths: number[], headerColor: string, d?: RenderData, pageTitle?: string): number {
  const rowH = 8
  const MAX_Y = 265
  let currentY = y

  rows.forEach((row, ri) => {
    if (currentY + rowH > MAX_Y) {
      doc.addPage()
      currentY = MARGIN
      if (d && pageTitle) {
        pageHeader(doc, pageTitle + ' (continued)', d)
        currentY = 30
      }
      // Re-draw table header on new page if breaking mid-table
      if (ri > 0) {
        setFill(doc, headerColor)
        doc.rect(x, currentY, colWidths.reduce((a, b) => a + b, 0), rowH, 'F')
        doc.setTextColor(255, 255, 255)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(8)
        let cx = x + 2
        rows[0].forEach((cell, ci) => {
          doc.text(String(cell), cx, currentY + 5.5)
          cx += colWidths[ci] ?? 30
        })
        currentY += rowH
      }
    }

    if (ri === 0) {
      setFill(doc, headerColor)
      doc.rect(x, currentY, colWidths.reduce((a, b) => a + b, 0), rowH, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
    } else {
      doc.setFillColor(ri % 2 === 0 ? 248 : 255, ri % 2 === 0 ? 248 : 255, ri % 2 === 0 ? 252 : 255)
      doc.rect(x, currentY, colWidths.reduce((a, b) => a + b, 0), rowH, 'F')
      doc.setTextColor(40, 40, 40)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
    }
    let cx = x + 2
    row.forEach((cell, ci) => {
      doc.text(String(cell), cx, currentY + 5.5)
      cx += colWidths[ci] ?? 30
    })
    
    currentY += rowH
  })
  return currentY
}

function addWrappedText(doc: Doc, text: string, x: number, y: number, maxW: number, size: number, d?: RenderData, pageTitle?: string): number {
  doc.setFontSize(size)
  doc.setTextColor(60, 60, 60)
  doc.setFont('helvetica', 'normal')
  const lines = doc.splitTextToSize(text, maxW)
  const lineHeight = size * 0.45
  const MAX_Y = 265
  
  let currentY = y
  
  lines.forEach((line: string) => {
    if (currentY + lineHeight > MAX_Y) {
      doc.addPage()
      currentY = MARGIN
      if (d && pageTitle) {
        pageHeader(doc, pageTitle + ' (continued)', d)
        currentY = 30
      }
      doc.setFontSize(size)
      doc.setTextColor(60, 60, 60)
      doc.setFont('helvetica', 'normal')
    }
    doc.text(line, x, currentY)
    currentY += lineHeight
  })
  
  return currentY
}

function setFill(doc: Doc, hex: string) {
  const [r, g, b] = hexToRgb(hex)
  doc.setFillColor(r, g, b)
}

function setDraw(doc: Doc, hex: string) {
  const [r, g, b] = hexToRgb(hex)
  doc.setDrawColor(r, g, b)
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function gradeToRgb(grade: string): string {
  const map: Record<string, string> = { A: '#16A34A', B: '#2563EB', C: '#D97706', D: '#EA580C', F: '#DC2626' }
  return map[grade] ?? '#6B7280'
}

// ─── Number formatters ────────────────────────────────────────────────────────

const inr  = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmt1 = (n: number) => n.toFixed(1)
const fmt2 = (n: number) => n.toFixed(2)
const fmtN = (n: number) => Math.round(n).toLocaleString('en-IN')

function pctStr(v: number): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}%`
}
