'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient, safeFetchAll } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  X, ChevronRight, Zap, AlertTriangle, CheckCircle2,
  RefreshCw, SkipForward, Users, Calendar, BarChart2,
  TrendingUp, FileText, ArrowRight, Filter,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Employee {
  id: string
  cqid: string
  name?: string
  base_salary: number
  is_active: boolean
}

interface ExistingPayroll {
  employee_id: string
  month: number
  year: number
}

// One computed entry per employee-month slot
interface SlotEntry {
  employee: Employee
  month: number
  year: number
  monthKey: string    // YYYY-MM
  base_salary: number
  commission: number
  net_salary: number
  skipped: boolean
  skipReason?: string
}

// Per-employee summary
interface EmpSummary {
  employee: Employee
  slots: SlotEntry[]
  totalBase: number
  totalCommission: number
  totalNet: number
  missingMonths: number
  skippedMonths: number
}

// Post-generation result
interface GenResult {
  generated: number
  skipped: number
  failed: number
  totalAmount: number
  employeesAffected: number
  monthsAffected: number
  errors: string[]
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmtMoney(n: number) {
  return '₹' + Math.round(n).toLocaleString('en-IN')
}

function monthLabel(year: number, month: number) {
  return `${MONTHS[month - 1]} ${year}`
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  employees: Employee[]
  existingPayroll: ExistingPayroll[]
  contributionScores: { employee_id: string; earnings_inr?: number; task?: { task_date?: string } | null; calculated_at?: string }[]
  allTasks: { id: string; task_date?: string; status?: string }[]
  onClose: () => void
  onGenerated: (records: any[]) => void
}

// ─── Steps ────────────────────────────────────────────────────────────────────
// step 0 = Configure
// step 1 = Dry Run / Summary
// step 2 = Post-Generation Summary

export default function BulkGenerateModal({
  employees, existingPayroll, contributionScores, allTasks, onClose, onGenerated,
}: Props) {
  const supabase = createClient()
  const { dn } = usePrivacy()
  const now = new Date()

  // ── Smart default start month ─────────────────────────────────────────────

  const smartStartDate = useMemo(() => {
    const dates: string[] = []
    contributionScores.forEach(s => {
      const d = s.task?.task_date || s.calculated_at?.slice(0, 10)
      if (d) dates.push(d)
    })
    allTasks.forEach(t => { if (t.task_date) dates.push(t.task_date) })
    if (!dates.length) return { year: now.getFullYear() - 1, month: 1 }
    dates.sort()
    const earliest = new Date(dates[0])
    return { year: earliest.getFullYear(), month: earliest.getMonth() + 1 }
  }, [contributionScores, allTasks])

  // ── State ─────────────────────────────────────────────────────────────────

  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)

  // Config
  const [fromYear, setFromYear]   = useState(smartStartDate.year)
  const [fromMonth, setFromMonth] = useState(smartStartDate.month)
  const [toYear, setToYear]       = useState(now.getFullYear())
  const [toMonth, setToMonth]     = useState(now.getMonth() + 1)
  const [selectedEmpIds, setSelectedEmpIds] = useState<string[]>([]) // empty = all
  const [skipZero, setSkipZero]       = useState(true)
  const [skipPaid, setSkipPaid]       = useState(true)
  const [onlyWithEarnings, setOnlyWithEarnings] = useState(false)

  // Dry-run results
  const [slots, setSlots] = useState<SlotEntry[]>([])
  const [empSummaries, setEmpSummaries] = useState<EmpSummary[]>([])
  const [matrixView, setMatrixView] = useState(false)

  // Post gen
  const [genResult, setGenResult] = useState<GenResult | null>(null)

  // ── Commission map: empId → monthKey → total ──────────────────────────────

  const commissionMap = useMemo(() => {
    const map: Record<string, Record<string, number>> = {}
    contributionScores.forEach(s => {
      const d = s.task?.task_date || s.calculated_at?.slice(0, 10) || ''
      const mk = d.slice(0, 7)
      if (!mk) return
      if (!map[s.employee_id]) map[s.employee_id] = {}
      map[s.employee_id][mk] = (map[s.employee_id][mk] || 0) + (s.earnings_inr || 0)
    })
    return map
  }, [contributionScores])

  // ── Months to process ─────────────────────────────────────────────────────

  const monthsInRange = useMemo(() => {
    const result: { year: number; month: number; key: string }[] = []
    let y = fromYear, m = fromMonth
    while (y < toYear || (y === toYear && m <= toMonth)) {
      result.push({ year: y, month: m, key: `${y}-${String(m).padStart(2,'0')}` })
      m++; if (m > 12) { m = 1; y++ }
    }
    return result
  }, [fromYear, fromMonth, toYear, toMonth])

  // ── Existing payroll index for fast lookup ────────────────────────────────

  const existingSet = useMemo(() => {
    const s = new Set<string>()
    existingPayroll.forEach(p => s.add(`${p.employee_id}__${p.year}__${p.month}`))
    return s
  }, [existingPayroll])

  // ── Filter employees ──────────────────────────────────────────────────────

  const targetEmps = useMemo(() =>
    employees.filter(e => e.is_active && (selectedEmpIds.length === 0 || selectedEmpIds.includes(e.id))),
  [employees, selectedEmpIds])

  // ── Active employee toggle ────────────────────────────────────────────────

  function toggleEmp(id: string) {
    setSelectedEmpIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  // ── Dry Run ───────────────────────────────────────────────────────────────

  async function runDryRun() {
    setComputing(true)
    const allSlots: SlotEntry[] = []

    for (const emp of targetEmps) {
      for (const { year, month, key } of monthsInRange) {
        const alreadyExists = existingSet.has(`${emp.id}__${year}__${month}`)
        const commission = Math.round(commissionMap[emp.id]?.[key] || 0)
        const net = Math.max(0, (emp.base_salary || 0) + commission)

        let skipped = false
        let skipReason: string | undefined

        if (alreadyExists) {
          skipped = true
          skipReason = 'Already exists'
        } else if (skipZero && net === 0) {
          skipped = true
          skipReason = 'Zero net salary'
        } else if (onlyWithEarnings && commission === 0) {
          skipped = true
          skipReason = 'No earnings (commission = 0)'
        }

        allSlots.push({ employee: emp, month, year, monthKey: key, base_salary: emp.base_salary || 0, commission, net_salary: net, skipped, skipReason })
      }
    }

    setSlots(allSlots)

    // Build per-employee summaries
    const byEmp: Record<string, SlotEntry[]> = {}
    allSlots.forEach(s => {
      if (!byEmp[s.employee.id]) byEmp[s.employee.id] = []
      byEmp[s.employee.id].push(s)
    })
    const summaries: EmpSummary[] = Object.entries(byEmp).map(([_id, empSlots]) => {
      const active = empSlots.filter(s => !s.skipped)
      return {
        employee: empSlots[0].employee,
        slots: empSlots,
        totalBase: active.reduce((s, e) => s + e.base_salary, 0),
        totalCommission: active.reduce((s, e) => s + e.commission, 0),
        totalNet: active.reduce((s, e) => s + e.net_salary, 0),
        missingMonths: active.length,
        skippedMonths: empSlots.filter(s => s.skipped).length,
      }
    }).filter(s => s.missingMonths > 0 || s.skippedMonths > 0)

    setEmpSummaries(summaries)
    setComputing(false)
    setStep(1)
  }

  // ── Summary stats ─────────────────────────────────────────────────────────

  const activeSlots  = useMemo(() => slots.filter(s => !s.skipped), [slots])
  const skippedSlots = useMemo(() => slots.filter(s => s.skipped),  [slots])

  const totalBase       = useMemo(() => activeSlots.reduce((s, e) => s + e.base_salary, 0),  [activeSlots])
  const totalCommission = useMemo(() => activeSlots.reduce((s, e) => s + e.commission, 0),   [activeSlots])
  const totalNet        = useMemo(() => activeSlots.reduce((s, e) => s + e.net_salary, 0),   [activeSlots])
  const uniqueEmps      = useMemo(() => new Set(activeSlots.map(s => s.employee.id)).size,   [activeSlots])
  const uniqueMonths    = useMemo(() => new Set(activeSlots.map(s => s.monthKey)).size,       [activeSlots])

  // Month-wise breakdown
  const monthBreakdown = useMemo(() => {
    const byMonth: Record<string, { label: string; count: number; total: number }> = {}
    activeSlots.forEach(s => {
      if (!byMonth[s.monthKey]) byMonth[s.monthKey] = { label: monthLabel(s.year, s.month), count: 0, total: 0 }
      byMonth[s.monthKey].count++
      byMonth[s.monthKey].total += s.net_salary
    })
    return Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ key, ...v }))
  }, [activeSlots])

  // Matrix: months × employees
  const matrixMonths = useMemo(() => monthBreakdown.map(m => m.key), [monthBreakdown])
  const matrixEmps   = useMemo(() => empSummaries.filter(e => e.missingMonths > 0), [empSummaries])
  const matrixLookup = useMemo(() => {
    const m: Record<string, number> = {}
    activeSlots.forEach(s => { m[`${s.employee.id}__${s.monthKey}`] = s.net_salary })
    return m
  }, [activeSlots])

  // ── Confirm generation ────────────────────────────────────────────────────

  async function confirmGenerate() {
    if (!activeSlots.length) return
    setSaving(true)

    const records = activeSlots.map(s => ({
      employee_id: s.employee.id,
      month: s.month,
      year: s.year,
      base_salary: s.base_salary,
      commission_earned: s.commission,
      advances_deducted: 0,
      other_deductions: 0,
      net_salary: s.net_salary,
      status: 'pending',
    }))

    const BATCH = 50
    let inserted = 0
    let failed = 0
    const errors: string[] = []
    const insertedRecords: any[] = []

    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH)
      const { data, error } = await supabase
        .from('payroll')
        .insert(batch)
        .select('*, employee:employees(id, cqid, name)')
      if (error) {
        errors.push(`Batch ${Math.floor(i/BATCH)+1}: ${error.message}`)
        failed += batch.length
      } else {
        inserted += data?.length || 0
        if (data) insertedRecords.push(...data)
      }
    }

    const result: GenResult = {
      generated: inserted,
      skipped: skippedSlots.length,
      failed,
      totalAmount: activeSlots.reduce((s, e) => s + e.net_salary, 0),
      employeesAffected: new Set(activeSlots.map(s => s.employee.id)).size,
      monthsAffected: new Set(activeSlots.map(s => s.monthKey)).size,
      errors,
    }

    setGenResult(result)
    setSaving(false)
    setStep(2)
    if (insertedRecords.length) onGenerated(insertedRecords)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-5xl shadow-2xl flex flex-col overflow-hidden" style={{ maxHeight: '90vh' }}>

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/30 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="font-semibold">Bulk Generate Historical Payslips</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {step === 0 ? 'Configure date range & filters' : step === 1 ? 'Dry-run preview — review before generating' : 'Generation complete'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-4 h-4" /></button>
        </div>

        {/* ── Stepper ── */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0 bg-secondary/10">
          {['Configure', 'Preview', 'Done'].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold transition-colors ${step === i ? 'gradient-bg text-white' : step > i ? 'bg-green-500 text-white' : 'bg-secondary text-muted-foreground'}`}>
                {step > i ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className={`text-xs font-medium ${step === i ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
              {i < 2 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
            </div>
          ))}
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ═══════════════════════════════════════
              STEP 0: CONFIGURE
          ═══════════════════════════════════════ */}
          {step === 0 && (
            <div className="p-6 space-y-6">

              {/* Date Range */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Calendar className="w-4 h-4 text-primary" />Date Range</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1.5">From Month</label>
                    <div className="flex gap-2">
                      <select value={fromMonth} onChange={e => setFromMonth(parseInt(e.target.value))}
                        className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                        {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
                      </select>
                      <input type="number" value={fromYear} onChange={e => setFromYear(parseInt(e.target.value))}
                        className="w-24 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1.5">To Month</label>
                    <div className="flex gap-2">
                      <select value={toMonth} onChange={e => setToMonth(parseInt(e.target.value))}
                        className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                        {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
                      </select>
                      <input type="number" value={toYear} onChange={e => setToYear(parseInt(e.target.value))}
                        className="w-24 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Smart default: earliest activity detected at <span className="text-foreground font-medium">{monthLabel(smartStartDate.year, smartStartDate.month)}</span>
                </p>
                <p className="text-xs text-primary/80 mt-1">
                  {monthsInRange.length} month{monthsInRange.length !== 1 ? 's' : ''} selected — {targetEmps.length} active employees = up to {monthsInRange.length * targetEmps.length} payslips
                </p>
              </div>

              {/* Filters */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Filter className="w-4 h-4 text-primary" />Filters</h3>
                <div className="space-y-3">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input type="checkbox" checked={skipZero} onChange={e => setSkipZero(e.target.checked)}
                      className="w-4 h-4 rounded accent-primary" />
                    <div>
                      <p className="text-sm font-medium">Skip zero-value payslips</p>
                      <p className="text-xs text-muted-foreground">Don't create payslips where net salary = ₹0</p>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input type="checkbox" checked={onlyWithEarnings} onChange={e => setOnlyWithEarnings(e.target.checked)}
                      className="w-4 h-4 rounded accent-primary" />
                    <div>
                      <p className="text-sm font-medium">Only employees with commission earnings</p>
                      <p className="text-xs text-muted-foreground">Skip months where commission = ₹0 (base salary only employees still included)</p>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group opacity-50 cursor-not-allowed" title="Coming soon">
                    <input type="checkbox" checked={skipPaid} onChange={e => setSkipPaid(e.target.checked)}
                      className="w-4 h-4 rounded accent-primary" disabled />
                    <div>
                      <p className="text-sm font-medium">Skip already paid months</p>
                      <p className="text-xs text-muted-foreground">Duplicate detection always active — existing payslips are always skipped</p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Employee Selection */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Users className="w-4 h-4 text-primary" />Employees</h3>
                <p className="text-xs text-muted-foreground mb-2">Leave all unselected to include all active employees.</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {employees.filter(e => e.is_active).map(emp => (
                    <button key={emp.id}
                      onClick={() => toggleEmp(emp.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors text-left ${selectedEmpIds.includes(emp.id) ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-secondary text-muted-foreground hover:text-foreground'}`}>
                      <div className={`w-2 h-2 rounded-full shrink-0 ${selectedEmpIds.includes(emp.id) ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                      <span className="font-mono font-bold">{emp.cqid}</span>
                      {emp.name && <span className="truncate opacity-70">{dn(emp)}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════
              STEP 1: DRY RUN PREVIEW
          ═══════════════════════════════════════ */}
          {step === 1 && (
            <div className="p-6 space-y-6">

              {/* Grand Summary Cards */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><BarChart2 className="w-4 h-4 text-primary" />Generation Summary</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    { label: 'Employees', value: uniqueEmps, color: 'text-blue-400' },
                    { label: 'Months', value: uniqueMonths, color: 'text-violet-400' },
                    { label: 'Payslips', value: activeSlots.length, color: 'text-foreground' },
                    { label: 'Base Salary', value: fmtMoney(totalBase), color: 'text-muted-foreground' },
                    { label: 'Commission', value: fmtMoney(totalCommission), color: 'text-green-400' },
                    { label: 'Grand Total', value: fmtMoney(totalNet), color: 'text-primary font-bold' },
                  ].map(card => (
                    <div key={card.label} className="bg-secondary/50 border border-border rounded-xl p-3 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{card.label}</p>
                      <p className={`text-base font-semibold ${card.color}`}>{card.value}</p>
                    </div>
                  ))}
                </div>
                {skippedSlots.length > 0 && (
                  <div className="mt-3 flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
                    <SkipForward className="w-4 h-4 shrink-0" />
                    <span><strong>{skippedSlots.length}</strong> slots will be skipped — {skippedSlots.filter(s => s.skipReason === 'Already exists').length} already exist, {skippedSlots.filter(s => s.skipReason !== 'Already exists').length} filtered out.</span>
                  </div>
                )}
              </div>

              {/* View toggle */}
              <div className="flex items-center gap-2">
                <button onClick={() => setMatrixView(false)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${!matrixView ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
                  <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" />Employee View</span>
                </button>
                <button onClick={() => setMatrixView(true)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${matrixView ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
                  <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" />Matrix View</span>
                </button>
              </div>

              {/* EMPLOYEE VIEW */}
              {!matrixView && (
                <div className="space-y-4">
                  {/* Employee Breakdown */}
                  <div>
                    <h3 className="text-sm font-semibold mb-3">Employee Breakdown</h3>
                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full text-xs">
                        <thead className="bg-secondary/50">
                          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            <th className="text-left px-4 py-3">Employee</th>
                            <th className="text-center px-3 py-3">Months</th>
                            <th className="text-right px-3 py-3">Base Total</th>
                            <th className="text-right px-3 py-3 text-green-400">Commission</th>
                            <th className="text-right px-3 py-3 text-primary font-bold">Net Total</th>
                            <th className="text-center px-3 py-3">Avg/Month</th>
                            <th className="text-center px-3 py-3 text-amber-400">Skipped</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {empSummaries.map(s => (
                            <tr key={s.employee.id} className="hover:bg-secondary/20">
                              <td className="px-4 py-3">
                                <span className="font-mono font-bold text-foreground">{s.employee.cqid}</span>
                                {s.employee.name && <span className="text-muted-foreground ml-2">{dn(s.employee)}</span>}
                              </td>
                              <td className="px-3 py-3 text-center font-semibold">{s.missingMonths}</td>
                              <td className="px-3 py-3 text-right text-muted-foreground">{fmtMoney(s.totalBase)}</td>
                              <td className="px-3 py-3 text-right text-green-400">{s.totalCommission > 0 ? `+${fmtMoney(s.totalCommission)}` : '—'}</td>
                              <td className="px-3 py-3 text-right font-bold text-foreground">{fmtMoney(s.totalNet)}</td>
                              <td className="px-3 py-3 text-center text-muted-foreground">{s.missingMonths > 0 ? fmtMoney(Math.round(s.totalNet / s.missingMonths)) : '—'}</td>
                              <td className="px-3 py-3 text-center text-amber-400">{s.skippedMonths > 0 ? s.skippedMonths : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-secondary/50 border-t-2 border-border font-semibold text-xs">
                            <td className="px-4 py-3">Total</td>
                            <td className="px-3 py-3 text-center">{activeSlots.length}</td>
                            <td className="px-3 py-3 text-right text-muted-foreground">{fmtMoney(totalBase)}</td>
                            <td className="px-3 py-3 text-right text-green-400">+{fmtMoney(totalCommission)}</td>
                            <td className="px-3 py-3 text-right text-primary">{fmtMoney(totalNet)}</td>
                            <td className="px-3 py-3" />
                            <td className="px-3 py-3 text-center text-amber-400">{skippedSlots.length}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>

                  {/* Month Breakdown */}
                  <div>
                    <h3 className="text-sm font-semibold mb-3">Month-wise Breakdown</h3>
                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full text-xs">
                        <thead className="bg-secondary/50">
                          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            <th className="text-left px-4 py-3">Month</th>
                            <th className="text-center px-3 py-3">Employees</th>
                            <th className="text-right px-3 py-3">Total Payroll</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {monthBreakdown.map(mb => (
                            <tr key={mb.key} className="hover:bg-secondary/20">
                              <td className="px-4 py-3 font-medium">{mb.label}</td>
                              <td className="px-3 py-3 text-center text-muted-foreground">{mb.count}</td>
                              <td className="px-3 py-3 text-right font-semibold">{fmtMoney(mb.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* MATRIX VIEW */}
              {matrixView && (
                <div>
                  <h3 className="text-sm font-semibold mb-3">Employee × Month Matrix</h3>
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="text-xs whitespace-nowrap">
                      <thead className="bg-secondary/50">
                        <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          <th className="text-left px-4 py-3 sticky left-0 bg-secondary/80 z-10">Employee</th>
                          {matrixMonths.map(mk => (
                            <th key={mk} className="text-right px-3 py-3 min-w-[80px]">
                              {MONTHS[parseInt(mk.slice(5,7))-1]}&nbsp;{mk.slice(0,4)}
                            </th>
                          ))}
                          <th className="text-right px-4 py-3 font-bold text-foreground bg-secondary/80 sticky right-0">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {matrixEmps.map(es => (
                          <tr key={es.employee.id} className="hover:bg-secondary/20">
                            <td className="px-4 py-3 sticky left-0 bg-card z-10">
                              <span className="font-mono font-bold">{es.employee.cqid}</span>
                              {es.employee.name && <span className="text-muted-foreground ml-1.5">{dn(es.employee)}</span>}
                            </td>
                            {matrixMonths.map(mk => {
                              const val = matrixLookup[`${es.employee.id}__${mk}`]
                              const skippedSlot = slots.find(s => s.employee.id === es.employee.id && s.monthKey === mk && s.skipped)
                              return (
                                <td key={mk} className="px-3 py-3 text-right">
                                  {skippedSlot ? (
                                    <span className="text-amber-500/60 text-[10px]" title={skippedSlot.skipReason}>skip</span>
                                  ) : val != null ? (
                                    <span className={val === 0 ? 'text-muted-foreground' : 'font-medium'}>{fmtMoney(val)}</span>
                                  ) : (
                                    <span className="text-muted-foreground/40">—</span>
                                  )}
                                </td>
                              )
                            })}
                            <td className="px-4 py-3 text-right font-bold sticky right-0 bg-card">{fmtMoney(es.totalNet)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-secondary/50 font-semibold border-t-2 border-border">
                          <td className="px-4 py-3 sticky left-0 bg-secondary/80 z-10">Total</td>
                          {matrixMonths.map(mk => {
                            const total = monthBreakdown.find(m => m.key === mk)?.total || 0
                            return <td key={mk} className="px-3 py-3 text-right text-primary">{fmtMoney(total)}</td>
                          })}
                          <td className="px-4 py-3 text-right text-primary sticky right-0 bg-secondary/80">{fmtMoney(totalNet)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Skipped Details */}
              {skippedSlots.length > 0 && (
                <details className="rounded-xl border border-amber-500/20 overflow-hidden">
                  <summary className="px-4 py-3 bg-amber-500/10 text-xs text-amber-400 cursor-pointer hover:bg-amber-500/20 transition-colors flex items-center gap-2">
                    <SkipForward className="w-3.5 h-3.5" />
                    {skippedSlots.length} skipped slots — click to expand
                  </summary>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-secondary/30">
                        <tr className="text-[10px] text-muted-foreground">
                          <th className="text-left px-4 py-2">Employee</th>
                          <th className="text-left px-3 py-2">Month</th>
                          <th className="text-left px-3 py-2">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {skippedSlots.map((s, i) => (
                          <tr key={i}>
                            <td className="px-4 py-2 font-mono">{s.employee.cqid}</td>
                            <td className="px-3 py-2 text-muted-foreground">{monthLabel(s.year, s.month)}</td>
                            <td className="px-3 py-2 text-amber-500/80">{s.skipReason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}

          {/* ═══════════════════════════════════════
              STEP 2: POST-GENERATION SUMMARY
          ═══════════════════════════════════════ */}
          {step === 2 && genResult && (
            <div className="p-6 space-y-6">
              <div className="text-center py-4">
                <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-8 h-8 text-green-400" />
                </div>
                <h3 className="font-semibold text-lg">Generation Complete</h3>
                <p className="text-sm text-muted-foreground mt-1">Historical payslips have been created successfully.</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: 'Payslips Created', value: genResult.generated, color: 'text-green-400' },
                  { label: 'Employees Affected', value: genResult.employeesAffected, color: 'text-blue-400' },
                  { label: 'Months Affected', value: genResult.monthsAffected, color: 'text-violet-400' },
                  { label: 'Total Payroll', value: fmtMoney(genResult.totalAmount), color: 'text-primary font-bold' },
                  { label: 'Slots Skipped', value: genResult.skipped, color: 'text-amber-400' },
                  { label: 'Failed', value: genResult.failed, color: genResult.failed > 0 ? 'text-red-400' : 'text-muted-foreground' },
                ].map(card => (
                  <div key={card.label} className="bg-secondary/50 border border-border rounded-xl p-4 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{card.label}</p>
                    <p className={`text-base font-semibold ${card.color}`}>{card.value}</p>
                  </div>
                ))}
              </div>

              {genResult.errors.length > 0 && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                  <p className="text-sm font-semibold text-red-400 mb-2 flex items-center gap-2"><AlertTriangle className="w-4 h-4" />Errors</p>
                  {genResult.errors.map((e, i) => <p key={i} className="text-xs text-red-400/80">{e}</p>)}
                </div>
              )}

              <div className="p-4 bg-secondary/50 border border-border rounded-xl">
                <p className="text-sm font-semibold mb-2">Next Steps</p>
                <div className="space-y-2 text-xs text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <ArrowRight className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                    Go to the <strong className="text-foreground">Cashbook</strong> and click the link icon on any "Salary" payment to allocate it to these newly created payslips.
                  </div>
                  <div className="flex items-start gap-2">
                    <ArrowRight className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                    View all generated records in the <strong className="text-foreground">Records</strong> tab of this payroll page.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="border-t border-border px-6 py-4 shrink-0 flex items-center justify-between gap-4 bg-secondary/10">
          {step === 0 && (
            <>
              <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">
                Cancel
              </button>
              <button
                onClick={runDryRun}
                disabled={computing || monthsInRange.length === 0}
                className="flex items-center gap-2 px-6 py-2 rounded-lg gradient-bg text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {computing ? <><RefreshCw className="w-4 h-4 animate-spin" />Computing…</> : <><FileText className="w-4 h-4" />Preview Dry Run</>}
              </button>
            </>
          )}

          {step === 1 && (
            <>
              <button onClick={() => setStep(0)} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">
                ← Back to Configure
              </button>
              <div className="flex items-center gap-3">
                {activeSlots.length === 0 ? (
                  <p className="text-sm text-amber-400 flex items-center gap-2"><AlertTriangle className="w-4 h-4" />No payslips to generate — adjust filters or date range.</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Ready to generate <span className="text-foreground font-semibold">{activeSlots.length} payslips</span> totalling <span className="text-primary font-semibold">{fmtMoney(totalNet)}</span>
                  </p>
                )}
                <button
                  onClick={confirmGenerate}
                  disabled={saving || activeSlots.length === 0}
                  className="flex items-center gap-2 px-6 py-2 rounded-lg gradient-bg text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {saving ? <><RefreshCw className="w-4 h-4 animate-spin" />Generating…</> : <><Zap className="w-4 h-4" />Confirm &amp; Generate</>}
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <div className="w-full flex justify-end">
              <button onClick={onClose} className="px-6 py-2 rounded-lg gradient-bg text-white text-sm font-semibold hover:opacity-90">
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
