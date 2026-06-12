import { jsPDF } from 'jspdf'
import type { PayslipData } from './types'

/** Brand palette as RGB tuples for jsPDF. */
const RGB = {
  ink:   [17, 24, 39] as [number, number, number],
  navy:  [11, 17, 32] as [number, number, number],
  card:  [15, 23, 42] as [number, number, number],
  line:  [31, 41, 55] as [number, number, number],
  text:  [229, 231, 235] as [number, number, number],
  muted: [156, 163, 175] as [number, number, number],
  faint: [107, 114, 128] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
  accent:[124, 58, 237] as [number, number, number],
  accent2:[96, 165, 250] as [number, number, number],
  green: [52, 211, 153] as [number, number, number],
  amber: [251, 191, 36] as [number, number, number],
  red:   [248, 113, 113] as [number, number, number],
}
const BAND_RGB: Record<string, [number, number, number]> = {
  '100': RGB.green, '76-99': RGB.accent2, '51-75': [167, 139, 250], '26-50': RGB.amber, '0-25': RGB.red,
}
const SALARY_TYPE_LABEL: Record<string, string> = {
  pure_commission: 'Pure Commission', fixed: 'Fixed Salary',
  base_plus_commission: 'Base + Commission', fixed_plus_bonus: 'Fixed + Bonus', hourly: 'Hourly',
}

// Rupee glyph isn't in jsPDF's standard fonts — use "Rs " for reliable rendering.
const inr = (n: number) =>
  'Rs ' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

/** Render a payslip PDF and return it as a Buffer (for email attachment). */
export function renderPayslipPdf(d: PayslipData): Buffer {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = 595.28
  const M = 40                 // page margin
  const innerW = W - M * 2
  let y = 0

  const s = d.salary
  const statusPaid = s.status === 'paid'

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(...RGB.ink)
  doc.rect(0, 0, W, 96, 'F')
  doc.setTextColor(...RGB.white)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(24)
  doc.text('cirqle', M, 50)
  doc.setTextColor(...RGB.accent2); doc.text('.', M + 62, 50)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...RGB.muted)
  doc.text('D E S I G N', M + 1, 64)

  // status pill
  const pillText = statusPaid ? 'PAID' : 'PENDING'
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9)
  const pillW = doc.getTextWidth(pillText) + 24
  const pc = statusPaid ? RGB.green : RGB.amber
  doc.setFillColor(pc[0], pc[1], pc[2])
  doc.roundedRect(W - M - pillW, 34, pillW, 20, 10, 10, 'F')
  doc.setTextColor(...RGB.ink)
  doc.text(pillText, W - M - pillW + 12, 48)

  // ── Title strip ────────────────────────────────────────────────────────────
  doc.setFillColor(...RGB.card)
  doc.rect(0, 96, W, 96, 'F')
  doc.setTextColor(...RGB.muted); doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.text('SALARY SLIP', M, 124)
  doc.setTextColor(...RGB.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(22)
  doc.text(d.period.label, M, 150)

  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...RGB.text)
  doc.text(d.employee.name, M, 176)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...RGB.muted)
  doc.text(`${d.employee.cqid}${d.employee.designation ? '  ·  ' + d.employee.designation : ''}`, M, 190)

  if (d.payslipNumber) {
    doc.setFontSize(9); doc.setTextColor(...RGB.faint)
    doc.text('Payslip No.', W - M, 176, { align: 'right' })
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...RGB.text)
    doc.text(String(d.payslipNumber), W - M, 190, { align: 'right' })
  }

  y = 224

  // ── Salary breakdown ───────────────────────────────────────────────────────
  const lineRow = (label: string, value: string, color = RGB.text, bold = false) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...RGB.muted)
    doc.text(label, M, y)
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setTextColor(color[0], color[1], color[2])
    doc.text(value, W - M, y, { align: 'right' })
    y += 22
  }
  const gross = s.baseSalary + s.commission + s.bonus
  const deductions = s.advancesDeducted + s.otherDeductions

  doc.setTextColor(...RGB.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(12)
  doc.text('Earnings & Deductions', M, y); y += 22
  if (s.baseSalary > 0) lineRow('Base Salary', inr(s.baseSalary))
  lineRow('Creative Rewards', inr(s.commission), RGB.green)
  if (s.bonus > 0) lineRow('Bonus', inr(s.bonus), RGB.green)
  doc.setDrawColor(...RGB.line); doc.line(M, y - 12, W - M, y - 12)
  lineRow('Gross', inr(gross), RGB.text, true)
  if (s.advancesDeducted > 0) lineRow('Advance Deducted', '- ' + inr(s.advancesDeducted), RGB.red)
  if (s.otherDeductions > 0) lineRow('Other Deductions', '- ' + inr(s.otherDeductions), RGB.red)

  // ── Net pay box ────────────────────────────────────────────────────────────
  y += 4
  const boxH = 56
  doc.setFillColor(26, 22, 50)            // muted purple fill
  doc.roundedRect(M, y, innerW, boxH, 10, 10, 'F')
  doc.setDrawColor(...RGB.accent); doc.roundedRect(M, y, innerW, boxH, 10, 10, 'S')
  doc.setTextColor(...RGB.muted); doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.text(`NET ${statusPaid ? 'PAID' : 'PAYABLE'}`, M + 16, y + 24)
  doc.setFontSize(8); doc.setTextColor(...RGB.faint)
  doc.text(
    `${SALARY_TYPE_LABEL[s.salaryType] || s.salaryType}${deductions > 0 ? `  ·  after ${inr(deductions)} deductions` : ''}`,
    M + 16, y + 40,
  )
  doc.setTextColor(...RGB.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(22)
  doc.text(inr(s.netSalary), W - M - 16, y + 30, { align: 'right' })
  if (statusPaid && s.paidDate) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...RGB.green)
    doc.text(`Paid ${new Date(s.paidDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      W - M - 16, y + 44, { align: 'right' })
  }
  y += boxH + 28

  // ── Attendance + tasks contributed (two cards) ────────────────────────────
  const cardW = (innerW - 16) / 2
  const cardH = 60
  // days active
  doc.setFillColor(...RGB.navy); doc.setDrawColor(...RGB.line)
  doc.roundedRect(M, y, cardW, cardH, 8, 8, 'FD')
  doc.setTextColor(...RGB.muted); doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  doc.text('DAYS ACTIVE', M + 14, y + 20)
  doc.setTextColor(...RGB.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(22)
  doc.text(`${d.attendance.workedDays}`, M + 14, y + 46)
  doc.setTextColor(...RGB.faint); doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  doc.text(`/ ${d.attendance.daysInMonth} days`, M + 46, y + 46)
  // tasks contributed
  const ax = M + cardW + 16
  doc.setFillColor(...RGB.navy); doc.roundedRect(ax, y, cardW, cardH, 8, 8, 'FD')
  doc.setTextColor(...RGB.muted); doc.setFontSize(8)
  doc.text('TASKS CONTRIBUTED', ax + 14, y + 20)
  doc.setTextColor(...RGB.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(22)
  doc.text(`${d.totals.monthTaskCount}`, ax + 14, y + 46)
  doc.setTextColor(...RGB.faint); doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  doc.text('creatives this month', ax + 44, y + 46)
  y += cardH + 28

  // ── Contribution quality (count only — no per-band earnings) ─────────────
  doc.setTextColor(...RGB.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(12)
  doc.text('Contribution Quality', M, y); y += 16
  doc.setTextColor(...RGB.faint); doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  doc.text(`${d.period.label}  ·  ${d.totals.monthTaskCount} task${d.totals.monthTaskCount !== 1 ? 's' : ''} contributed`, M, y); y += 16

  doc.setFontSize(8); doc.setTextColor(...RGB.faint)
  doc.text('QUALITY BAND', M, y)
  doc.text('COUNT', W - M, y, { align: 'right' })
  y += 6; doc.setDrawColor(...RGB.line); doc.line(M, y, W - M, y); y += 14

  if (d.contributionRanges.length === 0) {
    doc.setTextColor(...RGB.faint); doc.setFontSize(9)
    doc.text('No scored contributions this month.', M, y); y += 18
  } else {
    for (const b of d.contributionRanges) {
      const c = BAND_RGB[b.band]
      doc.setFillColor(c[0], c[1], c[2]); doc.roundedRect(M, y - 8, 8, 8, 2, 2, 'F')
      doc.setTextColor(...RGB.text); doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
      doc.text(b.label, M + 16, y)
      doc.setTextColor(...RGB.muted); doc.setFont('helvetica', 'bold')
      doc.text(`${b.count} task${b.count !== 1 ? 's' : ''}`, W - M, y, { align: 'right' })
      y += 20
    }
  }
  y += 14

  // ── Last 6 months earnings (mini bar chart) ────────────────────────────────
  doc.setTextColor(...RGB.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(12)
  doc.text('Last 6 Months Earnings', M, y); y += 16
  doc.setTextColor(...RGB.faint); doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  doc.text(`Total ${inr(d.totals.sixMonthTotal)}  ·  contribution earnings`, M, y); y += 18

  const chartH = 90
  const slotW = innerW / 6
  const maxEarn = Math.max(1, ...d.sixMonthEarnings.map(m => m.earnings))
  const baseY = y + chartH
  d.sixMonthEarnings.forEach((m, i) => {
    const cx = M + slotW * i + slotW / 2
    const barW = Math.min(46, slotW - 14)
    const h = Math.max(3, (m.earnings / maxEarn) * chartH)
    const isCur = m.month === d.period.month && m.year === d.period.year
    const col = isCur ? RGB.accent : RGB.line
    doc.setFillColor(col[0], col[1], col[2])
    doc.roundedRect(cx - barW / 2, baseY - h, barW, h, 3, 3, 'F')
    doc.setTextColor(...RGB.faint); doc.setFontSize(7)
    if (m.earnings > 0) doc.text(inr(m.earnings).replace('Rs ', ''), cx, baseY - h - 4, { align: 'center' })
    doc.setTextColor(isCur ? RGB.accent2[0] : RGB.muted[0], isCur ? RGB.accent2[1] : RGB.muted[1], isCur ? RGB.accent2[2] : RGB.muted[2])
    doc.setFont('helvetica', isCur ? 'bold' : 'normal'); doc.setFontSize(8)
    doc.text(m.shortLabel, cx, baseY + 14, { align: 'center' })
  })
  y = baseY + 34

  // ── Footer (pinned to bottom) ──────────────────────────────────────────────
  const footH = 64
  const footY = 842 - footH
  doc.setFillColor(...RGB.ink); doc.rect(0, footY, W, footH, 'F')
  doc.setTextColor(...RGB.text); doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
  doc.text(d.company.name, W / 2, footY + 24, { align: 'center' })
  doc.setTextColor(...RGB.faint); doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  doc.text(`${d.company.website}   ·   ${d.company.email}   ·   ${d.company.phone}`, W / 2, footY + 40, { align: 'center' })
  doc.setFontSize(7)
  doc.text('For queries, reply to the payslip email.', W / 2, footY + 54, { align: 'center' })

  const ab = doc.output('arraybuffer')
  return Buffer.from(ab)
}

/** Filename for the attachment, e.g. "Payslip-CQID002-May-2026.pdf". */
export function payslipFilename(d: PayslipData): string {
  return `Payslip-${d.employee.cqid}-${d.period.monthName}-${d.period.year}.pdf`
}
