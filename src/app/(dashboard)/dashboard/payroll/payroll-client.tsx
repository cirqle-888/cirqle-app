'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { formatCompact } from '@/lib/calculations/currency'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  Plus, X, Eye, EyeOff, Zap, CheckCircle, Printer, Download,
  ChevronLeft, ChevronRight, AlertTriangle, Calendar, BarChart2,
  FileText, ArrowRight, TrendingUp, TrendingDown, RefreshCw,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { ModalOverlay } from '@/components/ui/modal-overlay'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Employee {
  id: string
  cqid: string
  name?: string
  email?: string
  role: string
  salary_type: string
  base_salary: number
  performance_rating: number
  is_active: boolean
  reveal_salary: boolean
  salary_day?: number
  bank_details?: any
}

interface PayrollRecord {
  id: string
  employee_id: string
  month: number
  year: number
  base_salary: number
  commission_earned: number
  advances_deducted: number
  other_deductions: number
  net_salary: number
  status: string
  paid_date?: string
  employee?: { id: string; cqid: string; name?: string }
}

interface Props {
  employees: Employee[]
  payrollRecords: PayrollRecord[]
  advances: any[]
  credits: any[]
  deductions: any[]
  contributionScores: {
    task_id: string | null
    employee_id: string
    earnings_inr: number
    calculated_at: string
    task?: { id?: string; task_date: string; title?: string; status?: string } | null
  }[]
  allTasks: {
    id: string
    title: string
    task_date: string
    status: string
    client?: { name: string } | null
    service?: { name: string } | null
  }[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TABS = ['Overview', 'Records', 'Employees', 'Advances', 'Credits']

// ─── Main Component ───────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Next salary date for an employee given their salary_day (1-31, default 1) */
function getNextSalaryDate(salaryDay = 1): Date {
  const today = new Date()
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), salaryDay)
  return today <= thisMonth
    ? thisMonth
    : new Date(today.getFullYear(), today.getMonth() + 1, salaryDay)
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - new Date().setHours(0,0,0,0)) / 86400000)
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PayrollClient({
  employees, payrollRecords, advances, credits, deductions, contributionScores, allTasks,
}: Props) {
  const now    = new Date()
  const router = useRouter()
  const { dn, isUnlocked } = usePrivacy()

  // ── UI state ──────────────────────────────────────────────────────────────
  const [tab, setTab] = useState('Overview')
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1)
  const [viewYear, setViewYear]   = useState(now.getFullYear())
  const [selectedEmp, setSelectedEmp]         = useState<Employee | null>(null)
  const [generatePreview, setGeneratePreview] = useState<any[] | null>(null)
  const [confirmModal, setConfirmModal]       = useState<{
    title: string; body: string; confirmLabel: string; onConfirm: () => void
  } | null>(null)
  const [saving, setSaving] = useState(false)

  // ── Live scores state (starts from server data, updated by realtime + refresh) ──
  const [liveScores, setLiveScores]   = useState(contributionScores)
  const [refreshing, setRefreshing]   = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date>(now)

  // ── Data state ────────────────────────────────────────────────────────────
  const [payroll,    setPayroll]    = useState(payrollRecords)
  const [advList,    setAdvList]    = useState(advances)
  const [creditList, setCreditList] = useState(credits)
  const [empList,    setEmpList]    = useState(employees)

  // ── Form state ────────────────────────────────────────────────────────────
  const [showPayrollForm, setShowPayrollForm] = useState(false)
  const [showAdvanceForm, setShowAdvanceForm] = useState(false)
  const [showCreditForm,  setShowCreditForm]  = useState(false)

  const [payForm, setPayForm] = useState({
    employee_id: '', month: now.getMonth() + 1, year: now.getFullYear(),
    base_salary: '', commission_earned: '', advances_deducted: '0', other_deductions: '0', notes: '',
  })
  const [advForm, setAdvForm] = useState({
    employee_id: '', amount: '', advance_date: now.toISOString().split('T')[0],
    reason: '', repayment_type: 'deduct_from_salary',
  })
  const [creditForm, setCreditForm] = useState({
    entity_type: 'employee', entity_id: '', credit_type: 'given',
    amount: '', credit_date: now.toISOString().split('T')[0], notes: '',
  })

  const supabase = createClient()

  // ── Refresh commission scores from DB (client-side fetch) ─────────────────
  const refreshScores = useCallback(async () => {
    setRefreshing(true)
    const { data } = await supabase
      .from('contribution_scores')
      .select('task_id, employee_id, earnings, calculated_at, task:tasks(id, task_date, title, status)')
      .order('calculated_at', { ascending: false })
    if (data) {
      setLiveScores(data as any)
      setLastRefresh(new Date())
    }
    setRefreshing(false)
  }, [supabase])

  // ── Supabase Realtime: auto-update when any score changes ─────────────────
  useEffect(() => {
    const channel = supabase
      .channel('payroll-scores-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contribution_scores' }, () => {
        refreshScores()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [refreshScores, supabase])

  // ── Computed ──────────────────────────────────────────────────────────────

  const monthKey = `${viewYear}-${String(viewMonth).padStart(2, '0')}`

  /** empId → monthKey → total commission (uses live scores) */
  const commissionByEmpMonth = useMemo(() => {
    const map: Record<string, Record<string, number>> = {}
    liveScores.forEach(s => {
      const dateStr = s.task?.task_date || s.calculated_at?.slice(0, 10) || ''
      const mk = dateStr.slice(0, 7)
      if (!mk) return
      if (!map[s.employee_id]) map[s.employee_id] = {}
      map[s.employee_id][mk] = (map[s.employee_id][mk] || 0) + (s.earnings_inr || 0)
    })
    return map
  }, [liveScores])

  /** empId → commission for selected month */
  const monthCommissions = useMemo(() => {
    const out: Record<string, number> = {}
    empList.forEach(e => { out[e.id] = Math.round(commissionByEmpMonth[e.id]?.[monthKey] || 0) })
    return out
  }, [empList, commissionByEmpMonth, monthKey])

  const monthPayroll    = useMemo(() => payroll.filter(r => r.month === viewMonth && r.year === viewYear), [payroll, viewMonth, viewYear])
  const processedEmpIds = useMemo(() => new Set(monthPayroll.map(r => r.employee_id)), [monthPayroll])

  /** empId → Set of worked dates (YYYY-MM-DD) in selected month (uses live scores) */
  const attendanceByEmp = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    liveScores.forEach(s => {
      const dateStr = (s.task?.task_date || s.calculated_at?.slice(0, 10) || '').slice(0, 10)
      if (dateStr.startsWith(monthKey)) {
        if (!map[s.employee_id]) map[s.employee_id] = new Set()
        map[s.employee_id].add(dateStr)
      }
    })
    return map
  }, [liveScores, monthKey])

  const scoredTaskIds = useMemo(() => {
    const ids = new Set<string>()
    liveScores.forEach(s => {
      // Use task_id if set, otherwise fall back to the joined task's id
      const tid = s.task_id || (s.task as any)?.id
      if (tid) ids.add(tid)
    })
    return ids
  }, [liveScores])

  /** Completed tasks in selected month that have no contribution scores */
  const missingContribTasks = useMemo(() =>
    allTasks.filter(t => t.task_date?.startsWith(monthKey) && !scoredTaskIds.has(t.id)),
  [allTasks, scoredTaskIds, monthKey])

  const monthStats = useMemo(() => {
    const total   = monthPayroll.reduce((s, r) => s + (r.net_salary || 0), 0)
    const paid    = monthPayroll.filter(r => r.status === 'paid').reduce((s, r) => s + (r.net_salary || 0), 0)
    return { total, paid, pending: total - paid, count: monthPayroll.length, paidCount: monthPayroll.filter(r => r.status === 'paid').length }
  }, [monthPayroll])

  const unprocessedEmps = useMemo(() => empList.filter(e => e.is_active && !processedEmpIds.has(e.id)), [empList, processedEmpIds])

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** 6 months of bar-chart data for an employee (ending at viewMonth) */
  function getEmpHistory(empId: string) {
    return Array.from({ length: 6 }, (_, i) => {
      const d  = new Date(viewYear, viewMonth - 1 - (5 - i), 1)
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const record     = payroll.find(r => r.employee_id === empId && r.month === d.getMonth() + 1 && r.year === d.getFullYear())
      const commission = Math.round(commissionByEmpMonth[empId]?.[mk] || 0)
      return {
        month:      MONTHS[d.getMonth()],
        base:       record?.base_salary      || 0,
        commission: record?.commission_earned ?? commission,
      }
    })
  }

  /** Tasks with contribution scores for this employee in selected month */
  function getEmpMonthTasks(empId: string) {
    const taskIds = new Set(
      liveScores
        .filter(s => s.employee_id === empId && (s.task?.task_date || s.calculated_at || '').startsWith(monthKey))
        .map(s => s.task_id)
    )
    return allTasks.filter(t => taskIds.has(t.id))
  }

  // ── Month navigation ──────────────────────────────────────────────────────

  function navigateMonth(dir: -1 | 1) {
    const d = new Date(viewYear, viewMonth - 1 + dir, 1)
    setViewMonth(d.getMonth() + 1)
    setViewYear(d.getFullYear())
  }

  // ── Auto-generate ─────────────────────────────────────────────────────────

  function openGeneratePreview() {
    const preview = unprocessedEmps.map(emp => {
      const commission      = monthCommissions[emp.id] || 0
      const pendingAdvances = advList
        .filter((a: any) => a.employee_id === emp.id && a.status === 'pending')
        .reduce((sum: number, a: any) => sum + (a.amount || 0), 0)
      const net = Math.max(0, (emp.base_salary || 0) + commission - pendingAdvances)
      return { employee: emp, base_salary: emp.base_salary || 0, commission_earned: commission, advances_deducted: pendingAdvances, other_deductions: 0, net_salary: net }
    })
    setGeneratePreview(preview)
  }

  async function confirmGenerate() {
    if (!generatePreview) return
    setSaving(true)
    const records = generatePreview.map(p => ({
      employee_id: p.employee.id, month: viewMonth, year: viewYear,
      base_salary: p.base_salary, commission_earned: p.commission_earned,
      advances_deducted: p.advances_deducted, other_deductions: p.other_deductions,
      net_salary: p.net_salary, status: 'pending',
    }))
    const { data, error } = await supabase.from('payroll').insert(records).select('*, employee:employees(id, cqid, name)')
    if (!error && data) { setPayroll(p => [...data, ...p]); setGeneratePreview(null) }
    setSaving(false)
  }

  // ── Mark paid ─────────────────────────────────────────────────────────────

  function confirmMarkPaid(id: string) {
    const record    = payroll.find(r => r.id === id)
    const emp       = empList.find(e => e.id === record?.employee_id)
    const monthName = record ? MONTHS[record.month - 1] : ''
    // Show the live (up-to-date) net amount in the confirmation
    const liveCommission = record ? (monthCommissions[record.employee_id] || 0) : 0
    const liveNet = record ? Math.max(0, (record.base_salary || 0) + liveCommission - (record.advances_deducted || 0) - (record.other_deductions || 0)) : 0
    const displayNet = liveNet || record?.net_salary || 0
    setConfirmModal({
      title:        'Mark Salary as Paid',
      body:         `Mark ${dn(emp) || 'this employee'}'s salary for ${monthName} ${record?.year ?? ''} as paid?\nNet: ₹${displayNet.toLocaleString('en-IN')}. This records today as the payment date.`,
      confirmLabel: 'Mark Paid',
      onConfirm:    () => markPaid(id),
    })
  }

  async function markPaid(id: string) {
    setConfirmModal(null)
    const today  = new Date().toISOString().split('T')[0]
    const record = payroll.find(r => r.id === id)
    if (!record) return
    // Always sync the latest commission from contribution_scores before marking paid
    const liveCommission = monthCommissions[record.employee_id] || 0
    const liveNet = Math.max(0, (record.base_salary || 0) + liveCommission - (record.advances_deducted || 0) - (record.other_deductions || 0))
    const finalNet = liveNet || record.net_salary || 0
    const updates: any = { status: 'paid', paid_date: today }
    if (liveCommission > 0) {
      updates.commission_earned = liveCommission
      updates.net_salary = finalNet
    }
    await supabase.from('payroll').update(updates).eq('id', id)
    setPayroll(p => p.map(r => r.id === id ? { ...r, ...updates } : r))

    // Auto-create a Cash Book outflow entry under "Salary" category
    if (finalNet > 0) {
      const emp       = empList.find(e => e.id === record.employee_id)
      const monthName = MONTHS[record.month - 1]
      await supabase.from('cashbook_entries').insert({
        entry_date:   today,
        type:         'outflow',
        category_id:  '001480fa-6ea1-47e5-9461-aef7a914fac5', // Salary category
        employee_id:  record.employee_id,
        description:  `Salary — ${emp?.cqid || 'Employee'} — ${monthName} ${record.year}`,
        amount:       finalNet,
        amount_inr:   finalNet,
        currency:     'INR',
        reference:    `payroll:${id}`,
      })
    }
  }

  function confirmMarkUnpaid(id: string) {
    const record    = payroll.find(r => r.id === id)
    const emp       = empList.find(e => e.id === record?.employee_id)
    const monthName = record ? MONTHS[record.month - 1] : ''
    setConfirmModal({
      title:        'Undo Payment',
      body:         `Mark ${dn(emp) || 'this employee'}'s salary for ${monthName} ${record?.year ?? ''} back to Pending?\nThis will also remove the Cash Book expense entry.`,
      confirmLabel: 'Mark as Pending',
      onConfirm:    () => markUnpaid(id),
    })
  }

  async function markUnpaid(id: string) {
    setConfirmModal(null)
    await supabase.from('payroll').update({ status: 'pending', paid_date: null }).eq('id', id)
    setPayroll(p => p.map(r => r.id === id ? { ...r, status: 'pending', paid_date: undefined } : r))
    // Remove the matching cashbook entry (matched by reference)
    await supabase.from('cashbook_entries').delete().eq('reference', `payroll:${id}`)
  }

  async function toggleReveal(empId: string, current: boolean) {
    await supabase.from('employees').update({ reveal_salary: !current }).eq('id', empId)
    setEmpList(e => e.map(emp => emp.id === empId ? { ...emp, reveal_salary: !current } : emp))
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  function dl(csv: string, name: string) {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    Object.assign(document.createElement('a'), { href: url, download: name }).click()
    URL.revokeObjectURL(url)
  }

  function exportPayrollCSV() {
    const header = ['Employee', 'CQID', 'Month', 'Year', 'Base Salary', 'Commission', 'Deductions', 'Net Salary', 'Status', 'Paid Date']
    const rows = payroll.map(r => {
      const emp = empList.find(e => e.id === r.employee_id)
      return [emp?.name || '', emp?.cqid || r.employee?.cqid || '', MONTHS[r.month - 1], r.year,
        r.base_salary, r.commission_earned, (r.advances_deducted || 0) + (r.other_deductions || 0),
        r.net_salary, r.status, r.paid_date || '']
    })
    dl([header, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n'), `payroll-${monthKey}.csv`)
  }

  function exportAdvancesCSV() {
    const header = ['Employee', 'Amount', 'Date', 'Reason', 'Type', 'Status']
    const rows = advList.map((a: any) => {
      const emp = empList.find(e => e.id === a.employee_id)
      return [emp?.name || emp?.cqid || '', a.amount, a.advance_date, a.reason || '', a.repayment_type || '', a.status || '']
    })
    dl([header, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n'), `advances-${now.toISOString().split('T')[0]}.csv`)
  }

  // ── Salary slip ───────────────────────────────────────────────────────────

  function printSalarySlip(record: PayrollRecord) {
    const emp     = empList.find(e => e.id === record.employee_id)
    const empName = dn(emp || record.employee)
    const mon     = MONTHS[record.month - 1]
    const inr  = (n: number) => `₹${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    const ded  = (record.advances_deducted || 0) + (record.other_deductions || 0)
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Salary Slip — ${empName} — ${mon} ${record.year}</title>
<style>
  body{font-family:-apple-system,Arial,sans-serif;color:#111;padding:32px;max-width:560px;margin:auto}
  h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:24px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#888;border-bottom:2px solid #e5e7eb;padding:6px 0}
  td{padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px}td:last-child{text-align:right;font-weight:600}
  .total td{border-top:2px solid #111;border-bottom:none;font-weight:700;font-size:16px;padding-top:14px}
  .green{color:#16a34a}.red{color:#dc2626}
  .stamp{display:inline-block;border:2px solid #16a34a;color:#16a34a;border-radius:6px;padding:4px 14px;font-weight:700;font-size:13px;margin-top:12px;transform:rotate(-4deg)}
  .pending{border-color:#d97706;color:#d97706}
  @media print{button{display:none}}
</style></head><body>
<h1>Salary Slip</h1><p class="sub">Cirqle Design Agency &nbsp;|&nbsp; ${mon} ${record.year}</p>
<table><tr><th>Employee</th><th>CQID</th><th>Period</th></tr>
<tr><td>${empName}</td><td>${emp?.cqid || '—'}</td><td>${mon} ${record.year}</td></tr></table>
<table><tr><th>Component</th><th>Amount</th></tr>
<tr><td>Base Salary</td><td>${inr(record.base_salary)}</td></tr>
<tr class="green"><td>Commission Earned</td><td class="green">+ ${inr(record.commission_earned)}</td></tr>
${ded > 0 ? `<tr class="red"><td>Deductions (advance + other)</td><td class="red">− ${inr(ded)}</td></tr>` : ''}
<tr class="total"><td>Net Salary</td><td>${inr(record.net_salary)}</td></tr></table>
<div>${record.status === 'paid' ? `<span class="stamp">✓ Paid — ${record.paid_date || ''}</span>` : `<span class="stamp pending">Pending</span>`}</div>
<p style="margin-top:32px;font-size:11px;color:#999">Generated by Cirqle ERP on ${new Date().toLocaleDateString('en-GB')}</p>
<script>window.print()</script></body></html>`
    const w = window.open('', '_blank', 'width=640,height=800')
    if (w) { w.document.write(html); w.document.close() }
  }

  // ── Payroll form helpers ──────────────────────────────────────────────────

  const netSalary = (parseFloat(payForm.base_salary) || 0)
    + (parseFloat(payForm.commission_earned) || 0)
    - (parseFloat(payForm.advances_deducted) || 0)
    - (parseFloat(payForm.other_deductions)  || 0)

  const formMonthKey     = `${payForm.year}-${String(payForm.month).padStart(2, '0')}`
  const selectedEmpForm  = empList.find(e => e.id === payForm.employee_id)
  const scoredCommission = payForm.employee_id
    ? Math.round(commissionByEmpMonth[payForm.employee_id]?.[formMonthKey] || 0)
    : null

  function autoFillFromContributions() {
    if (!payForm.employee_id) return
    setPayForm(p => ({
      ...p,
      commission_earned: String(scoredCommission || 0),
      base_salary: selectedEmpForm?.base_salary ? String(selectedEmpForm.base_salary) : p.base_salary,
    }))
  }

  async function savePayroll(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    const { data, error } = await supabase.from('payroll').insert({
      employee_id: payForm.employee_id, month: payForm.month, year: payForm.year,
      base_salary: parseFloat(payForm.base_salary) || 0,
      commission_earned: parseFloat(payForm.commission_earned) || 0,
      advances_deducted: parseFloat(payForm.advances_deducted) || 0,
      other_deductions:  parseFloat(payForm.other_deductions) || 0,
      net_salary: netSalary, status: 'pending',
    }).select('*, employee:employees(id, cqid, name)').single()
    if (!error && data) { setPayroll(p => [data, ...p]); setShowPayrollForm(false) }
    setSaving(false)
  }

  async function saveAdvance(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    const { data, error } = await supabase.from('salary_advances').insert({
      employee_id: advForm.employee_id, amount: parseFloat(advForm.amount) || 0,
      advance_date: advForm.advance_date, reason: advForm.reason,
      repayment_type: advForm.repayment_type, status: 'pending',
    }).select('*, employee:employees(id, cqid)').single()
    if (!error && data) { setAdvList((a: any[]) => [data, ...a]); setShowAdvanceForm(false) }
    setSaving(false)
  }

  async function saveCredit(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    const { data, error } = await supabase.from('credit_ledger').insert({
      entity_type: creditForm.entity_type, entity_id: creditForm.entity_id,
      credit_type: creditForm.credit_type, amount: parseFloat(creditForm.amount) || 0,
      credit_date: creditForm.credit_date, notes: creditForm.notes,
    }).select('*, employee:employees(id, cqid)').single()
    if (!error && data) { setCreditList((c: any[]) => [data, ...c]); setShowCreditForm(false) }
    setSaving(false)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div>
      <Header
        title="HR & Payroll"
        subtitle="Smart payroll with automatic commission calculation"
        actions={
          <div className="flex gap-2">
            {tab === 'Records' && <>
              <button onClick={exportPayrollCSV} className="flex items-center gap-1.5 bg-secondary border border-border text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors">
                <Download className="w-4 h-4" /> Export CSV
              </button>
              <button onClick={() => setShowPayrollForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                <Plus className="w-4 h-4" /> Add Manual
              </button>
            </>}
            {tab === 'Advances' && <>
              <button onClick={exportAdvancesCSV} className="flex items-center gap-1.5 bg-secondary border border-border text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors">
                <Download className="w-4 h-4" /> Export CSV
              </button>
              <button onClick={() => setShowAdvanceForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                <Plus className="w-4 h-4" /> Add Advance
              </button>
            </>}
            {tab === 'Credits' && (
              <button onClick={() => setShowCreditForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                <Plus className="w-4 h-4" /> Add Credit
              </button>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-4">

        {/* ── Tab bar ── */}
        <div className="flex gap-1 bg-secondary rounded-xl p-1 w-fit">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors relative ${tab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {t}
              {t === 'Overview' && missingContribTasks.length > 0 &&
                viewMonth === now.getMonth() + 1 && viewYear === now.getFullYear() && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center leading-none">
                  {missingContribTasks.length > 99 ? '99+' : missingContribTasks.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ════════════════════════════════════════════════════
            OVERVIEW TAB
        ════════════════════════════════════════════════════ */}
        {tab === 'Overview' && (
          <div className="space-y-4">

            {/* Month navigation + summary */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button onClick={() => navigateMonth(-1)} className="p-2 rounded-lg bg-secondary border border-border hover:bg-secondary/80 transition-colors">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-base font-semibold w-32 text-center">{MONTHS[viewMonth - 1]} {viewYear}</span>
                <button onClick={() => navigateMonth(1)} className="p-2 rounded-lg bg-secondary border border-border hover:bg-secondary/80 transition-colors">
                  <ChevronRight className="w-4 h-4" />
                </button>
                {(viewMonth !== now.getMonth() + 1 || viewYear !== now.getFullYear()) && (
                  <button onClick={() => { setViewMonth(now.getMonth() + 1); setViewYear(now.getFullYear()) }}
                    className="text-xs text-primary hover:underline ml-1">
                    This month
                  </button>
                )}
                {/* Live indicator + refresh */}
                <div className="flex items-center gap-1.5 ml-2">
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span className={`w-1.5 h-1.5 rounded-full ${refreshing ? 'bg-amber-400 animate-pulse' : 'bg-green-400'}`} />
                    {refreshing ? 'Updating…' : `Live · ${lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
                  </span>
                  <button onClick={refreshScores} disabled={refreshing} title="Refresh commission data"
                    className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-xs px-3 py-1.5 rounded-lg bg-card border border-border">
                  Total: <span className="font-semibold text-foreground">₹{monthStats.total.toLocaleString('en-IN')}</span>
                </div>
                {monthStats.paid > 0 && (
                  <div className="text-xs px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400">
                    Paid: ₹{monthStats.paid.toLocaleString('en-IN')} ({monthStats.paidCount})
                  </div>
                )}
                {monthStats.pending > 0 && (
                  <div className="text-xs px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
                    Pending: ₹{monthStats.pending.toLocaleString('en-IN')}
                  </div>
                )}
              </div>
            </div>

            {/* Missing contributions alert */}
            {missingContribTasks.length > 0 && (
              <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-amber-300 mb-2">
                      {missingContribTasks.length} completed task{missingContribTasks.length !== 1 ? 's' : ''} missing contribution scores in {MONTHS[viewMonth - 1]}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 mb-3">
                      {missingContribTasks.slice(0, 6).map(t => (
                        <div key={t.id} className="flex items-center gap-2 text-xs text-amber-200/60">
                          <span className="w-1 h-1 rounded-full bg-amber-500/50 shrink-0" />
                          <span className="truncate">{t.title}</span>
                          <span className="text-amber-500/50 shrink-0 ml-auto">{t.task_date}</span>
                        </div>
                      ))}
                      {missingContribTasks.length > 6 && (
                        <p className="text-xs text-amber-500/50">+{missingContribTasks.length - 6} more tasks</p>
                      )}
                    </div>
                    <a href="/dashboard/contributions" className="inline-flex items-center gap-1 text-xs text-amber-400 hover:underline">
                      Go to Contributions to add scores <ArrowRight className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* Generate all banner */}
            {unprocessedEmps.length > 0 && (
              <div className="flex items-center justify-between bg-card border border-primary/20 rounded-xl p-4 gap-4">
                <div>
                  <p className="text-sm font-semibold">
                    {unprocessedEmps.length} employee{unprocessedEmps.length !== 1 ? 's' : ''} not yet in payroll for {MONTHS[viewMonth - 1]} {viewYear}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Commission auto-calculated from contribution scores · Advances pre-filled from pending advances
                  </p>
                </div>
                <button onClick={openGeneratePreview}
                  className="flex items-center gap-2 gradient-bg text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:opacity-90 shrink-0">
                  <Zap className="w-4 h-4" /> Generate All
                </button>
              </div>
            )}

            {/* Employee cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {empList.filter(e => e.is_active).map(emp => {
                const commission = monthCommissions[emp.id] || 0
                const record         = monthPayroll.find(r => r.employee_id === emp.id)
                const workedDays     = attendanceByEmp[emp.id]?.size || 0
                const netEst         = (emp.base_salary || 0) + commission
                const nextPayDate    = getNextSalaryDate(emp.salary_day || 1)
                const daysToPayday   = daysUntil(nextPayDate)
                const isCurrentMonth = viewMonth === now.getMonth() + 1 && viewYear === now.getFullYear()

                return (
                  <div key={emp.id}
                    className="bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-all cursor-pointer group"
                    onClick={() => setSelectedEmp(emp)}>
                    {/* Card header */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl gradient-bg flex items-center justify-center shrink-0">
                          <span className="text-white text-[10px] font-bold">{emp.cqid}</span>
                        </div>
                        <div>
                          <p className="text-sm font-semibold leading-tight">{dn(emp)}</p>
                          <p className="text-[11px] text-muted-foreground capitalize">{emp.role.replace(/_/g, ' ')}</p>
                        </div>
                      </div>
                      {record
                        ? record.status === 'paid'
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-400 shrink-0">Paid</span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-400 shrink-0">Pending</span>
                        : commission > 0
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-400 shrink-0">Ready</span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground shrink-0">No data</span>
                      }
                    </div>

                    {/* Breakdown */}
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Base</span>
                        <span>₹{(emp.base_salary || 0).toLocaleString('en-IN')}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Commission</span>
                        <span className={commission > 0 ? 'text-green-400' : 'text-muted-foreground'}>
                          {commission > 0 ? `+₹${commission.toLocaleString('en-IN')}` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between font-semibold text-sm pt-1.5 border-t border-border/60">
                        <span>Net Payable</span>
                        <span>₹{(record?.net_salary ?? netEst).toLocaleString('en-IN')}</span>
                      </div>
                    </div>

                    {/* Attendance + next payday */}
                    <div className="mt-2.5 flex items-center justify-between text-[11px] text-muted-foreground">
                      {workedDays > 0
                        ? <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {workedDays} day{workedDays !== 1 ? 's' : ''} active</span>
                        : <span />
                      }
                      {isCurrentMonth && !record && (
                        <span className={`flex items-center gap-1 ${daysToPayday <= 3 ? 'text-amber-400' : ''}`}>
                          Pay {daysToPayday === 0 ? 'today' : daysToPayday === 1 ? 'tomorrow' : `in ${daysToPayday}d`}
                          {' · '}{nextPayDate.getDate()} {MONTHS[nextPayDate.getMonth()]}
                        </span>
                      )}
                    </div>

                    {/* Action buttons */}
                    {record && record.status !== 'paid' && (
                      <button onClick={e => { e.stopPropagation(); confirmMarkPaid(record.id) }}
                        className="mt-3 w-full text-xs py-1.5 rounded-lg bg-secondary hover:bg-green-500/10 hover:text-green-400 border border-border hover:border-green-500/30 transition-all font-medium">
                        Mark Paid
                      </button>
                    )}
                    {record && record.status === 'paid' && (
                      <button onClick={e => { e.stopPropagation(); confirmMarkUnpaid(record.id) }}
                        className="mt-3 w-full text-xs py-1.5 rounded-lg text-muted-foreground/50 hover:text-red-400 hover:bg-red-500/5 border border-transparent hover:border-red-500/20 transition-all">
                        Undo Payment
                      </button>
                    )}
                    {!record && (
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          setPayForm(p => ({ ...p, employee_id: emp.id, month: viewMonth, year: viewYear, base_salary: String(emp.base_salary || ''), commission_earned: String(commission) }))
                          setShowPayrollForm(true)
                        }}
                        className="mt-3 w-full text-xs py-1.5 rounded-lg bg-secondary hover:bg-primary/10 hover:text-primary border border-border hover:border-primary/30 transition-all font-medium">
                        Add to Payroll
                      </button>
                    )}
                    <p className="text-[10px] text-primary mt-1.5 opacity-0 group-hover:opacity-60 transition-opacity">View details & history →</p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════
            RECORDS TAB
        ════════════════════════════════════════════════════ */}
        {tab === 'Records' && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Employee</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Period</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Base</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Commission</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Deductions</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Net</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {payroll.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">No payroll records yet. Use Generate on the Overview tab.</td></tr>
                )}
                {payroll.map(record => {
                  const emp = empList.find(e => e.id === record.employee_id)
                  const ded = (record.advances_deducted || 0) + (record.other_deductions || 0)
                  return (
                    <tr key={record.id} className="hover:bg-secondary/20">
                      <td className="px-4 py-3">
                        <p className="font-medium">{dn(emp || record.employee)}</p>
                        <p className="text-xs text-muted-foreground">{(emp || record.employee)?.cqid}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{MONTHS[record.month - 1]} {record.year}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">₹{(record.base_salary || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-right text-green-400">+₹{(record.commission_earned || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-right text-red-400">{ded > 0 ? `-₹${ded.toLocaleString('en-IN')}` : '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold">₹{(record.net_salary || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3">
                        {record.status === 'paid'
                          ? <div className="flex items-center gap-1.5">
                              <span className="text-xs px-2 py-0.5 rounded-md bg-green-500/15 text-green-400">Paid {record.paid_date}</span>
                              <button onClick={() => confirmMarkUnpaid(record.id)} title="Undo payment"
                                className="text-xs px-1.5 py-0.5 rounded-md text-muted-foreground/50 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                                Undo
                              </button>
                            </div>
                          : <button onClick={() => confirmMarkPaid(record.id)} className="text-xs px-2 py-1 rounded-md bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25 transition-colors">Mark Paid</button>
                        }
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => printSalarySlip(record)} title="Print salary slip"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ════════════════════════════════════════════════════
            EMPLOYEES TAB
        ════════════════════════════════════════════════════ */}
        {tab === 'Employees' && (() => {
          // Build month-wise payroll table: last 6 months
          const last6Months = Array.from({ length: 6 }, (_, i) => {
            const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1)
            return { month: d.getMonth() + 1, year: d.getFullYear(), label: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` }
          })
          return (
          <div className="space-y-5">

          {/* Month-wise payroll summary table */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Month-wise Payroll Summary</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Net salary paid per employee · last 6 months</p>
              </div>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-secondary/60 border-b border-border">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground sticky left-0 bg-secondary/60 min-w-[120px]">Employee</th>
                    {last6Months.map(m => (
                      <th key={`${m.year}-${m.month}`} className={`px-4 py-3 text-right text-xs font-semibold min-w-[90px] ${m.month === now.getMonth() + 1 && m.year === now.getFullYear() ? 'text-primary' : 'text-muted-foreground'}`}>
                        {m.label}
                      </th>
                    ))}
                    <th className="px-4 py-3 text-right text-xs font-semibold text-foreground min-w-[90px]">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {empList.filter(e => e.is_active).map(emp => {
                    const monthNets = last6Months.map(m => {
                      const rec = payroll.find(r => r.employee_id === emp.id && r.month === m.month && r.year === m.year)
                      return { ...m, net: rec?.net_salary || 0, status: rec?.status, commission: rec?.commission_earned || 0 }
                    })
                    const total = monthNets.reduce((s, m) => s + m.net, 0)
                    return (
                      <tr key={emp.id} className="hover:bg-secondary/20 cursor-pointer" onClick={() => setSelectedEmp(emp)}>
                        <td className="px-4 py-3 sticky left-0 bg-card">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg gradient-bg flex items-center justify-center shrink-0">
                              <span className="text-white text-[9px] font-bold">{emp.cqid.replace('CQID','')}</span>
                            </div>
                            <div>
                              <p className="text-xs font-semibold">{dn(emp)}</p>
                              <p className="text-[10px] text-muted-foreground">{emp.cqid}</p>
                            </div>
                          </div>
                        </td>
                        {monthNets.map(m => (
                          <td key={`${m.year}-${m.month}`} className="px-4 py-3 text-right">
                            {m.net > 0 ? (
                              <div>
                                <p className={`text-xs font-semibold ${m.status === 'paid' ? 'text-green-400' : 'text-amber-400'}`}>
                                  ₹{formatCompact(m.net)}
                                </p>
                                {m.commission > 0 && (
                                  <p className="text-[10px] text-muted-foreground">+₹{formatCompact(m.commission)} comm</p>
                                )}
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground/30">—</span>
                            )}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-right">
                          <p className="text-xs font-bold">{total > 0 ? `₹${formatCompact(total)}` : '—'}</p>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-secondary/40 border-t-2 border-border">
                    <td className="px-4 py-3 text-xs font-semibold text-muted-foreground sticky left-0 bg-secondary/40">Monthly Total</td>
                    {last6Months.map(m => {
                      const total = empList.filter(e => e.is_active).reduce((s, emp) => {
                        const rec = payroll.find(r => r.employee_id === emp.id && r.month === m.month && r.year === m.year)
                        return s + (rec?.net_salary || 0)
                      }, 0)
                      return (
                        <td key={`${m.year}-${m.month}`} className="px-4 py-3 text-right text-xs font-bold">
                          {total > 0 ? <span className="gradient-text">₹{formatCompact(total)}</span> : <span className="text-muted-foreground/30">—</span>}
                        </td>
                      )
                    })}
                    <td className="px-4 py-3 text-right text-xs font-bold gradient-text">
                      ₹{formatCompact(empList.filter(e => e.is_active).reduce((total, emp) =>
                        total + payroll.filter(r => r.employee_id === emp.id).reduce((s, r) => s + (r.net_salary || 0), 0), 0
                      ))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="px-5 py-2.5 border-t border-border/40 flex gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-400" /> Paid</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" /> Pending</span>
              <span className="ml-auto">Click any row to view full profile</span>
            </div>
          </div>

          {/* Employee cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {empList.map(emp => {
              const allTimeNet   = payroll.filter(r => r.employee_id === emp.id).reduce((s, r) => s + (r.net_salary || 0), 0)
              const recordCount  = payroll.filter(r => r.employee_id === emp.id).length
              const latestRecord = payroll.find(r => r.employee_id === emp.id) // already sorted desc
              const hist         = getEmpHistory(emp.id)
              const trend        = hist.length >= 2 ? hist[hist.length - 1].commission - hist[hist.length - 2].commission : 0

              return (
                <div key={emp.id}
                  className="bg-card border border-border rounded-xl p-5 hover:border-primary/30 transition-all cursor-pointer"
                  onClick={() => setSelectedEmp(emp)}>
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-xl gradient-bg flex items-center justify-center shrink-0">
                        <span className="text-white font-bold text-xs">{emp.cqid}</span>
                      </div>
                      <div>
                        <p className="font-semibold">{dn(emp)}</p>
                        <p className="text-xs text-muted-foreground capitalize">{emp.role.replace(/_/g, ' ')}</p>
                        {isUnlocked && emp.email && <p className="text-xs text-muted-foreground">{emp.email}</p>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <span className={`text-xs px-2 py-0.5 rounded-md ${emp.is_active ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-400'}`}>
                        {emp.is_active ? 'Active' : 'Inactive'}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{emp.performance_rating}% rating</span>
                    </div>
                  </div>

                  {/* Mini stats */}
                  <div className="grid grid-cols-3 gap-2 text-sm mb-4">
                    {[
                      { label: 'Base/mo', value: `₹${formatCompact(emp.base_salary || 0)}` },
                      { label: 'All-time paid', value: `₹${formatCompact(allTimeNet)}` },
                      { label: 'Records', value: String(recordCount) },
                    ].map(s => (
                      <div key={s.label} className="bg-secondary/50 rounded-lg p-2.5">
                        <p className="text-[10px] text-muted-foreground uppercase font-medium mb-0.5">{s.label}</p>
                        <p className="font-semibold text-xs">{s.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Trend + last commission */}
                  {recordCount > 0 && (
                    <div className="flex items-center justify-between text-xs mb-4">
                      <span className="text-muted-foreground">Last commission</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-green-400">+₹{(latestRecord?.commission_earned || 0).toLocaleString('en-IN')}</span>
                        {trend !== 0 && (
                          trend > 0
                            ? <span className="flex items-center gap-0.5 text-green-400"><TrendingUp className="w-3 h-3" />+₹{Math.abs(trend).toLocaleString('en-IN')}</span>
                            : <span className="flex items-center gap-0.5 text-red-400"><TrendingDown className="w-3 h-3" />-₹{Math.abs(trend).toLocaleString('en-IN')}</span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <button onClick={e => { e.stopPropagation(); toggleReveal(emp.id, emp.reveal_salary) }}
                      className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors ${emp.reveal_salary ? 'bg-purple-500/15 text-purple-400' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
                      {emp.reveal_salary ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      {emp.reveal_salary ? 'Salary visible' : 'Salary hidden'}
                    </button>
                    <span className="text-[10px] text-primary">Full profile & history →</span>
                  </div>
                </div>
              )
            })}
          </div>
          </div>
          )
        })()}

        {/* ════════════════════════════════════════════════════
            ADVANCES TAB
        ════════════════════════════════════════════════════ */}
        {tab === 'Advances' && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Employee</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Reason</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {advList.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">No advances</td></tr>}
                {advList.map((adv: any) => (
                  <tr key={adv.id} className="hover:bg-secondary/20">
                    <td className="px-4 py-3 font-medium">{adv.employee?.cqid}</td>
                    <td className="px-4 py-3 text-muted-foreground">{adv.advance_date}</td>
                    <td className="px-4 py-3 text-right font-semibold">₹{(adv.amount || 0).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3 text-muted-foreground">{adv.reason || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-md ${adv.status === 'repaid' ? 'bg-green-500/15 text-green-400' : 'bg-orange-500/15 text-orange-400'}`}>
                        {adv.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ════════════════════════════════════════════════════
            CREDITS TAB
        ════════════════════════════════════════════════════ */}
        {tab === 'Credits' && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Entity</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Type</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {creditList.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">No credit entries</td></tr>}
                {creditList.map((cr: any) => (
                  <tr key={cr.id} className="hover:bg-secondary/20">
                    <td className="px-4 py-3 font-medium">{cr.employee?.cqid || cr.entity_type}</td>
                    <td className="px-4 py-3 text-muted-foreground">{cr.credit_date}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-md ${cr.credit_type === 'given' ? 'bg-orange-500/15 text-orange-400' : 'bg-green-500/15 text-green-400'}`}>
                        {cr.credit_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">₹{(cr.amount || 0).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3 text-muted-foreground">{cr.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </div>{/* /p-6 */}

      {/* ════════════════════════════════════════════════════
          EMPLOYEE DETAIL MODAL
      ════════════════════════════════════════════════════ */}
      {selectedEmp && (() => {
        const emp        = selectedEmp
        const history    = getEmpHistory(emp.id)
        const workedDays = attendanceByEmp[emp.id] || new Set<string>()
        const daysInMon  = new Date(viewYear, viewMonth, 0).getDate()
        const empTasks   = getEmpMonthTasks(emp.id)
        const record     = monthPayroll.find(r => r.employee_id === emp.id)
        const commission = monthCommissions[emp.id] || 0
        const allRecords = payroll.filter(r => r.employee_id === emp.id)
        const totalPaid  = allRecords.filter(r => r.status === 'paid').reduce((s, r) => s + (r.net_salary || 0), 0)

        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-[#0d1117] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">

              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 sticky top-0 bg-[#0d1117] z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center shrink-0">
                    <span className="text-white font-bold text-xs">{emp.cqid}</span>
                  </div>
                  <div>
                    <h2 className="font-semibold">{dn(emp)}</h2>
                    <p className="text-xs text-muted-foreground capitalize">
                      {emp.role.replace(/_/g, ' ')} · ₹{(emp.base_salary || 0).toLocaleString('en-IN')}/mo · {emp.performance_rating}% rating
                    </p>
                  </div>
                </div>
                <button onClick={() => setSelectedEmp(null)} className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-white/5">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 space-y-6">

                {/* This-month stat row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Base Salary',  value: `₹${(emp.base_salary || 0).toLocaleString('en-IN')}`, cls: '' },
                    { label: 'Commission',   value: commission > 0 ? `+₹${commission.toLocaleString('en-IN')}` : '—', cls: commission > 0 ? 'text-green-400' : '' },
                    { label: 'Net Payable',  value: `₹${(record?.net_salary ?? (emp.base_salary || 0) + commission).toLocaleString('en-IN')}`, cls: 'font-semibold' },
                    { label: 'Active Days',  value: `${workedDays.size} / ${daysInMon}`, cls: 'text-blue-400' },
                  ].map(item => (
                    <div key={item.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                      <p className="text-[10px] text-muted-foreground uppercase font-medium mb-1">{item.label}</p>
                      <p className={`text-sm ${item.cls}`}>{item.value}</p>
                      {item.label === 'Net Payable' && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">{MONTHS[viewMonth - 1]} {viewYear}</p>
                      )}
                    </div>
                  ))}
                </div>

                {/* All-time summary */}
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>All-time records: <span className="text-foreground font-medium">{allRecords.length}</span></span>
                  <span>Total paid out: <span className="text-green-400 font-medium">₹{totalPaid.toLocaleString('en-IN')}</span></span>
                </div>

                {/* 6-month earnings chart */}
                <div>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-3 flex items-center gap-1.5">
                    <BarChart2 className="w-3.5 h-3.5" /> 6-Month Earnings (Base + Commission)
                  </h3>
                  <div className="h-44">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={history} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barSize={20}>
                        <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false}
                          tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} width={38} />
                        <Tooltip
                          contentStyle={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', fontSize: 12 }}
                          formatter={(v: any, name: any) => [`₹${Number(v).toLocaleString('en-IN')}`, name === 'base' ? 'Base' : 'Commission']}
                        />
                        <Bar dataKey="base"       name="base"       stackId="a" fill="#6366f1" radius={[0, 0, 2, 2]} />
                        <Bar dataKey="commission" name="commission" stackId="a" fill="#22c55e" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex gap-4 mt-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-500/80" />Base</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-green-500/80" />Commission</span>
                  </div>
                </div>

                {/* Attendance calendar */}
                <div>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-3 flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5" />
                    Attendance — {MONTHS[viewMonth - 1]} {viewYear}
                    <span className="text-[11px] normal-case font-normal text-muted-foreground/60">
                      {workedDays.size} of {daysInMon} days with contributions
                    </span>
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: daysInMon }, (_, i) => {
                      const d       = i + 1
                      const dateStr = `${viewYear}-${String(viewMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`
                      const worked  = workedDays.has(dateStr)
                      const isToday = dateStr === now.toISOString().split('T')[0]
                      return (
                        <div key={d} title={`${d} ${MONTHS[viewMonth - 1]}`}
                          className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-medium border transition-all
                            ${worked   ? 'bg-green-500/20 text-green-300 border-green-500/30' :
                              isToday  ? 'bg-blue-500/15 text-blue-400 border-blue-500/20' :
                                         'bg-white/[0.02] text-muted-foreground/30 border-white/[0.04]'}`}>
                          {d}
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex gap-5 mt-2.5">
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-green-500/20 border border-green-500/30" /> Has contributions</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-white/[0.02] border border-white/[0.04]" /> No data</span>
                  </div>
                </div>

                {/* Tasks this month */}
                {empTasks.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-3 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" /> Tasks with Scores — {MONTHS[viewMonth - 1]}
                      <span className="text-[11px] normal-case font-normal ml-1">{empTasks.length} tasks</span>
                    </h3>
                    <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                      {empTasks.map(t => (
                        <div key={t.id} className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.05] rounded-lg px-3 py-2">
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            t.status === 'paid'      ? 'bg-green-400'  :
                            t.status === 'invoiced'  ? 'bg-blue-400'   :
                            t.status === 'delivered' ? 'bg-purple-400' : 'bg-amber-400'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{t.title}</p>
                            <p className="text-[11px] text-muted-foreground">{t.client?.name} · {t.task_date}</p>
                          </div>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                            t.status === 'paid'     ? 'bg-green-500/15 text-green-400' :
                            t.status === 'invoiced' ? 'bg-blue-500/15 text-blue-400'  : 'bg-secondary text-muted-foreground'
                          }`}>{t.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Footer actions */}
                <div className="flex gap-2 pt-2 border-t border-white/10">
                  {record ? (
                    <>
                      <button onClick={() => printSalarySlip(record)}
                        className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.07] border border-white/10 text-sm px-4 py-2 rounded-lg transition-colors">
                        <Printer className="w-3.5 h-3.5" /> Print Slip
                      </button>
                      {record.status !== 'paid' && (
                        <button onClick={() => { setSelectedEmp(null); confirmMarkPaid(record.id) }}
                          className="flex items-center gap-1.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                          <CheckCircle className="w-3.5 h-3.5" /> Mark Paid
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        setSelectedEmp(null)
                        setPayForm(p => ({ ...p, employee_id: emp.id, month: viewMonth, year: viewYear, base_salary: String(emp.base_salary || ''), commission_earned: String(commission) }))
                        setShowPayrollForm(true)
                      }}
                      className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                      <Plus className="w-3.5 h-3.5" /> Add to Payroll for {MONTHS[viewMonth - 1]}
                    </button>
                  )}
                </div>

              </div>
            </div>
          </div>
        )
      })()}

      {/* ════════════════════════════════════════════════════
          GENERATE PREVIEW MODAL
      ════════════════════════════════════════════════════ */}
      {generatePreview && (
        <ModalOverlay onClose={() => setGeneratePreview(null)}>
          <div className="bg-[#0d1117] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="font-semibold">Generate Payroll — {MONTHS[viewMonth - 1]} {viewYear}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Review auto-calculated values for {generatePreview.length} employee{generatePreview.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button onClick={() => setGeneratePreview(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5">
              <table className="w-full text-sm mb-4">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-white/10">
                    <th className="text-left pb-2.5">Employee</th>
                    <th className="text-right pb-2.5">Base</th>
                    <th className="text-right pb-2.5">Commission</th>
                    <th className="text-right pb-2.5">Deductions</th>
                    <th className="text-right pb-2.5 font-semibold text-foreground">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {generatePreview.map((p, i) => (
                    <tr key={i}>
                      <td className="py-2.5">
                        <p className="font-medium text-xs">{dn(p.employee)}</p>
                        <p className="text-[10px] text-muted-foreground">{p.employee.cqid}</p>
                      </td>
                      <td className="py-2.5 text-right text-xs text-muted-foreground">₹{p.base_salary.toLocaleString('en-IN')}</td>
                      <td className="py-2.5 text-right text-xs text-green-400">+₹{p.commission_earned.toLocaleString('en-IN')}</td>
                      <td className="py-2.5 text-right text-xs text-red-400">
                        {p.advances_deducted > 0 ? `-₹${p.advances_deducted.toLocaleString('en-IN')}` : '—'}
                      </td>
                      <td className="py-2.5 text-right text-sm font-semibold">₹{p.net_salary.toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-white/15">
                    <td className="pt-3 text-xs font-semibold">Total</td>
                    <td className="pt-3 text-right text-xs text-muted-foreground">₹{generatePreview.reduce((s, p) => s + p.base_salary, 0).toLocaleString('en-IN')}</td>
                    <td className="pt-3 text-right text-xs text-green-400">+₹{generatePreview.reduce((s, p) => s + p.commission_earned, 0).toLocaleString('en-IN')}</td>
                    <td className="pt-3 text-right text-xs text-red-400">-₹{generatePreview.reduce((s, p) => s + p.advances_deducted, 0).toLocaleString('en-IN')}</td>
                    <td className="pt-3 text-right text-sm font-bold">₹{generatePreview.reduce((s, p) => s + p.net_salary, 0).toLocaleString('en-IN')}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="text-xs text-muted-foreground mb-4">
                Commission from contribution scores · Advances auto-deducted from pending salary advances · All records created as <span className="text-amber-400">Pending</span>
              </p>
              <div className="flex gap-2">
                <button onClick={() => setGeneratePreview(null)}
                  className="flex-1 py-2.5 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors">
                  Cancel
                </button>
                <button onClick={confirmGenerate} disabled={saving}
                  className="flex-1 py-2.5 rounded-xl gradient-bg text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2">
                  {saving ? 'Creating…' : <><Zap className="w-4 h-4" /> Confirm & Generate</>}
                </button>
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ════════════════════════════════════════════════════
          PAYROLL FORM MODAL
      ════════════════════════════════════════════════════ */}
      {showPayrollForm && (
        <ModalOverlay onClose={() => setShowPayrollForm(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="font-semibold">Add Payroll Record</h2>
              <button onClick={() => setShowPayrollForm(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={savePayroll} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Employee *</label>
                <select value={payForm.employee_id}
                  onChange={e => {
                    const emp = empList.find(emp => emp.id === e.target.value)
                    setPayForm(p => ({ ...p, employee_id: e.target.value, base_salary: emp?.base_salary ? String(emp.base_salary) : p.base_salary }))
                  }}
                  required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                  <option value="">Select employee</option>
                  {empList.filter(e => e.is_active).map(e => <option key={e.id} value={e.id}>{e.cqid}{isUnlocked && e.name ? ` — ${e.name}` : ''}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Month</label>
                  <select value={payForm.month} onChange={e => setPayForm(p => ({ ...p, month: parseInt(e.target.value) }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                    {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Year</label>
                  <input type="number" value={payForm.year} onChange={e => setPayForm(p => ({ ...p, year: parseInt(e.target.value) }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" />
                </div>
              </div>
              {/* Auto-fill banner */}
              {payForm.employee_id && (
                <div className={`rounded-xl px-4 py-3 flex items-center gap-3 ${scoredCommission && scoredCommission > 0 ? 'bg-green-500/10 border border-green-500/20' : 'bg-secondary border border-border'}`}>
                  <div className="flex-1">
                    <p className="text-xs font-semibold">
                      {scoredCommission && scoredCommission > 0
                        ? `Commission from contributions: ₹${scoredCommission.toLocaleString('en-IN')}`
                        : `No contribution scores for ${MONTHS[payForm.month - 1]} ${payForm.year}`}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {scoredCommission && scoredCommission > 0 ? 'Click Auto-fill to populate fields' : 'Add scores in the Contributions page first'}
                    </p>
                  </div>
                  {scoredCommission != null && scoredCommission > 0 && (
                    <button type="button" onClick={autoFillFromContributions}
                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg gradient-bg text-white hover:opacity-90 shrink-0">
                      <Zap className="w-3.5 h-3.5" /> Auto-fill
                    </button>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Base Salary</label>
                  <input type="number" min="0" step="0.01" value={payForm.base_salary} onChange={e => setPayForm(p => ({ ...p, base_salary: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                    Commission
                    {payForm.commission_earned && scoredCommission && Math.round(parseFloat(payForm.commission_earned)) === scoredCommission && <CheckCircle className="w-3 h-3 text-green-400" />}
                  </label>
                  <input type="number" min="0" step="0.01" value={payForm.commission_earned} onChange={e => setPayForm(p => ({ ...p, commission_earned: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="0.00" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Advance Deductions</label>
                  <input type="number" min="0" step="0.01" value={payForm.advances_deducted} onChange={e => setPayForm(p => ({ ...p, advances_deducted: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Other Deductions</label>
                  <input type="number" min="0" step="0.01" value={payForm.other_deductions} onChange={e => setPayForm(p => ({ ...p, other_deductions: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="0.00" />
                </div>
              </div>
              <div className="bg-secondary rounded-lg px-4 py-3 flex justify-between">
                <span className="text-sm text-muted-foreground">Net Salary</span>
                <span className="font-bold text-green-400">₹{netSalary.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowPayrollForm(false)} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {/* ════════════════════════════════════════════════════
          ADVANCE FORM MODAL
      ════════════════════════════════════════════════════ */}
      {showAdvanceForm && (
        <ModalOverlay onClose={() => setShowAdvanceForm(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="font-semibold">Salary Advance</h2>
              <button onClick={() => setShowAdvanceForm(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={saveAdvance} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Employee *</label>
                <select value={advForm.employee_id} onChange={e => setAdvForm(p => ({ ...p, employee_id: e.target.value }))} required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                  <option value="">Select</option>
                  {empList.filter(e => e.is_active).map(e => <option key={e.id} value={e.id}>{e.cqid}{isUnlocked && e.name ? ` — ${e.name}` : ''}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Amount</label>
                  <input type="number" min="0" step="0.01" value={advForm.amount} onChange={e => setAdvForm(p => ({ ...p, amount: e.target.value }))} required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Date</label>
                  <input type="date" value={advForm.advance_date} onChange={e => setAdvForm(p => ({ ...p, advance_date: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Reason</label>
                <input type="text" value={advForm.reason} onChange={e => setAdvForm(p => ({ ...p, reason: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="Optional" />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowAdvanceForm(false)} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">{saving ? '…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {/* ════════════════════════════════════════════════════
          CREDIT FORM MODAL
      ════════════════════════════════════════════════════ */}
      {showCreditForm && (
        <ModalOverlay onClose={() => setShowCreditForm(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="font-semibold">Credit Entry</h2>
              <button onClick={() => setShowCreditForm(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={saveCredit} className="p-6 space-y-4">
              <div className="flex gap-2">
                {(['given', 'returned'] as const).map(t => (
                  <button key={t} type="button" onClick={() => setCreditForm(p => ({ ...p, credit_type: t }))}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${creditForm.credit_type === t ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground'}`}>
                    {t === 'given' ? 'Credit Given' : 'Credit Returned'}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">To / From</label>
                <select value={creditForm.entity_id} onChange={e => setCreditForm(p => ({ ...p, entity_id: e.target.value }))} required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                  <option value="">Select</option>
                  {empList.map(e => <option key={e.id} value={e.id}>{e.cqid}{isUnlocked && e.name ? ` — ${e.name}` : ''}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Amount</label>
                  <input type="number" min="0" step="0.01" value={creditForm.amount} onChange={e => setCreditForm(p => ({ ...p, amount: e.target.value }))} required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Date</label>
                  <input type="date" value={creditForm.credit_date} onChange={e => setCreditForm(p => ({ ...p, credit_date: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Notes</label>
                <input type="text" value={creditForm.notes} onChange={e => setCreditForm(p => ({ ...p, notes: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="Optional" />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowCreditForm(false)} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">{saving ? '…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {/* ════════════════════════════════════════════════════
          CONFIRM MODAL
      ════════════════════════════════════════════════════ */}
      {confirmModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setConfirmModal(null) }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-[#0d1117] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <h3 className="font-semibold text-sm mb-2">{confirmModal.title}</h3>
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed whitespace-pre-line">{confirmModal.body}</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors">
                Cancel
              </button>
              <button onClick={confirmModal.onConfirm}
                className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 text-white text-sm font-semibold transition-colors">
                {confirmModal.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
