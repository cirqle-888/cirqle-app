'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import { createClient, safeFetchAll } from '@/lib/supabase/client'
import {
  bulkGeneratePayroll, createPayrollRecord, markPayrollPaid, markPayrollUnpaid,
  toggleRevealSalary, createSalaryAdvance, createCreditEntry, refreshPayrollRecord, recalculatePayrollForMonth
} from './actions'
import { formatCompact } from '@/lib/calculations/currency'
import { usePrivacy } from "@/contexts/privacy-context"
import { cn, ROW_INTERACTIVE_CLASS, BRANDED_PILL_BASE_CLASS, BRANDED_PILL_SELECTED_CLASS, BRANDED_PILL_ACTIVE_CLASS } from "@/lib/utils"
import {
  Plus, X, Eye, EyeOff, Zap, CheckCircle, Printer, Download,
  ChevronLeft, ChevronRight, AlertTriangle, Calendar, BarChart2,
  FileText, ArrowRight, TrendingUp, TrendingDown, RefreshCw, Mail, Loader2,
} from 'lucide-react'
import { sendBulkPayslips } from '@/lib/payslip/actions'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { todayISO } from '@/lib/utils/local-date'

// Heavy bulk-generate modal (773 lines) — only mounts when an admin clicks
// the action. Splitting it off the initial payroll chunk reduces the entry
// payload meaningfully; for users who never trigger it, it never downloads.
const BulkGenerateModal = dynamic(
  () => import('@/components/payroll/bulk-generate-modal'),
  { ssr: false },
)

// Payslip preview/send modal — only loads when "Send Payslip" is clicked.
const PayslipModal = dynamic(
  () => import('@/components/payroll/payslip-modal').then(m => m.PayslipModal),
  { ssr: false },
)

// Recharts is lazy-loaded — only fetched when the employee history chart renders.
const PayrollHistoryBar = dynamic(
  () => import('./_charts').then(m => m.PayrollHistoryBar),
  { ssr: false, loading: () => <div className="w-full h-full bg-secondary/30 rounded animate-pulse" /> },
)

// Activity timeline — lazy-loaded so it only fetches when the modal opens.
const EmployeeActivityTimeline = dynamic(
  () => import('./_activity-timeline').then(m => m.EmployeeActivityTimeline),
  { ssr: false, loading: () => <div className="h-16 bg-secondary/30 rounded-xl animate-pulse" /> },
)

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
  // Monetary fields are stripped for viewers without `payroll.view_amounts`,
  // so they're optional at the type level. Workflow fields (status, paid_date,
  // employee join) remain available.
  base_salary?: number
  commission_earned?: number
  /** Corrections owed for already-closed months, paid with this payslip. */
  adjustment_earned?: number
  /** Ownership rewards — revenue/profit share, incentives, bonuses. */
  ownership_earned?: number
  advances_deducted?: number
  other_deductions?: number
  net_salary?: number
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
    /** Stripped from payload when viewer lacks `contributions.view_earnings`. */
    earnings_inr?: number
    /** This employee's share of the task's pool, as a percentage. */
    score_percentage?: number | null
    /** True when someone typed the earning instead of the pool deriving it. */
    is_manual_override?: boolean | null
    earning_source?: string | null
    calculated_at: string
    task?: { id?: string; task_date: string; title?: string; status?: string } | null
  }[]
  allTasks: {
    id: string
    title: string
    task_date: string
    status: string
    /** Absent unless the viewer holds `tasks.view_pricing`. */
    billing_amount_inr?: number | null
    client?: { name: string } | null
    service?: { name: string } | null
  }[]
  /**
   * True when the viewer holds `payroll.view_amounts`. When false, base_salary,
   * commission_earned, net_salary, advance amounts, credit amounts, and
   * deduction amounts are absent from the props (stripped server-side); the
   * client uses this flag to suppress ₹ cards and totals so the UI doesn't
   * render misleading "₹0" placeholders.
   */
  showAmounts: boolean
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

/** Clean avatar text: initials from the (privacy-aware) display name when it's
 *  a real name, otherwise the numeric part of the CQID (e.g. "001"). Keeps the
 *  gradient circles legible instead of cramming the full "CQID001". */
function avatarText(displayName: string | undefined, cqid: string): string {
  const n = (displayName || '').trim()
  if (n && !/^CQID/i.test(n)) {
    const parts = n.split(/\s+/).filter(Boolean)
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
  }
  return (cqid || '').replace(/^CQID/i, '') || '–'
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Earnings already stored on a payroll row that the live recalculation does
 * not recompute: prior-period adjustments and ownership rewards.
 *
 * Kept as one helper because the net formula appears in several places here —
 * adding a future component in only some of them is exactly how a payslip
 * ends up disagreeing with the amount actually paid.
 */
function storedExtras(record: { adjustment_earned?: number | null; ownership_earned?: number | null } | null | undefined): number {
  if (!record) return 0
  return (Number(record.adjustment_earned) || 0) + (Number(record.ownership_earned) || 0)
}

export default function PayrollClient({
  employees, payrollRecords, advances, credits, deductions, contributionScores, allTasks,
  showAmounts,
}: Props) {
  // Suppress to '—' for fields that may have been stripped server-side. Math
  // that uses these fields coalesces to 0 so calculations remain stable.
  const amt = (n: number | undefined | null) => (showAmounts && n != null ? n : null)
  void amt   // kept available for callers that prefer this over inline conditionals
  const now    = new Date()
  const router = useRouter()
  const { dn, isUnlocked } = usePrivacy()
  const { toasts, dismiss, success: toastSuccess, error: toastError } = useToast()

  // ── UI state ──────────────────────────────────────────────────────────────
  const [tab, setTab] = useState('Overview')
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1)
  const [viewYear, setViewYear]   = useState(now.getFullYear())
  const [selectedEmp, setSelectedEmp]         = useState<Employee | null>(null)
  /** Attendance day drilled into inside the employee modal (YYYY-MM-DD). */
  const [selectedDay, setSelectedDay]         = useState<string | null>(null)
  const [generatePreview, setGeneratePreview] = useState<any[] | null>(null)
  const [payslipModal, setPayslipModal] = useState<{ employeeId: string } | null>(null)
  const [bulkPayslipConfirm, setBulkPayslipConfirm] = useState(false)
  const [bulkSending, setBulkSending] = useState(false)
  const [confirmModal, setConfirmModal]       = useState<{
    title: string; body: string; confirmLabel: string; onConfirm: () => void
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [showBulkGenerate, setShowBulkGenerate] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)

  // ── Records Tab Filters ───────────────────────────────────────────────────
  const [recordsFilterMonth, setRecordsFilterMonth] = useState('all')
  const [recordsFilterYear, setRecordsFilterYear]   = useState('all')
  const [recordsFilterEmpId, setRecordsFilterEmpId] = useState('all')
  const [recordsFilterStatus, setRecordsFilterStatus] = useState('all')

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
    employee_id: '', amount: '', advance_date: todayISO(now),
    reason: '', repayment_type: 'deduct_from_salary',
  })
  const [creditForm, setCreditForm] = useState({
    entity_type: 'employee', entity_id: '', credit_type: 'given',
    amount: '', credit_date: todayISO(now), notes: '',
  })

  const supabase = createClient()

  // ── Refresh commission scores from DB (client-side fetch) ─────────────────
  // Scope: matches the server payload — last 24 months. The UI only navigates
  // ±5 months from the current view, so anything older is unreachable.
  const refreshScores = useCallback(async () => {
    setRefreshing(true)
    const windowFrom = new Date()
    windowFrom.setMonth(windowFrom.getMonth() - 24)
    const query = supabase
      .from('contribution_scores')
      .select('task_id, employee_id, earnings_inr, calculated_at, task:tasks(id, task_date, title, status)')
      .gte('calculated_at', windowFrom.toISOString())
      .order('calculated_at', { ascending: false })
      .order('id', { ascending: true })
    const { data } = await safeFetchAll(query)
    if (data) {
      setLiveScores(data as any)
      setLastRefresh(new Date())
    }
    setRefreshing(false)
  }, [supabase])

  // ── Supabase Realtime: auto-update when any score changes ─────────────────
  // Debounced: a single batch contribution save can fire dozens of row events.
  // Without debouncing we'd refetch the entire scores table for each event,
  // saturating the connection. 1500 ms is long enough to coalesce a typical
  // save burst, short enough to feel live.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const trigger = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refreshScores() }, 1500)
    }
    // Unique per mount — a static topic name gets reused (returns the same,
    // already-subscribed channel) if the previous mount's async removeChannel
    // hasn't finished yet, which throws under React Strict Mode's dev
    // double-effect remount.
    const channel = supabase
      .channel(`payroll-scores-live-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contribution_scores' }, trigger)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
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

  const filteredRecords = useMemo(() => {
    return payroll.filter(r => {
      if (recordsFilterMonth !== 'all' && r.month.toString() !== recordsFilterMonth) return false
      if (recordsFilterYear !== 'all' && r.year.toString() !== recordsFilterYear) return false
      if (recordsFilterEmpId !== 'all' && r.employee_id !== recordsFilterEmpId) return false
      if (recordsFilterStatus !== 'all' && r.status !== recordsFilterStatus) return false
      return true
    })
  }, [payroll, recordsFilterMonth, recordsFilterYear, recordsFilterEmpId, recordsFilterStatus])
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
  /**
   * This employee's tasks for the month, each paired with the contribution
   * score that produced its earning — so the modal can show not just WHAT was
   * earned but how it was derived (task value × share).
   */
  function getEmpMonthTasks(empId: string) {
    const scoreByTask = new Map<string, typeof liveScores[number]>()
    for (const s of liveScores) {
      if (s.employee_id !== empId) continue
      if (!(s.task?.task_date || s.calculated_at || '').startsWith(monthKey)) continue
      if (s.task_id) scoreByTask.set(s.task_id, s)
    }
    return allTasks
      .filter(t => scoreByTask.has(t.id))
      .map(t => ({ ...t, score: scoreByTask.get(t.id)! }))
      // Biggest earners first — the useful reading order on a pay review.
      .sort((a, b) => (b.score.earnings_inr ?? 0) - (a.score.earnings_inr ?? 0))
  }

  // ── Month navigation ──────────────────────────────────────────────────────

  function navigateMonth(dir: -1 | 1) {
    const d = new Date(viewYear, viewMonth - 1 + dir, 1)
    setViewMonth(d.getMonth() + 1)
    setViewYear(d.getFullYear())
    // The drilled-into day belongs to the month we just left.
    setSelectedDay(null)
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
      net_salary: p.net_salary, status: 'pending' as const,
    }))
    const result = await bulkGeneratePayroll(records)
    if (result.ok && result.data) { setPayroll(p => [...result.data!.rows, ...p]); setGeneratePreview(null) }
    setSaving(false)
  }

  // ── Mark paid ─────────────────────────────────────────────────────────────

  function confirmMarkPaid(id: string) {
    const record    = payroll.find(r => r.id === id)
    const emp       = empList.find(e => e.id === record?.employee_id)
    const monthName = record ? MONTHS[record.month - 1] : ''
    // Show the live (up-to-date) net amount in the confirmation
    const liveCommission = record ? (monthCommissions[record.employee_id] || 0) : 0
    const liveNet = record ? Math.max(0, (record.base_salary || 0) + liveCommission + storedExtras(record) - (record.advances_deducted || 0) - (record.other_deductions || 0)) : 0
    const displayNet = liveNet || record?.net_salary || 0
    // Full consequences up front: marking paid also writes the salary expense
    // into the Cash Book (previously only revealed by the Undo dialog), and
    // when the live recompute differs from the saved record, both figures are
    // shown so the owner knows exactly which number is being committed.
    const savedNet = record?.net_salary || 0
    const drifted = liveNet > 0 && savedNet > 0 && Math.round(liveNet) !== Math.round(savedNet)
    setConfirmModal({
      title:        'Mark Salary as Paid',
      body:         `Mark ${dn(emp) || 'this employee'}'s salary for ${monthName} ${record?.year ?? ''} as paid?\n` +
        (drifted
          ? `Current calculation: ₹${liveNet.toLocaleString('en-IN')} (saved record shows ₹${savedNet.toLocaleString('en-IN')} — the current figure is what gets paid).\n`
          : `Net: ₹${displayNet.toLocaleString('en-IN')}.\n`) +
        `Records today as the payment date and adds this amount as a salary expense in the Cash Book.`,
      confirmLabel: 'Mark Paid',
      onConfirm:    () => markPaid(id),
    })
  }

  async function markPaid(id: string) {
    setConfirmModal(null)
    const record = payroll.find(r => r.id === id)
    if (!record) return
    const liveCommission = monthCommissions[record.employee_id] || 0
    const liveNet = Math.max(0, (record.base_salary || 0) + liveCommission + storedExtras(record) - (record.advances_deducted || 0) - (record.other_deductions || 0))
    const finalNet = liveNet || record.net_salary || 0
    const emp = empList.find(e => e.id === record.employee_id)
    const result = await markPayrollPaid({
      id,
      employeeId: record.employee_id,
      employeeCqid: emp?.cqid || 'Employee',
      month: record.month,
      year: record.year,
      finalNet,
      liveCommission,
      salaryCategory: '001480fa-6ea1-47e5-9461-aef7a914fac5',
    })
    if (result.ok && result.data) {
      setPayroll(p => p.map(r => r.id === id ? { ...r, ...result.data!.updates } : r))
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
    const result = await markPayrollUnpaid(id)
    if (result.ok) {
      setPayroll(p => p.map(r => r.id === id ? { ...r, status: 'pending', paid_date: undefined } : r))
    }
  }

  async function toggleReveal(empId: string, current: boolean) {
    const result = await toggleRevealSalary(empId, current)
    if (result.ok) {
      setEmpList(e => e.map(emp => emp.id === empId ? { ...emp, reveal_salary: !current } : emp))
    }
  }

  // ── Bulk payslip send (all PAID employees this month) ─────────────────────
  async function handleBulkPayslips() {
    setBulkSending(true)
    const result = await sendBulkPayslips({ month: viewMonth, year: viewYear })
    setBulkSending(false)
    setBulkPayslipConfirm(false)
    if (result.ok && result.data) {
      const { sent, failed } = result.data
      if (failed === 0) toastSuccess(`Payslips sent`, `${sent} payslip${sent !== 1 ? 's' : ''} emailed for ${MONTHS[viewMonth - 1]}`)
      else toastError(`${sent} sent · ${failed} failed`, result.data.results.filter(r => !r.ok).map(r => `${r.cqid}: ${r.error}`).join('; '))
    } else {
      toastError('Bulk send failed', result.error)
    }
  }

  // ── Refresh Payroll ───────────────────────────────────────────────────────

  async function handleRefreshPayroll(id: string) {
    const record = payroll.find(r => r.id === id)
    if (!record || record.status === 'paid') return
    const liveComm = monthCommissions[record.employee_id] || 0
    const liveNet = Math.max(0, (record.base_salary || 0) + liveComm + storedExtras(record) - (record.advances_deducted || 0) - (record.other_deductions || 0))
    
    setRefreshingId(id)
    try {
      const result = await refreshPayrollRecord({
        id,
        newCommission: liveComm,
        newNetSalary: liveNet
      })
      if (result.ok && result.data) {
        setPayroll(prev => prev.map(p => p.id === id ? result.data!.row : p))
        // success silent
      } else {
        alert(result.error || 'Failed to refresh payroll')
      }
    } catch (e: any) {
      alert(e.message || 'Error refreshing payroll')
    } finally {
      setRefreshingId(null)
    }
  }

  // Whether a pending record's saved figures differ from the live recompute by
  // ≥ ₹1. The rounding tolerance keeps the Refresh affordance from appearing
  // for sub-rupee float noise. Paid records are immutable → never out of sync.
  function payrollOutOfSync(record: any): boolean {
    if (!record || record.status !== 'pending') return false
    const liveComm = monthCommissions[record.employee_id] || 0
    const liveNet = Math.max(0, (record.base_salary || 0) + liveComm + storedExtras(record) - (record.advances_deducted || 0) - (record.other_deductions || 0))
    return Math.round(record.commission_earned || 0) !== Math.round(liveComm)
      || Math.round(record.net_salary || 0) !== Math.round(liveNet)
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
      return [dn(emp) || '', emp?.cqid || r.employee?.cqid || '', MONTHS[r.month - 1], r.year,
        r.base_salary, r.commission_earned, (r.advances_deducted || 0) + (r.other_deductions || 0),
        r.net_salary, r.status, r.paid_date || '']
    })
    dl([header, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n'), `payroll-${monthKey}.csv`)
  }

  function exportAdvancesCSV() {
    const header = ['Employee', 'Amount', 'Date', 'Reason', 'Type', 'Status']
    const rows = advList.map((a: any) => {
      const emp = empList.find(e => e.id === a.employee_id)
      return [dn(emp) || '', a.amount, a.advance_date, a.reason || '', a.repayment_type || '', a.status || '']
    })
    dl([header, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n'), `advances-${todayISO(now)}.csv`)
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
<h1>Salary Slip</h1><p class="sub">Cirqle Works &nbsp;|&nbsp; ${mon} ${record.year}</p>
<table><tr><th>Employee</th><th>CQID</th><th>Period</th></tr>
<tr><td>${empName}</td><td>${emp?.cqid || '—'}</td><td>${mon} ${record.year}</td></tr></table>
<table><tr><th>Component</th><th>Amount</th></tr>
<tr><td>Base Salary</td><td>${inr(record.base_salary ?? 0)}</td></tr>
<tr class="green"><td>Commission Earned</td><td class="green">+ ${inr(record.commission_earned ?? 0)}</td></tr>
${ded > 0 ? `<tr class="red"><td>Deductions (advance + other)</td><td class="red">− ${inr(ded)}</td></tr>` : ''}
<tr class="total"><td>Net Salary</td><td>${inr(record.net_salary ?? 0)}</td></tr></table>
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
    const result = await createPayrollRecord({
      employee_id: payForm.employee_id, month: payForm.month, year: payForm.year,
      base_salary: parseFloat(payForm.base_salary) || 0,
      commission_earned: parseFloat(payForm.commission_earned) || 0,
      advances_deducted: parseFloat(payForm.advances_deducted) || 0,
      other_deductions:  parseFloat(payForm.other_deductions) || 0,
      net_salary: netSalary,
    })
    if (result.ok && result.data) { setPayroll(p => [result.data!.row, ...p]); setShowPayrollForm(false) }
    setSaving(false)
  }

  async function saveAdvance(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    const result = await createSalaryAdvance({
      employee_id: advForm.employee_id, amount: parseFloat(advForm.amount) || 0,
      advance_date: advForm.advance_date, reason: advForm.reason,
      repayment_type: advForm.repayment_type,
    })
    if (result.ok && result.data) { setAdvList((a: any[]) => [result.data!.row, ...a]); setShowAdvanceForm(false) }
    setSaving(false)
  }

  async function saveCredit(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    const result = await createCreditEntry({
      entity_type: creditForm.entity_type, entity_id: creditForm.entity_id,
      credit_type: creditForm.credit_type, amount: parseFloat(creditForm.amount) || 0,
      credit_date: creditForm.credit_date, notes: creditForm.notes,
    })
    if (result.ok && result.data) { setCreditList((c: any[]) => [result.data!.row, ...c]); setShowCreditForm(false) }
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
          <div className="flex items-center gap-2">
            {tab === 'Records' && <>
              <button onClick={exportPayrollCSV} className="flex items-center gap-1.5 bg-secondary/50 hover:bg-secondary border border-border/50 text-[13px] font-medium px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-all shadow-sm whitespace-nowrap">
                <Download className="w-4 h-4 shrink-0" /><span className="hidden sm:inline">Export CSV</span>
              </button>
              <button onClick={() => setShowPayrollForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-[13px] font-medium px-3 py-1.5 rounded-lg hover:opacity-90 whitespace-nowrap shadow-sm">
                <Plus className="w-4 h-4 shrink-0" /> Add Manual
              </button>
            </>}
            {tab === 'Overview' && (
              <button onClick={() => setShowBulkGenerate(true)} className="flex items-center gap-1.5 bg-secondary/50 hover:bg-secondary border border-border/50 text-[13px] font-medium px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-all shadow-sm whitespace-nowrap">
                <Zap className="w-4 h-4 shrink-0" /> Bulk Generate
              </button>
            )}
            {tab === 'Advances' && <>
              <button onClick={exportAdvancesCSV} className="flex items-center gap-1.5 bg-secondary/50 hover:bg-secondary border border-border/50 text-[13px] font-medium px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-all shadow-sm whitespace-nowrap">
                <Download className="w-4 h-4 shrink-0" /><span className="hidden sm:inline">Export CSV</span>
              </button>
              <button onClick={() => setShowAdvanceForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-[13px] font-medium px-3 py-1.5 rounded-lg hover:opacity-90 whitespace-nowrap shadow-sm">
                <Plus className="w-4 h-4 shrink-0" /> Add Advance
              </button>
            </>}
            {tab === 'Credits' && (
              <button onClick={() => setShowCreditForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-[13px] font-medium px-3 py-1.5 rounded-lg hover:opacity-90 whitespace-nowrap shadow-sm">
                <Plus className="w-4 h-4 shrink-0" /> Add Credit
              </button>
            )}
          </div>
        }
      />

      <div className="p-4 sm:p-6 space-y-4">

        {/* ── Sticky tab bar — stays pinned just below the Header as the
              page scrolls (top offset matches Header height: 68/72px). ── */}
        <div className="sticky top-[68px] sm:top-[72px] z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-background/80 backdrop-blur-md border-b border-border/50">
          <div className="flex bg-secondary/30 border border-border/50 p-0.5 w-fit overflow-x-auto max-w-full hide-scrollbar rounded-xl">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all relative whitespace-nowrap",
                  tab === t ? "bg-background text-foreground shadow-sm ring-1 ring-border/50" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                )}>
                {t}
                {t === 'Overview' && missingContribTasks.length > 0 &&
                  viewMonth === now.getMonth() + 1 && viewYear === now.getFullYear() && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center leading-none shadow-sm ring-2 ring-background">
                    {missingContribTasks.length > 99 ? '99+' : missingContribTasks.length}
                  </span>
                )}
              </button>
            ))}
          </div>
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
                  <button onClick={refreshScores} disabled={refreshing} title="Refresh contribution scores"
                    className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  </button>
                  {/* This writes commission, ownership and net onto every
                      PENDING payslip for the viewed month. As a bare ⚡ icon
                      8px from the harmless refresh it was one mis-click from
                      restating a month; now it is named and confirmed. */}
                  <button
                    onClick={() => setConfirmModal({
                      title: `Recalculate ${MONTHS[viewMonth - 1]} ${viewYear} payroll?`,
                      body: `Re-reads contribution earnings and ownership awards, then updates commission and net on every PENDING payslip for this month. Already-paid payslips are never changed.`,
                      confirmLabel: 'Recalculate month',
                      onConfirm: async () => {
                        setRefreshing(true)
                        const result = await recalculatePayrollForMonth({
                          month: viewMonth,
                          year: viewYear,
                          source: 'manual_refresh'
                        })
                        setRefreshing(false)
                        if (result.ok) {
                          const n = result.data?.updated ?? 0
                          toastSuccess(
                            `${MONTHS[viewMonth - 1]} payroll recalculated`,
                            n > 0
                              ? `${n} payslip${n !== 1 ? 's' : ''} updated`
                              : 'Every pending payslip already matched — nothing changed.',
                          )
                          router.refresh()
                        } else {
                          toastError('Payroll refresh failed', result.error)
                        }
                      },
                    })}
                    disabled={refreshing}
                    title="Recalculate pending payroll for this month"
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 text-[11px] font-medium"
                  >
                    <Zap className={`w-3.5 h-3.5 ${refreshing ? 'animate-pulse' : ''}`} />
                    <span className="hidden sm:inline">Recalculate…</span>
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-xs px-3 py-1.5 rounded-lg bg-card border border-border">
                  Total: <span className="font-semibold text-foreground">₹{monthStats.total.toLocaleString('en-IN')}</span>
                </div>
                {monthStats.paid > 0 && (
                  <div className="text-xs px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-700 dark:text-green-400">
                    Paid: ₹{monthStats.paid.toLocaleString('en-IN')} ({monthStats.paidCount})
                  </div>
                )}
                {monthStats.pending > 0 && (
                  <div className="text-xs px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
                    Pending: ₹{monthStats.pending.toLocaleString('en-IN')}
                  </div>
                )}
                {monthStats.paidCount > 0 && (
                  <button
                    onClick={() => setBulkPayslipConfirm(true)}
                    disabled={bulkSending}
                    title={`Email payslips to all ${monthStats.paidCount} paid employee${monthStats.paidCount !== 1 ? 's' : ''}`}
                    className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/25 text-primary hover:bg-primary/20 transition-colors flex items-center gap-1.5 font-medium disabled:opacity-50"
                  >
                    {bulkSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                    Send payslips ({monthStats.paidCount})
                  </button>
                )}
              </div>
            </div>

            {/* Missing contributions alert */}
            {missingContribTasks.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 dark:bg-amber-500/8 dark:border-amber-500/25">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0 dark:text-amber-400" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-amber-700 mb-2 dark:text-amber-700 dark:text-amber-300">
                      {missingContribTasks.length} completed task{missingContribTasks.length !== 1 ? 's' : ''} missing contribution scores in {MONTHS[viewMonth - 1]}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 mb-3">
                      {missingContribTasks.slice(0, 6).map(t => (
                        <div key={t.id} className="flex items-center gap-2 text-xs text-amber-800/80 dark:text-amber-700 dark:text-amber-200/60">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 dark:bg-amber-500/50" />
                          <span className="truncate">{t.title}</span>
                          <span className="text-amber-700/70 shrink-0 ml-auto dark:text-amber-500/50">{t.task_date}</span>
                        </div>
                      ))}
                      {missingContribTasks.length > 6 && (
                        <p className="text-xs text-amber-700/70 dark:text-amber-500/50">+{missingContribTasks.length - 6} more tasks</p>
                      )}
                    </div>
                    <a href="/dashboard/contributions" className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:underline dark:text-amber-400">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
                    className="group bg-card border border-border/40 rounded-2xl p-5 hover:border-primary/20 hover:shadow-sm transition-all cursor-pointer flex flex-col"
                    onClick={() => setSelectedEmp(emp)}>
                    {/* Card header */}
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center shrink-0 shadow-sm border border-border/50">
                          <span className="text-white text-sm font-bold tracking-wide">{avatarText(dn(emp), emp.cqid)}</span>
                        </div>
                        <div>
                          <p className="text-[15px] font-semibold tracking-tight text-foreground">{dn(emp)}</p>
                          <p className="text-[12px] text-muted-foreground capitalize">{emp.role.replace(/_/g, ' ')}</p>
                        </div>
                      </div>
                      {record
                        ? record.status === 'paid'
                          ? <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">Paid</span>
                          : <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">Pending</span>
                        : commission > 0
                          ? <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 shrink-0">Ready</span>
                          : <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-secondary text-muted-foreground border border-border/50 shrink-0">No data</span>
                      }
                    </div>

                    {/* Breakdown */}
                    <div className="space-y-2 text-[13px] bg-secondary/30 rounded-xl p-3 border border-border/50 mb-4 flex-1">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Base</span>
                        <span className="font-medium">₹{(emp.base_salary || 0).toLocaleString('en-IN')}</span>
                      </div>
                      <div className="flex justify-between items-center group/comm">
                        <span className="text-muted-foreground">Commission</span>
                        <div className="flex items-center gap-1.5">
                          <span className={cn("font-medium", commission > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                            {commission > 0 ? `+₹${commission.toLocaleString('en-IN')}` : '—'}
                          </span>
                        </div>
                      </div>
                      <div className="flex justify-between items-center font-semibold text-sm pt-2 mt-1 border-t border-border/60">
                        <span className="flex items-center gap-1.5 text-foreground">
                          Net payable
                        </span>
                        <span className="text-foreground tabular-nums">₹{(record?.net_salary ?? netEst).toLocaleString('en-IN')}</span>
                      </div>

                      {/* The amount being written used to be invisible: a bare
                          amber icon whose tooltip said only "live commission
                          changed". Both figures are now on screen before the
                          click, so nobody updates a payslip blind. */}
                      {record && payrollOutOfSync(record) && (() => {
                        const liveComm = monthCommissions[record.employee_id] || 0
                        const liveNet = Math.max(0, (record.base_salary || 0) + liveComm + storedExtras(record) - (record.advances_deducted || 0) - (record.other_deductions || 0))
                        return (
                          <div className="flex items-center justify-between gap-2 -mt-1 pt-2 text-[11px] text-amber-600 dark:text-amber-400">
                            <span className="min-w-0 truncate">
                              Earnings changed since saved: ₹{Math.round(record.net_salary || 0).toLocaleString('en-IN')} → ₹{Math.round(liveNet).toLocaleString('en-IN')}
                            </span>
                            <button
                              onClick={e => { e.stopPropagation(); handleRefreshPayroll(record.id) }}
                              disabled={refreshingId === record.id}
                              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-amber-500/30 px-1.5 py-0.5 font-medium hover:bg-amber-500/10 disabled:opacity-50"
                            >
                              <RefreshCw className={`w-3 h-3 ${refreshingId === record.id ? 'animate-spin' : ''}`} />
                              Update
                            </button>
                          </div>
                        )
                      })()}
                    </div>

                    {/* Attendance + next payday */}
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-4">
                      {workedDays > 0
                        ? <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> {workedDays} day{workedDays !== 1 ? 's' : ''} active</span>
                        : <span />
                      }
                      {isCurrentMonth && !record && (
                        <span className={`flex items-center gap-1 ${daysToPayday <= 3 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}>
                          Pay {daysToPayday === 0 ? 'today' : daysToPayday === 1 ? 'tomorrow' : `in ${daysToPayday}d`}
                          {' · '}{nextPayDate.getDate()} {MONTHS[nextPayDate.getMonth()]}
                        </span>
                      )}
                    </div>

                    {/* Action buttons */}
                    {record && record.status !== 'paid' && (
                      <div className="flex gap-2 mt-auto">
                        <button onClick={e => { e.stopPropagation(); confirmMarkPaid(record.id) }}
                          className="flex-1 text-[13px] py-2 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 transition-all font-medium shadow-sm">
                          Mark Paid
                        </button>
                        <button onClick={e => { e.stopPropagation(); setPayslipModal({ employeeId: emp.id }) }}
                          title="Send payslip"
                          className="px-3 py-2 rounded-lg bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground border border-border/50 transition-all shadow-sm">
                          <Mail className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                    {record && record.status === 'paid' && (
                      <div className="flex gap-2 mt-auto">
                        <button onClick={e => { e.stopPropagation(); setPayslipModal({ employeeId: emp.id }) }}
                          className="flex-1 text-[13px] py-2 rounded-lg bg-secondary hover:bg-secondary/80 text-foreground border border-border/50 transition-all font-medium flex items-center justify-center gap-2 shadow-sm">
                          <Mail className="w-4 h-4 text-muted-foreground" /> Send Payslip
                        </button>
                        <button onClick={e => { e.stopPropagation(); confirmMarkUnpaid(record.id) }}
                          title="Undo payment"
                          className="px-3 py-2 rounded-lg text-muted-foreground hover:text-red-600 dark:hover:text-red-400 bg-secondary/30 hover:bg-red-500/10 border border-border/30 hover:border-red-500/20 transition-all shadow-sm">
                          Undo
                        </button>
                      </div>
                    )}
                    {!record && (
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          setPayForm(p => ({ ...p, employee_id: emp.id, month: viewMonth, year: viewYear, base_salary: String(emp.base_salary || ''), commission_earned: String(commission) }))
                          setShowPayrollForm(true)
                        }}
                        className="w-full text-[13px] py-2 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 transition-all font-medium mt-auto shadow-sm">
                        Add to Payroll
                      </button>
                    )}
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
          <div className="bg-card border border-border rounded-xl">
            {/* Filter Bar */}
            <div className="px-5 py-4 border-b border-border flex flex-wrap gap-3 bg-secondary/10">
              <select value={recordsFilterMonth} onChange={e => setRecordsFilterMonth(e.target.value)}
                className="text-[13px] bg-background border border-border/50 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-sm">
                <option value="all">All Months</option>
                {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </select>
              <select value={recordsFilterYear} onChange={e => setRecordsFilterYear(e.target.value)}
                className="text-[13px] bg-background border border-border/50 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-sm">
                <option value="all">All Years</option>
                {Array.from(new Set(payroll.map(r => r.year))).sort().reverse().map(y => (
                  <option key={y} value={String(y)}>{y}</option>
                ))}
              </select>
              <select value={recordsFilterEmpId} onChange={e => setRecordsFilterEmpId(e.target.value)}
                className="text-[13px] bg-background border border-border/50 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-sm max-w-[200px] truncate">
                <option value="all">All Employees</option>
                {empList.filter(e => e.is_active).map(e => (
                  <option key={e.id} value={e.id}>{dn(e)}</option>
                ))}
              </select>
              <select value={recordsFilterStatus} onChange={e => setRecordsFilterStatus(e.target.value)}
                className="text-[13px] bg-background border border-border/50 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-sm">
                <option value="all">All Status</option>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
              </select>
              {(recordsFilterMonth !== 'all' || recordsFilterYear !== 'all' || recordsFilterEmpId !== 'all' || recordsFilterStatus !== 'all') && (
                <button onClick={() => {
                  setRecordsFilterMonth('all')
                  setRecordsFilterYear('all')
                  setRecordsFilterEmpId('all')
                  setRecordsFilterStatus('all')
                }} className="text-[13px] font-medium text-muted-foreground hover:text-foreground px-3 py-2 rounded-lg hover:bg-secondary/50 transition-all">
                  Clear Filters
                </button>
              )}
            </div>

            {/* Desktop Table View */}
            <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-[13px] min-w-[700px]">
              <thead>
                <tr className="border-b border-border/50 bg-secondary/30">
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Employee</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Period</th>
                  <th className="text-right px-5 py-3.5 font-semibold text-muted-foreground">Base</th>
                  <th className="text-right px-5 py-3.5 font-semibold text-muted-foreground">Commission</th>
                  <th className="text-right px-5 py-3.5 font-semibold text-muted-foreground">Deductions</th>
                  <th className="text-right px-5 py-3.5 font-semibold text-foreground">Net Payable</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Status</th>
                  <th className="w-12 px-5 py-3.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {filteredRecords.length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-12 text-center text-[13px] text-muted-foreground bg-secondary/5">No payroll records match the filters.</td></tr>
                )}
                {filteredRecords.map(record => {
                  const emp = empList.find(e => e.id === record.employee_id)
                  const ded = (record.advances_deducted || 0) + (record.other_deductions || 0)
                  return (
                    <tr key={record.id} className="hover:bg-secondary/20 transition-colors group">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center shrink-0 shadow-sm border border-border/50">
                            <span className="text-white text-[10px] font-bold tracking-wide">{avatarText(dn(emp || record.employee), (emp || record.employee)?.cqid || '')}</span>
                          </div>
                          <div>
                            <p className="font-semibold text-foreground tracking-tight">{dn(emp || record.employee)}</p>
                            <p className="text-[11px] text-muted-foreground">{(emp || record.employee)?.cqid}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{MONTHS[record.month - 1]} {record.year}</td>
                      <td className="px-5 py-3 text-right font-medium">₹{(record.base_salary || 0).toLocaleString('en-IN')}</td>
                      <td className="px-5 py-3 text-right font-medium text-emerald-600 dark:text-emerald-400">+₹{(record.commission_earned || 0).toLocaleString('en-IN')}</td>
                      <td className="px-5 py-3 text-right font-medium text-red-600 dark:text-red-400">{ded > 0 ? `-₹${ded.toLocaleString('en-IN')}` : '—'}</td>
                      <td className="px-5 py-3 text-right font-semibold text-foreground tabular-nums text-[14px]">₹{(record.net_salary || 0).toLocaleString('en-IN')}</td>
                      <td className="px-5 py-3">
                        {record.status === 'paid'
                          ? <div className="flex items-center gap-2">
                              <span className="text-[11px] font-medium px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 whitespace-nowrap">Paid {record.paid_date}</span>
                              <button onClick={() => confirmMarkUnpaid(record.id)} title="Undo payment"
                                className="text-[11px] px-2 py-1 rounded-md text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100">
                                Undo
                              </button>
                            </div>
                          : <button onClick={() => confirmMarkPaid(record.id)} className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 transition-colors whitespace-nowrap">Mark Paid</button>
                        }
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button onClick={() => printSalarySlip(record)} title="Print salary slip"
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors opacity-0 group-hover:opacity-100">
                          <Printer className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>

            {/* Mobile Card View */}
            <div className="lg:hidden flex flex-col p-3 gap-3">
              {filteredRecords.length === 0 && (
                <div className="px-5 py-12 text-center text-[13px] text-muted-foreground bg-secondary/5 rounded-xl border border-border/40">No payroll records match the filters.</div>
              )}
              {filteredRecords.map(record => {
                const emp = empList.find(e => e.id === record.employee_id)
                const ded = (record.advances_deducted || 0) + (record.other_deductions || 0)
                return (
                  <div key={record.id} className="bg-card rounded-xl border border-border/50 p-4 flex flex-col gap-3 shadow-sm">
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center shrink-0 shadow-sm border border-border/50">
                          <span className="text-white text-[10px] font-bold tracking-wide">{avatarText(dn(emp || record.employee), (emp || record.employee)?.cqid || '')}</span>
                        </div>
                        <div>
                          <p className="font-semibold text-sm tracking-tight text-foreground">{dn(emp || record.employee)}</p>
                          <p className="text-[11px] text-muted-foreground">{(emp || record.employee)?.cqid} • {MONTHS[record.month - 1]} {record.year}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => printSalarySlip(record)} title="Print salary slip" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors">
                          <Printer className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="bg-secondary/30 rounded-xl p-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[13px] border border-border/50">
                      <div className="text-muted-foreground">Base Salary</div>
                      <div className="text-right font-medium">₹{(record.base_salary || 0).toLocaleString('en-IN')}</div>
                      
                      <div className="text-muted-foreground">Commission</div>
                      <div className="text-right font-medium text-emerald-600 dark:text-emerald-400">+₹{(record.commission_earned || 0).toLocaleString('en-IN')}</div>
                      
                      <div className="text-muted-foreground">Deductions</div>
                      <div className="text-right font-medium text-red-600 dark:text-red-400">{ded > 0 ? `-₹${ded.toLocaleString('en-IN')}` : '—'}</div>
                      
                      <div className="font-semibold pt-2 mt-1 border-t border-border/60 text-foreground">Net Salary</div>
                      <div className="text-right font-bold pt-2 mt-1 border-t border-border/60 text-foreground tabular-nums">₹{(record.net_salary || 0).toLocaleString('en-IN')}</div>
                    </div>
                    <div className="mt-1 flex justify-end">
                      {record.status === 'paid'
                        ? <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 whitespace-nowrap">Paid {record.paid_date}</span>
                            <button onClick={() => confirmMarkUnpaid(record.id)} title="Undo payment"
                              className="text-[11px] px-3 py-1.5 rounded-lg text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 bg-secondary/30 transition-colors">
                              Undo
                            </button>
                          </div>
                        : <button onClick={() => confirmMarkPaid(record.id)} className="text-[12px] font-medium px-4 py-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 transition-colors">Mark Paid</button>
                      }
                    </div>
                  </div>
                )
              })}
            </div>
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
            <div className="hidden lg:block overflow-auto">
              <table className="w-full text-[13px] border-collapse">
                <thead>
                  <tr className="bg-secondary/30 border-b border-border/50">
                    <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground sticky left-0 bg-secondary/30 min-w-[120px]">Employee</th>
                    {last6Months.map(m => (
                      <th key={`${m.year}-${m.month}`} className={`px-5 py-3.5 text-right font-semibold min-w-[90px] ${m.month === now.getMonth() + 1 && m.year === now.getFullYear() ? 'text-primary' : 'text-muted-foreground'}`}>
                        {m.label}
                      </th>
                    ))}
                    <th className="px-5 py-3.5 text-right font-semibold text-foreground min-w-[90px]">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {empList.filter(e => e.is_active).map(emp => {
                    const monthNets = last6Months.map(m => {
                      const mk = `${m.year}-${String(m.month).padStart(2, '0')}`
                      const rec = payroll.find(r => r.employee_id === emp.id && r.month === m.month && r.year === m.year)
                      const rawComm = Math.round(commissionByEmpMonth[emp.id]?.[mk] || 0)
                      return { 
                        ...m, 
                        net: rec?.net_salary || 0, 
                        status: rec?.status, 
                        commission: rec?.commission_earned ?? rawComm,
                        hasRecord: !!rec
                      }
                    })
                    const totalNet = monthNets.reduce((s, m) => s + m.net, 0)
                    const totalComm = monthNets.reduce((s, m) => s + (!m.hasRecord ? m.commission : 0), 0)
                    const displayTotal = totalNet + totalComm
                    return (
                      <tr key={emp.id} className="hover-gradient-row" onClick={() => setSelectedEmp(emp)}>
                        <td className="px-5 py-3 sticky left-0 bg-transparent align-top z-10 border-r border-border/20 backdrop-blur-md">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center shrink-0 shadow-sm border border-border/50">
                              <span className="text-white text-[10px] font-bold tracking-wide">{avatarText(dn(emp), emp.cqid)}</span>
                            </div>
                            <div>
                              <p className="font-semibold text-foreground tracking-tight">{dn(emp)}</p>
                              <p className="text-[11px] text-muted-foreground">{emp.cqid}</p>
                            </div>
                          </div>
                        </td>
                        {monthNets.map(m => (
                          <td key={`${m.year}-${m.month}`} className="px-5 py-3 text-right tabular-nums">
                            {m.hasRecord ? (
                              <div>
                                <p className={`font-semibold ${m.status === 'paid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                  {formatCompact(m.net)}
                                </p>
                                {m.commission > 0 && (
                                  <p className="text-[10px] text-muted-foreground">+{formatCompact(m.commission)} comm</p>
                                )}
                              </div>
                            ) : m.commission > 0 ? (
                              <div>
                                <p className="font-semibold text-amber-500/80">
                                  {formatCompact(m.commission)}
                                </p>
                                <p className="text-[10px] text-muted-foreground">pending gen</p>
                              </div>
                            ) : (
                              <span className="text-muted-foreground/30">—</span>
                            )}
                          </td>
                        ))}
                        <td className="px-5 py-3 text-right tabular-nums">
                          <p className="font-bold text-foreground text-[14px]">{displayTotal > 0 ? `${formatCompact(displayTotal)}` : '—'}</p>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-secondary/40 border-t border-border">
                    <td className="px-4 py-3 text-xs font-semibold text-muted-foreground sticky left-0 bg-secondary/40">Monthly Total</td>
                    {last6Months.map(m => {
                      const mk = `${m.year}-${String(m.month).padStart(2, '0')}`
                      const total = empList.filter(e => e.is_active).reduce((s, emp) => {
                        const rec = payroll.find(r => r.employee_id === emp.id && r.month === m.month && r.year === m.year)
                        const rawComm = Math.round(commissionByEmpMonth[emp.id]?.[mk] || 0)
                        return s + (rec?.net_salary || rawComm)
                      }, 0)
                      return (
                        <td key={`${m.year}-${m.month}`} className="px-4 py-3 text-right text-xs font-bold">
                          {total > 0 ? <span className="gradient-text">{formatCompact(total)}</span> : <span className="text-muted-foreground/30">—</span>}
                        </td>
                      )
                    })}
                    <td className="px-4 py-3 text-right text-xs font-bold gradient-text">
                      {formatCompact(empList.filter(e => e.is_active).reduce((total, emp) =>
                        total + payroll.filter(r => r.employee_id === emp.id).reduce((s, r) => s + (r.net_salary || 0), 0) + 
                        Object.entries(commissionByEmpMonth[emp.id] || {}).reduce((s, [mk, val]) => {
                          const [y, mm] = mk.split('-')
                          const rec = payroll.find(r => r.employee_id === emp.id && r.year === parseInt(y) && r.month === parseInt(mm))
                          return s + (rec ? 0 : val)
                        }, 0)
                      , 0))}
                    </td>
                  </tr>
                </tfoot>
            </table>
            </div>

            {/* Mobile Card View */}
            <div className="lg:hidden flex flex-col p-3 gap-3">
              {empList.filter(e => e.is_active).map(emp => {
                const monthNets = last6Months.map(m => {
                  const mk = `${m.year}-${String(m.month).padStart(2, '0')}`
                  const rec = payroll.find(r => r.employee_id === emp.id && r.month === m.month && r.year === m.year)
                  const rawComm = Math.round(commissionByEmpMonth[emp.id]?.[mk] || 0)
                  return { 
                    ...m, 
                    net: rec?.net_salary || 0, 
                    status: rec?.status, 
                    commission: rec?.commission_earned ?? rawComm,
                    hasRecord: !!rec
                  }
                })
                const totalNet = monthNets.reduce((s, m) => s + m.net, 0)
                const totalComm = monthNets.reduce((s, m) => s + (!m.hasRecord ? m.commission : 0), 0)
                const displayTotal = totalNet + totalComm
                return (
                  <div key={emp.id} className="bg-card rounded-xl border border-border/50 p-4 shadow-sm cursor-pointer hover:border-primary/30 transition-all flex flex-col gap-3" onClick={() => setSelectedEmp(emp)}>
                    <div className="flex items-center justify-between pb-3 border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl gradient-bg flex items-center justify-center shrink-0 shadow-sm border border-border/50">
                          <span className="text-white text-[11px] font-bold tracking-wide">{avatarText(dn(emp), emp.cqid)}</span>
                        </div>
                        <div>
                          <p className="font-semibold text-[14px] tracking-tight text-foreground">{dn(emp)}</p>
                          <p className="text-[11px] text-muted-foreground">{emp.cqid}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground mb-0.5">6mo Total</p>
                        <p className="text-[14px] font-bold text-foreground tabular-nums">{displayTotal > 0 ? `${formatCompact(displayTotal)}` : '—'}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {monthNets.map(m => (
                        <div key={`${m.year}-${m.month}`} className="bg-secondary/30 border border-border/50 rounded-lg p-2.5 flex justify-between items-center">
                          <span className="text-[11px] font-medium text-muted-foreground">{m.label}</span>
                          <div className="text-right">
                            {m.hasRecord ? (
                              <div>
                                <p className={`text-[13px] font-semibold ${m.status === 'paid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                  {formatCompact(m.net)}
                                </p>
                                {m.commission > 0 && (
                                  <p className="text-[10px] text-muted-foreground">+{formatCompact(m.commission)} comm</p>
                                )}
                              </div>
                            ) : m.commission > 0 ? (
                              <div>
                                <p className="text-[13px] font-semibold text-amber-500/80">
                                  {formatCompact(m.commission)}
                                </p>
                                <p className="text-[10px] text-muted-foreground">pending gen</p>
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground/30">—</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}

              <div className="bg-secondary/20 rounded-xl border border-border/50 p-4 mt-2 shadow-sm">
                <p className="text-[13px] font-semibold text-muted-foreground mb-3">Company Monthly Totals</p>
                <div className="grid grid-cols-2 gap-2">
                  {last6Months.map(m => {
                    const mk = `${m.year}-${String(m.month).padStart(2, '0')}`
                    const total = empList.filter(e => e.is_active).reduce((s, emp) => {
                      const rec = payroll.find(r => r.employee_id === emp.id && r.month === m.month && r.year === m.year)
                      const rawComm = Math.round(commissionByEmpMonth[emp.id]?.[mk] || 0)
                      return s + (rec?.net_salary || rawComm)
                    }, 0)
                    return (
                      <div key={`${m.year}-${m.month}`} className="flex justify-between items-center bg-card rounded-lg p-2.5 border border-border/40 shadow-sm">
                        <span className="text-[11px] font-medium text-muted-foreground">{m.label}</span>
                        {total > 0 ? <span className="text-[13px] font-bold text-foreground tabular-nums">{formatCompact(total)}</span> : <span className="text-[11px] text-muted-foreground/30">—</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
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
              const allTimeBase  = payroll.filter(r => r.employee_id === emp.id).reduce((s, r) => s + (r.base_salary || 0), 0)
              const allTimeComm  = liveScores.filter(s => s.employee_id === emp.id).reduce((s, sc) => s + (sc.earnings_inr || 0), 0)
              const allTimeEarned = allTimeBase + allTimeComm
              const recordCount  = payroll.filter(r => r.employee_id === emp.id).length
              const taskCount    = liveScores.filter(s => s.employee_id === emp.id).length
              const latestRecord = payroll.find(r => r.employee_id === emp.id) // already sorted desc
              const hist         = getEmpHistory(emp.id)
              const trend        = hist.length >= 2 ? hist[hist.length - 1].commission - hist[hist.length - 2].commission : 0

              return (
                  <div key={emp.id}
                    className="group bg-card border border-border/40 rounded-2xl p-5 hover:border-primary/20 hover:shadow-sm transition-all cursor-pointer flex flex-col"
                    onClick={() => setSelectedEmp(emp)}>
                    <div className="flex items-start justify-between mb-5">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center shrink-0 shadow-sm border border-border/50">
                          <span className="text-white font-bold text-sm tracking-wide">{avatarText(dn(emp), emp.cqid)}</span>
                        </div>
                        <div>
                          <p className="font-semibold text-[15px] tracking-tight text-foreground">{dn(emp)}</p>
                          <p className="text-[12px] text-muted-foreground capitalize">{emp.role.replace(/_/g, ' ')}</p>
                          {isUnlocked && emp.email && <p className="text-[12px] text-muted-foreground">{emp.email}</p>}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-md ${emp.is_active ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-gray-500/10 text-gray-500 border border-gray-500/20'}`}>
                          {emp.is_active ? 'Active' : 'Inactive'}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-medium">{emp.performance_rating}% rating</span>
                      </div>
                    </div>

                    {/* Mini stats */}
                    <div className="grid grid-cols-3 gap-2 text-[13px] mb-5">
                      {[
                        { label: 'Base/mo', value: `${formatCompact(emp.base_salary || 0)}` },
                        { label: 'All-time earned', value: `${formatCompact(allTimeEarned)}` },
                        { label: 'Tasks', value: String(taskCount) },
                      ].map(s => (
                        <div key={s.label} className="bg-secondary/30 border border-border/50 rounded-xl p-3 flex flex-col justify-center text-center">
                          <p className="text-[10px] text-muted-foreground uppercase font-medium mb-1">{s.label}</p>
                          <p className="font-semibold text-foreground">{s.value}</p>
                        </div>
                      ))}
                    </div>

                    {/* Trend + last commission */}
                    {recordCount > 0 && (
                      <div className="flex items-center justify-between text-[13px] mb-5 bg-secondary/20 p-3 rounded-xl border border-border/30">
                        <span className="text-muted-foreground">Last commission</span>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-emerald-600 dark:text-emerald-400">+₹{(latestRecord?.commission_earned || 0).toLocaleString('en-IN')}</span>
                          {trend !== 0 && (
                            trend > 0
                              ? <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-md"><TrendingUp className="w-3 h-3" />+₹{Math.abs(trend).toLocaleString('en-IN')}</span>
                              : <span className="flex items-center gap-0.5 text-red-600 dark:text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded-md"><TrendingDown className="w-3 h-3" />-₹{Math.abs(trend).toLocaleString('en-IN')}</span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between mt-auto">
                      <button onClick={e => { e.stopPropagation(); toggleReveal(emp.id, emp.reveal_salary) }}
                        className={`flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors border shadow-sm ${emp.reveal_salary ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20' : 'bg-secondary text-muted-foreground hover:text-foreground border-border/50'}`}>
                        {emp.reveal_salary ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                        {emp.reveal_salary ? 'Salary visible' : 'Salary hidden'}
                      </button>
                      <span className="text-[11px] font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">Full profile →</span>
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
          <div className="bg-card border border-border rounded-xl">
            <div className="overflow-x-auto">
            <table className="w-full text-[13px] min-w-[500px]">
              <thead>
                <tr className="border-b border-border/50 bg-secondary/30">
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Employee</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Date</th>
                  <th className="text-right px-5 py-3.5 font-semibold text-muted-foreground">Amount</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Reason</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {advList.length === 0 && <tr><td colSpan={5} className="px-5 py-12 text-center text-[13px] text-muted-foreground bg-secondary/5">No advances</td></tr>}
                {advList.map((adv: any) => (
                  <tr key={adv.id} className="hover:bg-secondary/20 transition-colors">
                    <td className="px-5 py-3.5 font-medium text-foreground">{adv.employee?.cqid}</td>
                    <td className="px-5 py-3.5 text-muted-foreground">{adv.advance_date}</td>
                    <td className="px-5 py-3.5 text-right font-semibold text-foreground tabular-nums">₹{(adv.amount || 0).toLocaleString('en-IN')}</td>
                    <td className="px-5 py-3.5 text-muted-foreground">{adv.reason || '—'}</td>
                    <td className="px-5 py-3.5">
                      <span className={`text-[11px] font-medium px-2.5 py-1 rounded-md border ${adv.status === 'repaid' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'}`}>
                        {adv.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════
            CREDITS TAB
        ════════════════════════════════════════════════════ */}
        {tab === 'Credits' && (
          <div className="bg-card border border-border rounded-xl">
            <div className="overflow-x-auto">
            <table className="w-full text-[13px] min-w-[500px]">
              <thead>
                <tr className="border-b border-border/50 bg-secondary/30">
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Entity</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Date</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Type</th>
                  <th className="text-right px-5 py-3.5 font-semibold text-muted-foreground">Amount</th>
                  <th className="text-left px-5 py-3.5 font-semibold text-muted-foreground">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {creditList.length === 0 && <tr><td colSpan={5} className="px-5 py-12 text-center text-[13px] text-muted-foreground bg-secondary/5">No credit entries</td></tr>}
                {creditList.map((cr: any) => (
                  <tr key={cr.id} className="hover:bg-secondary/20 transition-colors">
                    <td className="px-5 py-3.5 font-medium text-foreground">{cr.employee?.cqid || cr.entity_type}</td>
                    <td className="px-5 py-3.5 text-muted-foreground">{cr.credit_date}</td>
                    <td className="px-5 py-3.5">
                      <span className={`text-[11px] font-medium px-2.5 py-1 rounded-md border ${cr.credit_type === 'given' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'}`}>
                        {cr.credit_type}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-foreground tabular-nums">₹{(cr.amount || 0).toLocaleString('en-IN')}</td>
                    <td className="px-5 py-3.5 text-muted-foreground">{cr.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
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
            <div className="bg-secondary border border-foreground/15 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">

              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-foreground/15 sticky top-0 bg-secondary z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center shrink-0">
                    <span className="text-white font-bold text-sm tracking-wide">{avatarText(dn(emp), emp.cqid)}</span>
                  </div>
                  <div>
                    <h2 className="font-semibold">{dn(emp)}</h2>
                    <p className="text-xs text-muted-foreground capitalize">
                      {emp.role.replace(/_/g, ' ')} · ₹{(emp.base_salary || 0).toLocaleString('en-IN')}/mo · {emp.performance_rating}% rating
                    </p>
                  </div>
                </div>
                <button onClick={() => { setSelectedEmp(null); setSelectedDay(null) }} className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-foreground/5">
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
                    <div key={item.label} className="bg-foreground/[0.03] border border-foreground/[0.06] rounded-xl p-3">
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
                    <PayrollHistoryBar data={history} />
                  </div>
                  <div className="flex gap-4 mt-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-500/80" />Base</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-green-500/80" />Commission</span>
                  </div>
                </div>

                {/* Attendance calendar.

                    The month stepper drives the WHOLE modal (and the page
                    behind it), not just this grid — one month concept, so the
                    commission card can never disagree with the task list
                    below it. */}
                <div>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-3 flex items-center gap-2 flex-wrap">
                    <Calendar className="w-3.5 h-3.5" />
                    Attendance — {MONTHS[viewMonth - 1]} {viewYear}
                    <span className="text-[11px] normal-case font-normal text-muted-foreground/60">
                      {workedDays.size} of {daysInMon} days with contributions
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <button onClick={() => navigateMonth(-1)} aria-label="Previous month"
                        className="p-1 rounded-md border border-foreground/10 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors">
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => navigateMonth(1)} aria-label="Next month"
                        className="p-1 rounded-md border border-foreground/10 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors">
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: daysInMon }, (_, i) => {
                      const d       = i + 1
                      const dateStr = `${viewYear}-${String(viewMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`
                      const worked  = workedDays.has(dateStr)
                      const isToday = dateStr === todayISO(now)
                      const isOpen  = selectedDay === dateStr
                      // Only a day with work is worth opening; the rest stay
                      // inert rather than offering an empty panel.
                      return (
                        <button key={d} type="button"
                          disabled={!worked}
                          onClick={() => setSelectedDay(isOpen ? null : dateStr)}
                          title={worked ? `${d} ${MONTHS[viewMonth - 1]} — see what was done` : `${d} ${MONTHS[viewMonth - 1]}`}
                          className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-medium border transition-all
                            ${isOpen   ? 'bg-green-500/40 text-green-100 border-green-400 ring-2 ring-green-400/40' :
                              worked   ? 'bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/30 hover:bg-green-500/30 cursor-pointer' :
                              isToday  ? 'bg-blue-500/15 text-blue-400 border-blue-500/20 cursor-default' :
                                         'bg-foreground/[0.02] text-muted-foreground/30 border-foreground/[0.04] cursor-default'}`}>
                          {d}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex gap-5 mt-2.5">
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-green-500/20 border border-green-500/30" /> Has contributions — click to open</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-foreground/[0.02] border border-foreground/[0.04]" /> No data</span>
                  </div>

                  {/* One day's work, in full. */}
                  {selectedDay && (() => {
                    const dayTasks = empTasks.filter(t => t.task_date === selectedDay)
                    const dayEarned = dayTasks.reduce((sum, t) => sum + (t.score.earnings_inr ?? 0), 0)
                    const [, , dd] = selectedDay.split('-')
                    return (
                      <div className="mt-3 rounded-xl border border-green-500/25 bg-green-500/[0.04] p-3">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <p className="text-xs font-semibold">
                            {Number(dd)} {MONTHS[viewMonth - 1]} {viewYear}
                          </p>
                          <span className="text-[11px] text-muted-foreground">
                            {dayTasks.length} task{dayTasks.length === 1 ? '' : 's'}
                          </span>
                          {showAmounts && dayEarned > 0 && (
                            <span className="ml-auto text-[11px] text-green-400 font-semibold tabular-nums">
                              ₹{Math.round(dayEarned).toLocaleString('en-IN')}
                            </span>
                          )}
                          <button onClick={() => setSelectedDay(null)}
                            className="text-muted-foreground hover:text-foreground p-0.5 rounded">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                        {dayTasks.length === 0 ? (
                          // A contribution dated by calculated_at rather than by
                          // the task's own date lands here — say so plainly.
                          <p className="text-[11px] text-muted-foreground">
                            Contributions were recorded on this day, but their tasks are dated differently.
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            {dayTasks.map(t => (
                              <div key={t.id} className="flex items-start gap-2.5">
                                <div className="w-1 h-1 rounded-full bg-green-400 shrink-0 mt-1.5" />
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs truncate">{t.title}</p>
                                  <p className="text-[10px] text-muted-foreground truncate">
                                    {t.client?.name}
                                    {t.service?.name && <> · {t.service.name}</>}
                                    {t.score.score_percentage != null && <> · {t.score.score_percentage}% share</>}
                                  </p>
                                </div>
                                {showAmounts && t.score.earnings_inr != null && (
                                  <span className="text-[11px] text-green-400 font-medium tabular-nums shrink-0">
                                    ₹{Math.round(t.score.earnings_inr).toLocaleString('en-IN')}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>

                {/* Tasks this month — with what each one actually earned.
                    The commission card above is a single number; this is the
                    line-by-line evidence behind it, which is what a pay query
                    ("why is my commission this?") actually needs. */}
                {empTasks.length > 0 && (() => {
                  const taskEarned = empTasks.reduce((sum, t) => sum + (t.score.earnings_inr ?? 0), 0)
                  // Earnings can exist without a matching task row (a task
                  // outside the fetch window). Say so rather than letting the
                  // list silently disagree with the commission card.
                  const unlisted = Math.round(commission - taskEarned)
                  return (
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-3 flex items-center gap-1.5 flex-wrap">
                      <FileText className="w-3.5 h-3.5" /> Task earnings — {MONTHS[viewMonth - 1]}
                      <span className="text-[11px] normal-case font-normal ml-1">{empTasks.length} tasks</span>
                      {showAmounts && (
                        <span className="ml-auto text-[11px] normal-case font-normal">
                          <span className="text-muted-foreground">from tasks </span>
                          <span className="text-green-400 font-semibold tabular-nums">₹{Math.round(taskEarned).toLocaleString('en-IN')}</span>
                        </span>
                      )}
                    </h3>

                    <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                      {empTasks.map(t => {
                        const earned = t.score.earnings_inr
                        const share  = t.score.score_percentage
                        const value  = t.billing_amount_inr
                        return (
                        <div key={t.id} className="flex items-start gap-3 bg-foreground/[0.02] border border-foreground/[0.05] rounded-lg px-3 py-2">
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${
                            t.status === 'paid'      ? 'bg-green-400'  :
                            t.status === 'invoiced'  ? 'bg-blue-400'   :
                            t.status === 'delivered' ? 'bg-purple-400' : 'bg-amber-400'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{t.title}</p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {t.client?.name}
                              {t.service?.name && <> · {t.service.name}</>}
                              {' · '}{t.task_date}
                            </p>
                            {/* How the money was derived. Each part is shown
                                only when the viewer is allowed to see it, so a
                                partial permission set degrades to fewer facts
                                rather than to a misleading figure. */}
                            {(value != null || share != null) && (
                              <p className="text-[10px] text-muted-foreground/80 mt-0.5 tabular-nums">
                                {value != null && <>Task ₹{Math.round(value).toLocaleString('en-IN')}</>}
                                {value != null && share != null && ' · '}
                                {share != null && <>{share}% share</>}
                                {t.score.is_manual_override && (
                                  <span className="ml-1.5 text-amber-400">manual override</span>
                                )}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            {showAmounts && earned != null && (
                              <p className="text-xs font-semibold text-green-400 tabular-nums">
                                ₹{Math.round(earned).toLocaleString('en-IN')}
                              </p>
                            )}
                            <span className={`inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                              t.status === 'paid'     ? 'bg-green-500/15 text-green-400' :
                              t.status === 'invoiced' ? 'bg-blue-500/15 text-blue-400'  : 'bg-secondary text-muted-foreground'
                            }`}>{t.status}</span>
                          </div>
                        </div>
                        )
                      })}
                    </div>

                    {showAmounts && Math.abs(unlisted) >= 1 && (
                      <p className="text-[10px] text-muted-foreground mt-2">
                        {unlisted > 0
                          ? `₹${unlisted.toLocaleString('en-IN')} of this month's commission comes from earnings whose task isn't listed above (older than the task window, or deleted).`
                          : `The listed tasks total ₹${Math.abs(unlisted).toLocaleString('en-IN')} more than the commission card — recalculate payroll to resync.`}
                      </p>
                    )}
                  </div>
                  )
                })()}

                {/* Activity timeline */}
                <div className="bg-foreground/[0.02] border border-foreground/[0.06] rounded-xl p-4">
                  <EmployeeActivityTimeline employeeId={emp.id} />
                </div>

                {/* Footer actions */}
                <div className="flex gap-2 pt-2 border-t border-foreground/15">
                  {record ? (
                    <>
                      <button onClick={() => printSalarySlip(record)}
                        className="flex items-center gap-1.5 bg-foreground/[0.04] hover:bg-foreground/[0.07] border border-foreground/15 text-sm px-4 py-2 rounded-lg transition-colors">
                        <Printer className="w-3.5 h-3.5" /> Print Slip
                      </button>
                      {record.status !== 'paid' && (
                        <>
                          {payrollOutOfSync(record) && (
                            <button onClick={() => handleRefreshPayroll(record.id)} disabled={refreshingId === record.id}
                              className="flex items-center gap-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-500 text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
                              <RefreshCw className={`w-3.5 h-3.5 ${refreshingId === record.id ? 'animate-spin' : ''}`} /> 
                              {refreshingId === record.id ? 'Refreshing...' : 'Refresh Payroll'}
                            </button>
                          )}
                          <button onClick={() => { setSelectedEmp(null); confirmMarkPaid(record.id) }}
                            className="flex items-center gap-1.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                            <CheckCircle className="w-3.5 h-3.5" /> Mark Paid
                          </button>
                        </>
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
        <ModalOverlay onClose={() => setGeneratePreview(null)} sheetOnMobile>
          <div className="bg-secondary border border-foreground/15 rounded-t-2xl sm:rounded-2xl w-full max-w-xl shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-foreground/15">
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
              {/* Generate-payroll preview — 5 numeric columns in a
                  sheetOnMobile modal with no prior overflow containment;
                  wrapped so any overflow scrolls within the table instead of
                  the whole confirm sheet. */}
              <div className="overflow-x-auto">
              <table className="w-full text-sm mb-4 min-w-[440px]">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-foreground/15">
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
                  <tr className="border-t-2 border-foreground/20">
                    <td className="pt-3 text-xs font-semibold">Total</td>
                    <td className="pt-3 text-right text-xs text-muted-foreground">₹{generatePreview.reduce((s, p) => s + p.base_salary, 0).toLocaleString('en-IN')}</td>
                    <td className="pt-3 text-right text-xs text-green-400">+₹{generatePreview.reduce((s, p) => s + p.commission_earned, 0).toLocaleString('en-IN')}</td>
                    <td className="pt-3 text-right text-xs text-red-400">-₹{generatePreview.reduce((s, p) => s + p.advances_deducted, 0).toLocaleString('en-IN')}</td>
                    <td className="pt-3 text-right text-sm font-bold">₹{generatePreview.reduce((s, p) => s + p.net_salary, 0).toLocaleString('en-IN')}</td>
                  </tr>
                </tfoot>
              </table>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Commission from contribution scores · Advances auto-deducted from pending salary advances · All records created as <span className="text-amber-400">Pending</span>
              </p>
              <div className="flex gap-2">
                <button onClick={() => setGeneratePreview(null)}
                  className="flex-1 py-2.5 rounded-xl border border-foreground/15 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors">
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
        <ModalOverlay onClose={() => setShowPayrollForm(false)} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl max-h-[90dvh] overflow-y-auto">
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
                  {/* eslint-disable-next-line no-restricted-syntax -- unlock-gated: the name renders only when `isUnlocked`, which is the sanctioned reveal path. */}
                  {empList.filter(e => e.is_active).map(e => <option key={e.id} value={e.id}>{e.cqid}{isUnlocked && e.name ? ` — ${e.name}` : ''}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
        <ModalOverlay onClose={() => setShowAdvanceForm(false)} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-sm shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="font-semibold">Salary Advance</h2>
              <button onClick={() => setShowAdvanceForm(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={saveAdvance} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Employee *</label>
                <select value={advForm.employee_id} onChange={e => setAdvForm(p => ({ ...p, employee_id: e.target.value }))} required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
                  <option value="">Select</option>
                  {/* eslint-disable-next-line no-restricted-syntax -- unlock-gated: the name renders only when `isUnlocked`, which is the sanctioned reveal path. */}
                  {empList.filter(e => e.is_active).map(e => <option key={e.id} value={e.id}>{e.cqid}{isUnlocked && e.name ? ` — ${e.name}` : ''}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
        <ModalOverlay onClose={() => setShowCreditForm(false)} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-sm shadow-2xl max-h-[90dvh] overflow-y-auto">
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
                  {/* eslint-disable-next-line no-restricted-syntax -- unlock-gated: the name renders only when `isUnlocked`, which is the sanctioned reveal path. */}
                  {empList.map(e => <option key={e.id} value={e.id}>{e.cqid}{isUnlocked && e.name ? ` — ${e.name}` : ''}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
          <div className="relative bg-secondary border border-foreground/15 rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <h3 className="font-semibold text-sm mb-2">{confirmModal.title}</h3>
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed whitespace-pre-line">{confirmModal.body}</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-foreground/15 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors">
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

      {/* ════════════════════════════════════════════════════
          BULK GENERATE MODAL
      ════════════════════════════════════════════════════ */}
      {showBulkGenerate && (
        <BulkGenerateModal
          employees={empList}
          existingPayroll={payroll.map(p => ({ employee_id: p.employee_id, month: p.month, year: p.year }))}
          contributionScores={liveScores}
          allTasks={allTasks}
          onClose={() => setShowBulkGenerate(false)}
          onGenerated={newRecords => {
            setPayroll(prev => [...newRecords, ...prev])
            setShowBulkGenerate(false)
          }}
        />
      )}
      {/* ════════════════════════════════════════════════════
          PAYSLIP PREVIEW / SEND MODAL
      ════════════════════════════════════════════════════ */}
      {payslipModal && (
        <PayslipModal
          employeeId={payslipModal.employeeId}
          month={viewMonth}
          year={viewYear}
          monthLabel={`${MONTHS[viewMonth - 1]} ${viewYear}`}
          onClose={() => setPayslipModal(null)}
          onSent={to => toastSuccess('Payslip sent', `Emailed to ${to}`)}
        />
      )}

      {/* ════════════════════════════════════════════════════
          BULK PAYSLIP CONFIRM
      ════════════════════════════════════════════════════ */}
      {bulkPayslipConfirm && (
        <ModalOverlay onClose={() => setBulkPayslipConfirm(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Mail className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold">Send all payslips?</p>
                <p className="text-sm text-muted-foreground">
                  Emails a branded payslip (with PDF) to all {monthStats.paidCount} paid employee{monthStats.paidCount !== 1 ? 's' : ''} for {MONTHS[viewMonth - 1]} {viewYear}.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setBulkPayslipConfirm(false)} disabled={bulkSending}
                className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button onClick={handleBulkPayslips} disabled={bulkSending}
                className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
                {bulkSending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : <>Send all</>}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
