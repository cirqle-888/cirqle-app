import type { PayslipData } from './types'

/** Brand palette (hex literals — email clients can't use CSS vars/oklch). */
const C = {
  ink:    '#111827', // primary dark
  navy:   '#0b1120', // deep background
  card:   '#0f172a',
  line:   '#1f2937',
  text:   '#e5e7eb',
  muted:  '#9ca3af',
  faint:  '#6b7280',
  accent: '#7c3aed',
  accent2:'#60a5fa',
  green:  '#34d399',
  amber:  '#fbbf24',
  red:    '#f87171',
}

const BAND_COLOR: Record<string, string> = {
  '100': C.green, '76-99': C.accent2, '51-75': '#a78bfa', '26-50': C.amber, '0-25': C.red,
}

const inr = (n: number) =>
  '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

const SALARY_TYPE_LABEL: Record<string, string> = {
  pure_commission:     'Pure Commission',
  fixed:               'Fixed Salary',
  base_plus_commission:'Base + Commission',
  fixed_plus_bonus:    'Fixed + Bonus',
  hourly:              'Hourly',
}

function row(label: string, value: string, opts: { bold?: boolean; color?: string } = {}) {
  return `
    <tr>
      <td style="padding:7px 0;color:${C.muted};font-size:13px;">${label}</td>
      <td style="padding:7px 0;text-align:right;font-size:13px;font-weight:${opts.bold ? 700 : 500};color:${opts.color || C.text};">${value}</td>
    </tr>`
}

/** Build the full HTML email body for a payslip. Self-contained, inline styles
 *  only (Gmail/Outlook safe), max-width 600, dark Cirqle aesthetic. */
export function renderPayslipHtml(d: PayslipData, note?: string): string {
  const s = d.salary
  const deductions = s.advancesDeducted + s.otherDeductions
  const gross = s.baseSalary + s.commission + s.bonus
  const statusPaid = s.status === 'paid'

  // 6-month bar chart (table-based, email-safe).
  const maxEarn = Math.max(1, ...d.sixMonthEarnings.map(m => m.earnings))
  const bars = d.sixMonthEarnings.map(m => {
    const h = Math.max(4, Math.round((m.earnings / maxEarn) * 90))
    const isCurrent = m.month === d.period.month && m.year === d.period.year
    return `
      <td style="vertical-align:bottom;text-align:center;padding:0 4px;">
        <div style="color:${C.faint};font-size:10px;margin-bottom:4px;">${m.earnings > 0 ? inr(m.earnings) : '—'}</div>
        <div style="height:${h}px;border-radius:5px 5px 0 0;background:${isCurrent ? `linear-gradient(180deg,${C.accent},${C.accent2})` : C.line};"></div>
        <div style="color:${isCurrent ? C.accent2 : C.muted};font-size:11px;margin-top:6px;font-weight:${isCurrent ? 700 : 500};">${m.shortLabel}</div>
      </td>`
  }).join('')

  // Contribution range rows.
  const rangeRows = d.contributionRanges.length === 0
    ? `<tr><td colspan="3" style="padding:12px 0;color:${C.faint};font-size:12px;text-align:center;">No scored contributions this month.</td></tr>`
    : d.contributionRanges.map(b => `
      <tr>
        <td style="padding:8px 0;font-size:12px;">
          <span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${BAND_COLOR[b.band]};margin-right:8px;"></span>
          <span style="color:${C.text};">${b.label}</span>
        </td>
        <td style="padding:8px 0;text-align:center;color:${C.muted};font-size:12px;">${b.count}</td>
        <td style="padding:8px 0;text-align:right;color:${C.text};font-size:12px;font-weight:600;">${inr(b.earnings)}</td>
      </tr>`).join('')

  // Performance colour.
  const perfColor = d.performance.rating >= 90 ? C.green : d.performance.rating >= 70 ? C.accent2 : d.performance.rating >= 50 ? C.amber : C.red

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.navy};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Payslip for ${d.period.label} — net ${inr(s.netSalary)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.navy};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,${C.ink},#1e1b4b);border-radius:16px 16px 0 0;padding:28px 28px 24px;">
          <table role="presentation" width="100%"><tr>
            <td>
              <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px;">cirqle<span style="color:${C.accent2};">.</span></div>
              <div style="font-size:10px;letter-spacing:3px;color:${C.muted};text-transform:uppercase;margin-top:2px;">Design</div>
            </td>
            <td style="text-align:right;">
              <div style="display:inline-block;background:${statusPaid ? 'rgba(52,211,153,0.15)' : 'rgba(251,191,36,0.15)'};color:${statusPaid ? C.green : C.amber};font-size:11px;font-weight:700;padding:5px 12px;border-radius:999px;">${statusPaid ? '● PAID' : '● PENDING'}</div>
            </td>
          </tr></table>
        </td></tr>

        <!-- Title band -->
        <tr><td style="background:${C.card};padding:24px 28px;border-bottom:1px solid ${C.line};">
          <div style="color:${C.muted};font-size:12px;text-transform:uppercase;letter-spacing:1px;">Salary Slip</div>
          <div style="color:#fff;font-size:24px;font-weight:700;margin-top:4px;">${d.period.label}</div>
          <table role="presentation" width="100%" style="margin-top:14px;"><tr>
            <td>
              <div style="color:${C.text};font-size:15px;font-weight:600;">${d.employee.name}</div>
              <div style="color:${C.muted};font-size:12px;margin-top:2px;">${d.employee.cqid}${d.employee.designation ? ' · ' + d.employee.designation : ''}</div>
            </td>
            <td style="text-align:right;">
              ${d.payslipNumber ? `<div style="color:${C.faint};font-size:11px;">Payslip No.</div><div style="color:${C.text};font-size:13px;font-weight:600;">${d.payslipNumber}</div>` : ''}
            </td>
          </tr></table>
        </td></tr>

        ${note ? `<tr><td style="background:${C.card};padding:0 28px 18px;"><div style="background:rgba(124,58,237,0.12);border-left:3px solid ${C.accent};border-radius:8px;padding:12px 14px;color:${C.text};font-size:13px;line-height:1.5;">${note.replace(/\n/g, '<br>')}</div></td></tr>` : ''}

        <!-- Salary breakdown -->
        <tr><td style="background:${C.card};padding:6px 28px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${s.baseSalary > 0 ? row('Base Salary', inr(s.baseSalary)) : ''}
            ${row('Commission Earned', inr(s.commission), { color: C.green })}
            ${s.bonus > 0 ? row('Bonus', inr(s.bonus), { color: C.green }) : ''}
            <tr><td colspan="2" style="border-top:1px solid ${C.line};padding-top:2px;"></td></tr>
            ${row('Gross', inr(gross), { bold: true })}
            ${s.advancesDeducted > 0 ? row('Advance Deducted', '− ' + inr(s.advancesDeducted), { color: C.red }) : ''}
            ${s.otherDeductions > 0 ? row('Other Deductions', '− ' + inr(s.otherDeductions), { color: C.red }) : ''}
          </table>
        </td></tr>

        <!-- Net pay highlight -->
        <tr><td style="background:${C.card};padding:0 28px 24px;">
          <table role="presentation" width="100%" style="background:linear-gradient(135deg,rgba(124,58,237,0.18),rgba(96,165,250,0.12));border:1px solid rgba(124,58,237,0.35);border-radius:12px;"><tr>
            <td style="padding:18px 20px;">
              <div style="color:${C.muted};font-size:12px;text-transform:uppercase;letter-spacing:1px;">Net ${statusPaid ? 'Paid' : 'Payable'}</div>
              <div style="color:${C.muted};font-size:11px;margin-top:3px;">${SALARY_TYPE_LABEL[s.salaryType] || s.salaryType}${deductions > 0 ? ` · after ${inr(deductions)} deductions` : ''}</div>
            </td>
            <td style="padding:18px 20px;text-align:right;">
              <div style="color:#fff;font-size:28px;font-weight:800;">${inr(s.netSalary)}</div>
              ${statusPaid && s.paidDate ? `<div style="color:${C.green};font-size:11px;margin-top:2px;">Paid ${new Date(s.paidDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>` : ''}
            </td>
          </tr></table>
        </td></tr>

        <!-- Performance + attendance -->
        <tr><td style="background:${C.card};padding:0 28px 22px;">
          <table role="presentation" width="100%" cellspacing="0"><tr>
            <td width="48%" style="background:${C.navy};border:1px solid ${C.line};border-radius:12px;padding:16px;">
              <div style="color:${C.muted};font-size:11px;text-transform:uppercase;letter-spacing:1px;">Performance</div>
              <div style="color:${perfColor};font-size:26px;font-weight:800;margin-top:6px;">${d.performance.rating}%</div>
              <div style="color:${C.faint};font-size:11px;margin-top:2px;">Current rating</div>
            </td>
            <td width="4%"></td>
            <td width="48%" style="background:${C.navy};border:1px solid ${C.line};border-radius:12px;padding:16px;">
              <div style="color:${C.muted};font-size:11px;text-transform:uppercase;letter-spacing:1px;">Attendance</div>
              <div style="color:#fff;font-size:26px;font-weight:800;margin-top:6px;">${d.attendance.workedDays}<span style="color:${C.faint};font-size:15px;font-weight:500;"> days active</span></div>
              <div style="color:${C.faint};font-size:11px;margin-top:2px;">${d.totals.monthTaskCount} task${d.totals.monthTaskCount !== 1 ? 's' : ''} contributed in ${d.period.monthName}</div>
            </td>
          </tr></table>
        </td></tr>

        <!-- Contribution range breakdown -->
        <tr><td style="background:${C.card};padding:0 28px 22px;">
          <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:4px;">Contribution Range Breakdown</div>
          <div style="color:${C.faint};font-size:11px;margin-bottom:8px;">${d.period.monthName} ${d.period.year} · ${inr(d.totals.monthEarnings)} earned across ${d.totals.monthTaskCount} task${d.totals.monthTaskCount !== 1 ? 's' : ''}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr style="border-bottom:1px solid ${C.line};">
              <td style="padding:6px 0;color:${C.faint};font-size:10px;text-transform:uppercase;letter-spacing:1px;">Quality Band</td>
              <td style="padding:6px 0;color:${C.faint};font-size:10px;text-align:center;text-transform:uppercase;letter-spacing:1px;">Tasks</td>
              <td style="padding:6px 0;color:${C.faint};font-size:10px;text-align:right;text-transform:uppercase;letter-spacing:1px;">Earnings</td>
            </tr>
            ${rangeRows}
          </table>
        </td></tr>

        <!-- 6-month earnings -->
        <tr><td style="background:${C.card};padding:0 28px 24px;">
          <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px;">Last 6 Months Earnings</div>
          <div style="color:${C.faint};font-size:11px;margin-bottom:14px;">Total ${inr(d.totals.sixMonthTotal)} · contribution earnings</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:130px;"><tr style="vertical-align:bottom;">${bars}</tr></table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${C.ink};border-radius:0 0 16px 16px;padding:22px 28px;text-align:center;">
          <div style="color:${C.text};font-size:13px;font-weight:600;">${d.company.name}</div>
          <div style="color:${C.faint};font-size:11px;margin-top:6px;line-height:1.7;">
            ${d.company.website} &nbsp;·&nbsp; ${d.company.email} &nbsp;·&nbsp; ${d.company.phone}
          </div>
          <div style="color:${C.faint};font-size:10px;margin-top:12px;">This is a system-generated payslip. For queries reply to this email.</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`
}

/** Plain-text fallback for clients that block HTML. */
export function renderPayslipText(d: PayslipData): string {
  const s = d.salary
  const lines = [
    `CIRQLE DESIGN — Salary Slip`,
    `${d.period.label}`,
    ``,
    `${d.employee.name} (${d.employee.cqid})${d.employee.designation ? ' · ' + d.employee.designation : ''}`,
    d.payslipNumber ? `Payslip No: ${d.payslipNumber}` : '',
    ``,
    s.baseSalary > 0 ? `Base Salary:        ${inr(s.baseSalary)}` : '',
    `Commission:         ${inr(s.commission)}`,
    s.bonus > 0 ? `Bonus:              ${inr(s.bonus)}` : '',
    s.advancesDeducted > 0 ? `Advance Deducted:  -${inr(s.advancesDeducted)}` : '',
    s.otherDeductions > 0 ? `Other Deductions:  -${inr(s.otherDeductions)}` : '',
    `NET ${s.status === 'paid' ? 'PAID' : 'PAYABLE'}:        ${inr(s.netSalary)}`,
    ``,
    `Performance rating: ${d.performance.rating}%`,
    `Days active:        ${d.attendance.workedDays} (${d.totals.monthTaskCount} tasks)`,
    ``,
    `Last 6 months: ${d.sixMonthEarnings.map(m => `${m.shortLabel} ${inr(m.earnings)}`).join('  ·  ')}`,
    `6-month total: ${inr(d.totals.sixMonthTotal)}`,
    ``,
    `${d.company.name} · ${d.company.website} · ${d.company.email} · ${d.company.phone}`,
  ]
  return lines.filter(l => l !== '').join('\n')
}
