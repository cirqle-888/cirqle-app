import { createAdminClient } from '@/lib/supabase/admin'
import { getQualityBand } from '@/lib/calculations/commission'
import type { PayslipData, PayslipBand, PayslipTask, PayslipMonthEarning } from './types'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const BAND_LABELS: Record<string, string> = {
  '100':   'Perfect (100%)',
  '76-99': 'Excellent (76–99%)',
  '51-75': 'Good (51–75%)',
  '26-50': 'Fair (26–50%)',
  '0-25':  'Low (0–25%)',
}
const BAND_ORDER: PayslipBand['band'][] = ['100', '76-99', '51-75', '26-50', '0-25']

const COMPANY_DEFAULTS = {
  name:    'Cirqle Works',
  email:   'team@cirqle.work',
  website: 'www.cirqle.work',
  phone:   '+91 81295 34377',
}

function monthKey(y: number, m: number) { return `${y}-${String(m).padStart(2, '0')}` }

/**
 * Build a complete payslip dataset for one employee + month.
 *
 * Earnings are read from the SAME stored `contribution_scores.earnings_inr`
 * that payroll sums, and task-linked scores are bucketed by their task's month
 * (deleted tasks excluded) — exactly mirroring recalculatePayrollForMonth — so
 * the payslip's figures always agree with the Payroll page.
 */
export async function buildPayslipData(
  employeeId: string,
  month: number,
  year: number,
): Promise<{ ok: true; data: PayslipData } | { ok: false; error: string }> {
  const admin = createAdminClient()

  // ── Employee (+ designation name) ──────────────────────────────────────────
  const { data: emp, error: empErr } = await admin
    .from('employees')
    .select('id, cqid, name, email, role, performance_rating, salary_type, designation:designations(name)')
    .eq('id', employeeId)
    .single()
  if (empErr || !emp) return { ok: false, error: empErr?.message || 'Employee not found' }

  // ── Payroll record for the period ──────────────────────────────────────────
  const { data: pay } = await admin
    .from('payroll')
    .select('base_salary, commission_earned, bonus, advances_deducted, other_deductions, net_salary, status, paid_date, payslip_number')
    .eq('employee_id', employeeId)
    .eq('month', month)
    .eq('year', year)
    .maybeSingle()

  // ── 6-month window [start, end) ────────────────────────────────────────────
  // Months: (m-5) … m. Build the list first so empty months still show.
  const sixMonths: { month: number; year: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(year, month - 1 - i, 1)
    sixMonths.push({ month: d.getMonth() + 1, year: d.getFullYear() })
  }
  const windowStartDate = new Date(year, month - 6, 1)
  const windowStart = `${windowStartDate.getFullYear()}-${String(windowStartDate.getMonth() + 1).padStart(2, '0')}-01`
  const windowEndDate = new Date(year, month, 1) // first day AFTER the target month
  const windowEnd = `${windowEndDate.getFullYear()}-${String(windowEndDate.getMonth() + 1).padStart(2, '0')}-01`

  // ── Non-deleted tasks in the window → id → {date,title,client,monthKey} ─────
  const { data: winTasks } = await admin
    .from('tasks')
    .select('id, task_date, title, client:clients(name)')
    .gte('task_date', windowStart)
    .lt('task_date', windowEnd)
    .is('deleted_at', null)

  const taskInfo = new Map<string, { date: string; title: string; client: string; key: string }>()
  for (const t of (winTasks ?? []) as any[]) {
    const date = (t.task_date || '').slice(0, 10)
    taskInfo.set(t.id, {
      date,
      title: t.title || 'Untitled task',
      client: t.client?.name || '—',
      key: date.slice(0, 7), // YYYY-MM
    })
  }

  // ── Employee scores on those tasks (chunked) ───────────────────────────────
  type ScoreRow = { task_id: string | null; score_percentage: number; earnings_inr: number; calculated_at: string }
  const taskScores: ScoreRow[] = []
  const taskIds = Array.from(taskInfo.keys())
  const CHUNK = 200
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const chunk = taskIds.slice(i, i + CHUNK)
    const { data } = await admin
      .from('contribution_scores')
      .select('task_id, score_percentage, earnings_inr, calculated_at')
      .eq('employee_id', employeeId)
      .in('task_id', chunk)
    if (data) taskScores.push(...(data as ScoreRow[]))
  }

  // ── Orphan scores (no task_id, earnings-only imports) by calculated_at ──────
  const { data: orphanData } = await admin
    .from('contribution_scores')
    .select('task_id, score_percentage, earnings_inr, calculated_at')
    .eq('employee_id', employeeId)
    .is('task_id', null)
    .gte('calculated_at', windowStart)
    .lt('calculated_at', windowEnd)
  const orphanScores = (orphanData ?? []) as ScoreRow[]

  // ── Bucket earnings per month ──────────────────────────────────────────────
  const earnByMonth: Record<string, number> = {}
  const addEarn = (key: string, amt: number) => { earnByMonth[key] = (earnByMonth[key] || 0) + (amt || 0) }

  for (const s of taskScores) {
    const info = s.task_id ? taskInfo.get(s.task_id) : undefined
    if (!info) continue // task deleted or outside window
    addEarn(info.key, s.earnings_inr)
  }
  for (const s of orphanScores) {
    addEarn((s.calculated_at || '').slice(0, 7), s.earnings_inr)
  }

  const sixMonthEarnings: PayslipMonthEarning[] = sixMonths.map(({ month: m, year: y }) => ({
    month: m,
    year: y,
    label: `${MONTHS_SHORT[m - 1]} ${y}`,
    shortLabel: MONTHS_SHORT[m - 1],
    earnings: Math.round((earnByMonth[monthKey(y, m)] || 0) * 100) / 100,
  }))
  const sixMonthTotal = sixMonthEarnings.reduce((s, x) => s + x.earnings, 0)

  // ── This-month detail: tasks, ranges, attendance ───────────────────────────
  const thisKey = monthKey(year, month)
  const monthTasks: PayslipTask[] = []
  const workedDates = new Set<string>()
  const bandAgg: Record<string, { count: number; earnings: number }> = {}
  for (const b of BAND_ORDER) bandAgg[b] = { count: 0, earnings: 0 }

  for (const s of taskScores) {
    const info = s.task_id ? taskInfo.get(s.task_id) : undefined
    if (!info || info.key !== thisKey) continue
    monthTasks.push({
      date: info.date,
      title: info.title,
      client: info.client,
      scorePct: s.score_percentage || 0,
      earnings: Math.round((s.earnings_inr || 0) * 100) / 100,
    })
    workedDates.add(info.date)
    const band = getQualityBand(s.score_percentage || 0)
    bandAgg[band].count++
    bandAgg[band].earnings += s.earnings_inr || 0
  }
  // Orphan (no task) earnings still count toward this month's totals/ranges.
  for (const s of orphanScores) {
    if ((s.calculated_at || '').slice(0, 7) !== thisKey) continue
    const band = getQualityBand(s.score_percentage || 0)
    bandAgg[band].count++
    bandAgg[band].earnings += s.earnings_inr || 0
  }

  monthTasks.sort((a, b) => a.date.localeCompare(b.date))

  const contributionRanges: PayslipBand[] = BAND_ORDER
    .map(band => ({
      band,
      label: BAND_LABELS[band],
      count: bandAgg[band].count,
      earnings: Math.round(bandAgg[band].earnings * 100) / 100,
    }))
    .filter(b => b.count > 0)

  const monthEarnings = Math.round(
    Object.values(bandAgg).reduce((s, b) => s + b.earnings, 0) * 100,
  ) / 100

  const data: PayslipData = {
    employee: {
      id: emp.id,
      cqid: emp.cqid,
      name: emp.name || emp.cqid,
      email: emp.email || '',
      designation: (emp as any).designation?.name || null,
      role: emp.role,
    },
    period: { month, year, monthName: MONTHS[month - 1], label: `${MONTHS[month - 1]} ${year}` },
    payslipNumber: pay?.payslip_number || null,
    generatedAt: new Date().toISOString(),
    salary: {
      salaryType:       emp.salary_type || 'pure_commission',
      baseSalary:       pay?.base_salary || 0,
      commission:       pay?.commission_earned || 0,
      bonus:            pay?.bonus || 0,
      advancesDeducted: pay?.advances_deducted || 0,
      otherDeductions:  pay?.other_deductions || 0,
      netSalary:        pay?.net_salary || 0,
      status:           pay?.status || 'pending',
      paidDate:         pay?.paid_date || null,
    },
    performance: { rating: emp.performance_rating ?? 100 },
    attendance: {
      workedDays: workedDates.size,
      daysInMonth: new Date(year, month, 0).getDate(),
    },
    contributionRanges,
    monthTasks,
    sixMonthEarnings,
    totals: {
      monthEarnings,
      monthTaskCount: monthTasks.length,
      sixMonthTotal: Math.round(sixMonthTotal * 100) / 100,
    },
    company: {
      ...COMPANY_DEFAULTS,
      logoUrl: await (async () => {
        const { data } = await admin.from('company_settings').select('value').eq('key', 'logo_url').maybeSingle()
        return (data?.value as string | null) || null
      })(),
    },
  }

  return { ok: true, data }
}
