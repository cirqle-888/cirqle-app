import type { PayslipData } from './types'

/** Light-mode brand palette (hex only — email-safe). */
const C = {
  bg:      '#f3f4f6',
  card:    '#ffffff',
  head:    '#f9fafb',
  border:  '#e5e7eb',
  ink:     '#111827',
  body:    '#374151',
  muted:   '#6b7280',
  faint:   '#9ca3af',
  accent:  '#7c3aed',
  accent2: '#a78bfa',
  green:   '#16a34a',
  greenBg: '#f0fdf4',
  amber:   '#d97706',
  amberBg: '#fffbeb',
  red:     '#dc2626',
  bar:     '#ddd6fe', // light purple for non-current bars
  barCur:  '#7c3aed',
}

const BAND_DOT: Record<string, string> = {
  '100':   '#16a34a',
  '76-99': '#2563eb',
  '51-75': '#7c3aed',
  '26-50': '#d97706',
  '0-25':  '#dc2626',
}

const SALARY_TYPE_LABEL: Record<string, string> = {
  pure_commission:      'Pure Commission',
  fixed:                'Fixed Salary',
  base_plus_commission: 'Base + Commission',
  fixed_plus_bonus:     'Fixed + Bonus',
  hourly:               'Hourly',
}

const inr = (n: number) =>
  '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

const MILESTONES = [50000, 100000, 150000, 200000, 300000, 500000, 1000000]
function getMilestone(total: number): number | null {
  let hit: number | null = null
  for (const m of MILESTONES) { if (total >= m) hit = m }
  return hit
}

function salaryRow(label: string, value: string, color = C.ink, bold = false) {
  return `
    <tr>
      <td style="padding:7px 0 7px 0;font-size:13px;color:${C.muted};">${label}</td>
      <td style="padding:7px 0;text-align:right;font-size:13px;font-weight:${bold ? 700 : 500};color:${color};">${value}</td>
    </tr>`
}

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

/**
 * Names the closed month(s) an adjustment came from, so the line reads
 * "Adjustment (Jul 2026)" rather than an unexplained extra amount.
 */
export function adjustmentLabel(
  sources: { month: number; year: number; amountInr: number }[] | undefined,
): string {
  const list = sources ?? []
  if (list.length === 0) return 'Previous Month Adjustment'
  const uniq = [...new Set(list.map(s => `${SHORT_MONTHS[s.month - 1]} ${s.year}`))]
  if (uniq.length === 1) return `Adjustment (${uniq[0]})`
  if (uniq.length <= 3) return `Adjustment (${uniq.join(', ')})`
  return `Adjustment (${uniq.length} previous months)`
}

/**
 * Label for one ownership line: the program, the hat the person wore, and the
 * rate — "Manager Revenue Share · Ops Manager (2% of billing)". Showing the
 * rate is what turns a number into something an employee can check.
 */
export function ownershipRowLabel(a: {
  programName: string; label: string | null; basis: string; percent: number | null
}): string {
  const hat = a.label ? ` · ${a.label}` : ''
  const rate = a.percent != null ? ` (${a.percent}% of ${a.basis})` : ''
  return `${a.programName}${hat}${rate}`
}

/** Full HTML email body — light theme, no per-band earnings, no performance %. */
export function renderPayslipHtml(d: PayslipData, note?: string): string {
  const s = d.salary
  const gross = s.baseSalary + s.commission + s.bonus + (s.adjustment || 0) + (s.ownership || 0)
  const deductions = s.advancesDeducted + s.otherDeductions
  const statusPaid = s.status === 'paid'

  // ── 6-month bar chart (table-based, email-safe) ────────────────────────────
  const maxEarn = Math.max(1, ...d.sixMonthEarnings.map(m => m.earnings))
  const bars = d.sixMonthEarnings.map(m => {
    const h = Math.max(4, Math.round((m.earnings / maxEarn) * 72))
    const isCurrent = m.month === d.period.month && m.year === d.period.year
    return `
      <td style="vertical-align:bottom;text-align:center;padding:0 5px;width:${Math.floor(100 / d.sixMonthEarnings.length)}%;">
        <div style="color:${C.muted};font-size:10px;margin-bottom:4px;">${m.earnings > 0 ? inr(m.earnings) : ''}</div>
        <div style="height:${h}px;border-radius:4px 4px 0 0;background:${isCurrent ? C.barCur : C.bar};"></div>
        <div style="color:${isCurrent ? C.accent : C.faint};font-size:11px;font-weight:${isCurrent ? 700 : 400};margin-top:5px;">${m.shortLabel}</div>
      </td>`
  }).join('')

  // ── Contribution range rows (counts only — no earnings) ───────────────────
  const rangeRows = d.contributionRanges.length === 0
    ? `<tr><td colspan="2" style="padding:10px 0;color:${C.faint};font-size:12px;text-align:center;">No scored contributions this month.</td></tr>`
    : d.contributionRanges.map(b => `
      <tr style="border-top:1px solid ${C.border};">
        <td style="padding:9px 14px;font-size:13px;color:${C.body};">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${BAND_DOT[b.band]};margin-right:8px;vertical-align:middle;position:relative;top:-1px;"></span>${b.label}
        </td>
        <td style="padding:9px 14px 9px 0;text-align:right;font-size:13px;font-weight:600;color:${C.ink};">${b.count} task${b.count !== 1 ? 's' : ''}</td>
      </tr>`).join('')

  // ── Logo block ────────────────────────────────────────────────────────────
  const logoHtml = d.company.logoUrl
    ? `<img src="${d.company.logoUrl}" alt="${d.company.name}" style="max-width:140px;height:auto;display:block;">`
    : `<span style="font-size:20px;font-weight:800;color:${C.ink};letter-spacing:-0.5px;">${d.company.name}</span>`

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Payslip for ${d.period.label} — net ${inr(s.netSalary)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.border};border-radius:14px;overflow:hidden;">

        <!-- Header: logo + pill -->
        <tr><td style="background:${C.head};border-bottom:1px solid ${C.border};padding:20px 28px;">
          <table role="presentation" width="100%"><tr>
            <td style="vertical-align:middle;">${logoHtml}</td>
            <td style="text-align:right;vertical-align:middle;">
              <span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${C.ink};color:#f9fafb;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">${d.period.label} Payslip</span>
            </td>
          </tr></table>
        </td></tr>

        <!-- Employee info + payslip # + status -->
        <tr><td style="padding:22px 28px 18px;border-bottom:1px solid ${C.border};">
          <table role="presentation" width="100%"><tr>
            <td>
              <div style="font-size:16px;font-weight:700;color:${C.ink};">${d.employee.name}</div>
              <div style="font-size:12px;color:${C.muted};margin-top:3px;">${d.employee.cqid}${d.employee.designation ? ' · ' + d.employee.designation : ''}</div>
            </td>
            <td style="text-align:right;vertical-align:top;">
              ${d.payslipNumber ? `<div style="font-size:11px;color:${C.faint};">Payslip No.</div><div style="font-size:13px;font-weight:600;color:${C.ink};margin-top:1px;">${d.payslipNumber}</div>` : ''}
              <div style="display:inline-block;margin-top:6px;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${statusPaid ? C.greenBg : C.amberBg};color:${statusPaid ? C.green : C.amber};">${statusPaid ? '● PAID' : '● PENDING'}</div>
            </td>
          </tr></table>
        </td></tr>

        ${note ? `
        <!-- Personal note -->
        <tr><td style="padding:0 28px 18px;border-bottom:1px solid ${C.border};">
          <div style="background:#f5f3ff;border-left:3px solid ${C.accent};border-radius:8px;padding:12px 14px;color:${C.body};font-size:13px;line-height:1.6;">${note.replace(/\n/g, '<br>')}</div>
        </td></tr>` : ''}

        <!-- Salary breakdown -->
        <tr><td style="padding:20px 28px 0;">
          <div style="font-size:12px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Earnings &amp; Deductions</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${s.baseSalary > 0 ? salaryRow('Base Salary', inr(s.baseSalary)) : ''}
            ${salaryRow('Creative Rewards', inr(s.commission), C.green)}
            ${s.bonus > 0 ? salaryRow('Bonus', inr(s.bonus), C.green) : ''}
            ${s.adjustment ? salaryRow(
              adjustmentLabel(s.adjustmentSources),
              (s.adjustment < 0 ? '− ' : '') + inr(Math.abs(s.adjustment)),
              s.adjustment < 0 ? C.red : C.green,
            ) : ''}
            ${/* One line per ownership program, so the reward is explained
                  rather than appearing as an unexplained lump sum. */
              (s.ownershipAwards ?? []).length > 0
                ? (s.ownershipAwards ?? []).map(a => salaryRow(
                    ownershipRowLabel(a), inr(a.earnedInr), C.green,
                  )).join('')
                : (s.ownership ? salaryRow('Ownership Reward', inr(s.ownership), C.green) : '')}
            <tr><td colspan="2" style="border-top:1px solid ${C.border};padding-top:4px;"></td></tr>
            ${salaryRow('Gross', inr(gross), C.ink, true)}
            ${s.advancesDeducted > 0 ? salaryRow('Advance Deducted', '− ' + inr(s.advancesDeducted), C.red) : ''}
            ${s.otherDeductions > 0 ? salaryRow('Other Deductions', '− ' + inr(s.otherDeductions), C.red) : ''}
          </table>
        </td></tr>

        <!-- Net pay -->
        <tr><td style="padding:14px 28px 22px;">
          <table role="presentation" width="100%" style="background:linear-gradient(135deg,#f5f3ff,#ede9fe);border:1px solid #ddd6fe;border-radius:12px;"><tr>
            <td style="padding:16px 20px;">
              <div style="font-size:12px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:0.08em;">Net ${statusPaid ? 'Paid' : 'Payable'}</div>
              <div style="font-size:11px;color:${C.faint};margin-top:2px;">${SALARY_TYPE_LABEL[s.salaryType] || s.salaryType}${deductions > 0 ? ` · after ${inr(deductions)} deductions` : ''}</div>
            </td>
            <td style="padding:16px 20px;text-align:right;">
              <div style="font-size:26px;font-weight:800;color:${C.accent};">${inr(s.netSalary)}</div>
              ${statusPaid && s.paidDate ? `<div style="color:${C.green};font-size:11px;margin-top:2px;">Paid ${new Date(s.paidDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>` : ''}
            </td>
          </tr></table>
        </td></tr>

        <!-- Attendance -->
        <tr><td style="padding:0 28px 22px;border-top:1px solid ${C.border};">
          <table role="presentation" width="100%" style="margin-top:18px;"><tr>
            <td style="background:${C.head};border:1px solid ${C.border};border-radius:10px;padding:14px 18px;width:50%;">
              <div style="font-size:11px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:0.06em;">Days Active</div>
              <div style="font-size:22px;font-weight:800;color:${C.ink};margin-top:4px;">${d.attendance.workedDays}<span style="font-size:14px;font-weight:400;color:${C.faint};"> / ${d.attendance.daysInMonth}</span></div>
              <div style="font-size:11px;color:${C.faint};margin-top:2px;">${d.period.monthName} ${d.period.year}</div>
            </td>
            <td width="4%"></td>
            <td style="background:${C.head};border:1px solid ${C.border};border-radius:10px;padding:14px 18px;width:50%;">
              <div style="font-size:11px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:0.06em;">Tasks Contributed</div>
              <div style="font-size:22px;font-weight:800;color:${C.ink};margin-top:4px;">${d.totals.monthTaskCount}</div>
              <div style="font-size:11px;color:${C.faint};margin-top:2px;">creatives this month</div>
            </td>
          </tr></table>
        </td></tr>

        <!-- Contribution quality breakdown — counts only, no earnings -->
        ${d.contributionRanges.length > 0 ? `
        <tr><td style="padding:0 28px 22px;border-top:1px solid ${C.border};">
          <div style="font-size:13px;font-weight:700;color:${C.ink};margin-top:18px;margin-bottom:2px;">Contribution Quality</div>
          <div style="font-size:11px;color:${C.faint};margin-bottom:10px;">${d.period.monthName} ${d.period.year} · ${d.totals.monthTaskCount} task${d.totals.monthTaskCount !== 1 ? 's' : ''}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};border-radius:8px;overflow:hidden;">
            <tr style="background:${C.head};">
              <td style="padding:8px 14px;font-size:10px;font-weight:600;color:${C.faint};text-transform:uppercase;letter-spacing:0.06em;">Quality Band</td>
              <td style="padding:8px 14px;font-size:10px;font-weight:600;color:${C.faint};text-transform:uppercase;letter-spacing:0.06em;text-align:right;">Count</td>
            </tr>
            ${rangeRows}
          </table>
        </td></tr>` : ''}

        <!-- 6-month earnings trend -->
        <tr><td style="padding:0 28px 24px;border-top:1px solid ${C.border};">
          <div style="font-size:13px;font-weight:700;color:${C.ink};margin-top:18px;margin-bottom:2px;">Earnings Trend</div>
          <div style="font-size:11px;color:${C.faint};margin-bottom:14px;">Last 6 months · total ${inr(d.totals.sixMonthTotal)}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:110px;"><tr style="vertical-align:bottom;">${bars}</tr></table>
          <div style="border-top:1px solid ${C.border};margin-top:0;"></div>
        </td></tr>

        <!-- Milestone -->
        ${(() => {
          const m = getMilestone(d.totals.sixMonthTotal)
          if (!m) return ''
          return `
        <tr><td style="padding:0 28px 22px;">
          <div style="background:linear-gradient(135deg,#f5f3ff,#ede9fe);border:1px solid #ddd6fe;border-radius:10px;padding:14px 18px;">
            <div style="font-size:12px;font-weight:700;color:${C.accent};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">★ Milestone reached</div>
            <div style="font-size:13px;color:${C.body};line-height:1.5;">You've earned over ${inr(m)} in the last 6 months — great work!</div>
          </div>
        </td></tr>`
        })()}

        <!-- Footer -->
        <tr><td style="background:${C.head};border-top:1px solid ${C.border};border-radius:0 0 14px 14px;padding:18px 28px;text-align:center;">
          <div style="font-size:13px;font-weight:600;color:${C.ink};">${d.company.name}</div>
          <div style="font-size:11px;color:${C.faint};margin-top:5px;line-height:1.8;">
            ${d.company.website} &nbsp;·&nbsp; ${d.company.email} &nbsp;·&nbsp; ${d.company.phone}
          </div>
          <div style="font-size:10px;color:${C.faint};margin-top:10px;">For queries, reply to this email.</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`
}

/** Plain-text fallback. */
export function renderPayslipText(d: PayslipData): string {
  const s = d.salary
  const lines = [
    `${d.company.name} — Salary Slip`,
    `${d.period.label}`,
    ``,
    `${d.employee.name} (${d.employee.cqid})${d.employee.designation ? ' · ' + d.employee.designation : ''}`,
    d.payslipNumber ? `Payslip No: ${d.payslipNumber}` : '',
    ``,
    s.baseSalary > 0 ? `Base Salary:     ${inr(s.baseSalary)}` : '',
    `Creative Rewards: ${inr(s.commission)}`,
    s.bonus > 0 ? `Bonus:           ${inr(s.bonus)}` : '',
    s.adjustment ? `${adjustmentLabel(s.adjustmentSources)}: ${s.adjustment < 0 ? '-' : ''}${inr(Math.abs(s.adjustment))}` : '',
    ...(s.ownershipAwards ?? []).map(a => `${ownershipRowLabel(a)}: ${inr(a.earnedInr)}`),
    s.advancesDeducted > 0 ? `Advance Ded:    -${inr(s.advancesDeducted)}` : '',
    s.otherDeductions > 0 ? `Deductions:     -${inr(s.otherDeductions)}` : '',
    `NET ${s.status === 'paid' ? 'PAID' : 'PAYABLE'}: ${inr(s.netSalary)}`,
    ``,
    `Days Active: ${d.attendance.workedDays} / ${d.attendance.daysInMonth}`,
    `Tasks This Month: ${d.totals.monthTaskCount}`,
    ``,
    d.contributionRanges.length > 0
      ? 'Contribution Quality:\n' + d.contributionRanges.map(b => `  ${b.label}: ${b.count} task${b.count !== 1 ? 's' : ''}`).join('\n')
      : '',
    ``,
    `Last 6 months: ${d.sixMonthEarnings.map(m => `${m.shortLabel} ${inr(m.earnings)}`).join('  ·  ')}`,
    ``,
    `${d.company.name} · ${d.company.website} · ${d.company.email} · ${d.company.phone}`,
  ]
  return lines.filter(l => l !== '').join('\n')
}
