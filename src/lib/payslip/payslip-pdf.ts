import { jsPDF } from 'jspdf'
import sharp from 'sharp'
import type { PayslipData } from './types'
import { round2 } from '@/lib/calculations/currency'
import { adjustmentLabel, ownershipRowLabel } from './payslip-html'

// Professional light palette — A4, white background
const C = {
  white:        [255, 255, 255] as [number, number, number],
  headBg:       [249, 250, 251] as [number, number, number],
  border:       [229, 231, 235] as [number, number, number],
  ink:          [17, 24, 39] as [number, number, number],
  body:         [55, 65, 81] as [number, number, number],
  muted:        [107, 114, 128] as [number, number, number],
  faint:        [156, 163, 175] as [number, number, number],
  accent:       [124, 58, 237] as [number, number, number],
  accentLight:  [245, 243, 255] as [number, number, number],
  accentBorder: [221, 214, 254] as [number, number, number],
  green:        [22, 163, 74] as [number, number, number],
  greenBg:      [240, 253, 244] as [number, number, number],
  greenBorder:  [187, 247, 208] as [number, number, number],
  amber:        [217, 119, 6] as [number, number, number],
  amberBg:      [255, 251, 235] as [number, number, number],
  amberBorder:  [253, 230, 138] as [number, number, number],
  red:          [220, 38, 38] as [number, number, number],
  redBg:        [254, 242, 242] as [number, number, number],
  redBorder:    [254, 202, 202] as [number, number, number],
}

const BAND_DOT: Record<string, [number, number, number]> = {
  '100':   [22, 163, 74],
  '76-99': [37, 99, 235],
  '51-75': [124, 58, 237],
  '26-50': [217, 119, 6],
  '0-25':  [220, 38, 38],
}

const SALARY_TYPE_LABEL: Record<string, string> = {
  pure_commission:      'Commission-based',
  fixed:                'Fixed',
  base_plus_commission: 'Base + Commission',
  fixed_plus_bonus:     'Fixed + Bonus',
  hourly:               'Hourly',
}

const MILESTONES = [50000, 100000, 150000, 200000, 300000, 500000, 1000000]
function getMilestone(total: number): number | null {
  let hit: number | null = null
  for (const m of MILESTONES) { if (total >= m) hit = m }
  return hit
}

// Rs prefix — Rupee glyph not reliably embedded in jsPDF standard fonts
const inr = (n: number) =>
  'Rs ' + round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Fetch a remote image, resize to ≤240×72 px via sharp, return PNG data-URI (or null). */
async function fetchLogoDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = Buffer.from(await res.arrayBuffer())
    const resized = await sharp(raw)
      .resize({ width: 240, height: 72, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer()
    return 'data:image/png;base64,' + resized.toString('base64')
  } catch {
    return null
  }
}

/** Render a professional A4 payslip PDF suitable for submission to employers. */
export async function renderPayslipPdf(d: PayslipData): Promise<Buffer> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = 595.28
  const H = 841.89
  const M = 44
  const iW = W - M * 2   // 507.28 pt
  let y = 0

  const s = d.salary
  const statusPaid = s.status === 'paid'
  const gross = s.baseSalary + s.commission + s.bonus + (s.adjustment || 0) + (s.ownership || 0)
  const totalDeductions = s.advancesDeducted + s.otherDeductions

  // Pre-fetch logo if available
  const logoDataUrl = d.company.logoUrl ? await fetchLogoDataUrl(d.company.logoUrl) : null

  // White background
  doc.setFillColor(...C.white)
  doc.rect(0, 0, W, H, 'F')

  // ── Top accent stripe ──────────────────────────────────────────────────────
  doc.setFillColor(...C.accent)
  doc.rect(0, 0, W, 4, 'F')

  // ── Letterhead ─────────────────────────────────────────────────────────────
  y = 24

  if (logoDataUrl) {
    // Render actual logo image, max 120×36 pt
    doc.addImage(logoDataUrl, 'PNG', M, y, 120, 36)
    y += 44
  } else {
    // Text fallback
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.setTextColor(...C.ink)
    doc.text('cirqle', M, y + 18)
    const cqW = doc.getTextWidth('cirqle')
    doc.setTextColor(...C.accent)
    doc.text('.', M + cqW, y + 18)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...C.muted)
    doc.text('D E S I G N', M + 1, y + 29)
    y += 44
  }

  // Company contact — right aligned
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(...C.muted)
  doc.text(d.company.name, W - M, y + 8, { align: 'right' })
  doc.setFontSize(8)
  doc.setTextColor(...C.faint)
  doc.text(d.company.website, W - M, y + 19, { align: 'right' })
  doc.text(d.company.email, W - M, y + 30, { align: 'right' })
  doc.text(d.company.phone, W - M, y + 41, { align: 'right' })

  y += 48

  // Full-width separator
  doc.setDrawColor(...C.border)
  doc.setLineWidth(0.5)
  doc.line(0, y, W, y)
  y += 0

  // ── Title band ─────────────────────────────────────────────────────────────
  doc.setFillColor(...C.headBg)
  doc.rect(0, y, W, 36, 'F')
  doc.setDrawColor(...C.border)
  doc.line(0, y + 36, W, y + 36)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...C.faint)
  doc.text('SALARY SLIP', M, y + 15)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(...C.ink)
  doc.text(d.period.label, M, y + 28)

  if (d.payslipNumber) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...C.faint)
    doc.text('Payslip No.', W - M, y + 14, { align: 'right' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...C.accent)
    doc.text(d.payslipNumber, W - M, y + 28, { align: 'right' })
  }

  y += 36 + 16

  // ── Employee + Pay Period info boxes ───────────────────────────────────────
  const halfW = (iW - 12) / 2
  const infoH = 76

  // Left: employee
  doc.setFillColor(...C.headBg)
  doc.setDrawColor(...C.border)
  doc.roundedRect(M, y, halfW, infoH, 5, 5, 'FD')
  const lx = M + 14
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C.faint)
  doc.text('EMPLOYEE', lx, y + 13)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...C.ink)
  doc.text(d.employee.name, lx, y + 29)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...C.body)
  doc.text(`${d.employee.cqid}${d.employee.designation ? '  ·  ' + d.employee.designation : ''}`, lx, y + 43)
  if (d.employee.email) {
    doc.setFontSize(8); doc.setTextColor(...C.muted)
    doc.text(d.employee.email, lx, y + 57)
  }
  doc.setFontSize(8); doc.setTextColor(...C.faint)
  const issueDate = new Date(d.generatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  doc.text(`Issued: ${issueDate}`, lx, y + 69)

  // Right: pay period + status
  const rx = M + halfW + 12
  doc.setFillColor(...C.headBg)
  doc.roundedRect(rx, y, halfW, infoH, 5, 5, 'FD')
  const rx2 = rx + 14
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C.faint)
  doc.text('PAY PERIOD', rx2, y + 13)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...C.ink)
  doc.text(d.period.label, rx2, y + 29)

  // Status pill
  const stText = statusPaid ? 'PAID' : 'PENDING'
  const stC = statusPaid ? C.green : C.amber
  const stBg = statusPaid ? C.greenBg : C.amberBg
  const stBd = statusPaid ? C.greenBorder : C.amberBorder
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8)
  const stW = doc.getTextWidth(stText) + 16
  doc.setFillColor(...stBg); doc.setDrawColor(...stBd)
  doc.roundedRect(rx2, y + 35, stW, 16, 8, 8, 'FD')
  doc.setTextColor(stC[0], stC[1], stC[2])
  doc.text(stText, rx2 + stW / 2, y + 47, { align: 'center' })

  if (statusPaid && s.paidDate) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.muted)
    doc.text(
      `Paid: ${new Date(s.paidDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      rx2, y + 62,
    )
  }

  y += infoH + 20

  // ── Row helper (used for earnings and deductions tables) ───────────────────
  const ROW_H = 26
  const tableRow = (label: string, amount: string, amtColor = C.body, bold = false) => {
    doc.setFillColor(...C.white)
    doc.setDrawColor(...C.border)
    doc.rect(M, y, iW, ROW_H, 'FD')
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...C.body)
    doc.text(label, M + 12, y + 17)
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setTextColor(amtColor[0], amtColor[1], amtColor[2])
    doc.text(amount, W - M - 12, y + 17, { align: 'right' })
    y += ROW_H
  }

  // ── Earnings table ─────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.faint)
  doc.text('EARNINGS', M, y); y += 6

  doc.setFillColor(...C.headBg); doc.setDrawColor(...C.border)
  doc.rect(M, y, iW, ROW_H, 'FD')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.muted)
  doc.text('DESCRIPTION', M + 12, y + 17)
  doc.text('AMOUNT (INR)', W - M - 12, y + 17, { align: 'right' })
  y += ROW_H

  if (s.baseSalary > 0) tableRow('Base Salary', inr(s.baseSalary))
  tableRow('Creative Rewards', inr(s.commission), C.green)
  if (s.bonus > 0) tableRow('Bonus', inr(s.bonus), C.green)
  // Corrections for already-closed months, paid with this payslip and labelled
  // with the month they came from.
  if (s.adjustment) {
    tableRow(
      adjustmentLabel(s.adjustmentSources),
      (s.adjustment < 0 ? '- ' : '') + inr(Math.abs(s.adjustment)),
      s.adjustment < 0 ? C.red : C.green,
    )
  }

  // Ownership rewards, one line per program so the amount is explained.
  if ((s.ownershipAwards ?? []).length > 0) {
    for (const a of s.ownershipAwards) tableRow(ownershipRowLabel(a), inr(a.earnedInr), C.green)
  } else if (s.ownership) {
    tableRow('Ownership Reward', inr(s.ownership), C.green)
  }

  // Gross subtotal
  doc.setFillColor(245, 243, 255); doc.setDrawColor(...C.accentBorder)
  doc.rect(M, y, iW, ROW_H, 'FD')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...C.ink)
  doc.text('Gross Earnings', M + 12, y + 17)
  doc.text(inr(gross), W - M - 12, y + 17, { align: 'right' })
  y += ROW_H + 16

  // ── Deductions table (only when present) ───────────────────────────────────
  if (totalDeductions > 0) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.faint)
    doc.text('DEDUCTIONS', M, y); y += 6

    doc.setFillColor(...C.headBg); doc.setDrawColor(...C.border)
    doc.rect(M, y, iW, ROW_H, 'FD')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.muted)
    doc.text('DESCRIPTION', M + 12, y + 17)
    doc.text('AMOUNT (INR)', W - M - 12, y + 17, { align: 'right' })
    y += ROW_H

    if (s.advancesDeducted > 0) tableRow('Advance Deducted', '- ' + inr(s.advancesDeducted), C.red)
    if (s.otherDeductions > 0) tableRow('Other Deductions', '- ' + inr(s.otherDeductions), C.red)

    doc.setFillColor(...C.redBg); doc.setDrawColor(...C.redBorder)
    doc.rect(M, y, iW, ROW_H, 'FD')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...C.ink)
    doc.text('Total Deductions', M + 12, y + 17)
    doc.setTextColor(...C.red)
    doc.text('- ' + inr(totalDeductions), W - M - 12, y + 17, { align: 'right' })
    y += ROW_H + 16
  }

  // ── Net Pay box ────────────────────────────────────────────────────────────
  const netH = 58
  doc.setFillColor(...C.accentLight); doc.setDrawColor(...C.accentBorder)
  doc.roundedRect(M, y, iW, netH, 8, 8, 'FD')
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...C.muted)
  doc.text(`NET ${statusPaid ? 'PAID' : 'PAYABLE'}`, M + 14, y + 20)
  doc.setFontSize(8); doc.setTextColor(...C.faint)
  const typeLabel = SALARY_TYPE_LABEL[s.salaryType] || s.salaryType
  doc.text(
    typeLabel + (totalDeductions > 0 ? `  ·  after ${inr(totalDeductions)} deductions` : ''),
    M + 14, y + 34,
  )
  doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.setTextColor(...C.accent)
  doc.text(inr(s.netSalary), W - M - 14, y + 38, { align: 'right' })
  if (statusPaid && s.paidDate) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.green)
    doc.text(
      `Paid ${new Date(s.paidDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      W - M - 14, y + 52, { align: 'right' },
    )
  }
  y += netH + 20

  // ── Attendance cards ───────────────────────────────────────────────────────
  const cardW = (iW - 12) / 2
  const cardH = 54

  // Days Active
  doc.setFillColor(...C.white); doc.setDrawColor(...C.border)
  doc.roundedRect(M, y, cardW, cardH, 5, 5, 'FD')
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C.faint)
  doc.text('DAYS ACTIVE', M + 12, y + 13)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(...C.ink)
  doc.text(`${d.attendance.workedDays}`, M + 12, y + 36)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.muted)
  doc.text(`/ ${d.attendance.daysInMonth} days`, M + 12, y + 48)

  // Tasks Contributed
  const ax = M + cardW + 12
  doc.setFillColor(...C.white)
  doc.roundedRect(ax, y, cardW, cardH, 5, 5, 'FD')
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C.faint)
  doc.text('TASKS CONTRIBUTED', ax + 12, y + 13)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(...C.ink)
  doc.text(`${d.totals.monthTaskCount}`, ax + 12, y + 36)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.muted)
  doc.text('creatives this month', ax + 12, y + 48)

  y += cardH + 20

  // ── Work Performance table ─────────────────────────────────────────────────
  if (d.contributionRanges.length > 0) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.faint)
    doc.text('WORK PERFORMANCE', M, y); y += 6

    doc.setFillColor(...C.headBg); doc.setDrawColor(...C.border)
    doc.rect(M, y, iW, ROW_H, 'FD')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.muted)
    doc.text('QUALITY BAND', M + 12, y + 17)
    doc.text('TASKS', W - M - 12, y + 17, { align: 'right' })
    y += ROW_H

    for (const b of d.contributionRanges) {
      const dot = BAND_DOT[b.band]
      doc.setFillColor(...C.white); doc.setDrawColor(...C.border)
      doc.rect(M, y, iW, ROW_H, 'FD')
      // Dot — using roundedRect as a circle
      doc.setFillColor(dot[0], dot[1], dot[2])
      doc.roundedRect(M + 14, y + ROW_H / 2 - 3.5, 7, 7, 3.5, 3.5, 'F')
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...C.body)
      doc.text(b.label, M + 28, y + 17)
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.ink)
      doc.text(`${b.count} task${b.count !== 1 ? 's' : ''}`, W - M - 12, y + 17, { align: 'right' })
      y += ROW_H
    }
    doc.setDrawColor(...C.border); doc.line(M, y, W - M, y)
    y += 20
  }

  // ── Milestone banner ────────────────────────────────────────────────────────
  const milestone = getMilestone(d.totals.sixMonthTotal)
  if (milestone) {
    doc.setFillColor(...C.accentLight); doc.setDrawColor(...C.accentBorder)
    doc.roundedRect(M, y, iW, 38, 8, 8, 'FD')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.accent)
    doc.text('MILESTONE', M + 12, y + 13)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...C.body)
    doc.text(
      `You've earned over Rs ${milestone.toLocaleString('en-IN')} in the last 6 months — great work!`,
      M + 12, y + 28,
    )
    y += 38 + 18
  }

  // ── Authorised Signatory ───────────────────────────────────────────────────
  // Pin it either just below content or at a minimum distance from footer
  const sigMinY = H - 140
  const sigY = Math.max(y + 16, sigMinY)
  doc.setDrawColor(...C.border)
  doc.line(W - M - 130, sigY, W - M, sigY)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.muted)
  doc.text('Authorised Signatory', W - M - 65, sigY + 12, { align: 'center' })
  doc.setFontSize(7); doc.setTextColor(...C.faint)
  doc.text(d.company.name, W - M - 65, sigY + 22, { align: 'center' })

  // ── Footer ──────────────────────────────────────────────────────────────────
  const footH = 50
  const footY = H - footH
  doc.setFillColor(...C.headBg); doc.setDrawColor(...C.border)
  doc.rect(0, footY, W, footH, 'F')
  doc.line(0, footY, W, footY)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...C.ink)
  doc.text(d.company.name, W / 2, footY + 17, { align: 'center' })
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.muted)
  doc.text(
    `${d.company.website}   ·   ${d.company.email}   ·   ${d.company.phone}`,
    W / 2, footY + 30, { align: 'center' },
  )
  doc.setFontSize(7); doc.setTextColor(...C.faint)
  doc.text('For queries, reply to the payslip email.', W / 2, footY + 43, { align: 'center' })

  return Buffer.from(doc.output('arraybuffer'))
}

/** Filename for the attachment — e.g. "Payslip-CQID002-May-2026.pdf". */
export function payslipFilename(d: PayslipData): string {
  return `Payslip-${d.employee.cqid}-${d.period.monthName}-${d.period.year}.pdf`
}
