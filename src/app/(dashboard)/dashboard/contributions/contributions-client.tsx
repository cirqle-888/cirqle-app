'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { recalculatePayrollForMonth } from '@/app/(dashboard)/dashboard/payroll/actions'
import { serverFillTaskBilling } from '@/app/(dashboard)/dashboard/tasks/actions'
import { saveTaskContributions } from './actions'
import { closedPeriodNotice } from '@/lib/payroll/correction-notice'
import { calculateCommission } from '@/lib/calculations/commission'
import { getEffectivePerformanceRating } from '@/lib/calculations/performance-history'
import { taskCode, taskCodeMatches, nextTaskNumber } from '@/lib/utils/task-code'
import { usePrivacy } from '@/contexts/privacy-context'
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { DateFilter, matchesDateFilter, getDateFilterLabel } from '@/components/ui/date-filter'
import { ActiveFilterChips } from '@/components/ui/active-filter-chips'
import { TokenizedSearch, type SearchFacet, type FacetOp } from '@/components/ui/tokenized-search'
import { cn, ROW_INTERACTIVE_CLASS, BRANDED_PILL_BASE_CLASS, BRANDED_PILL_SELECTED_CLASS, BRANDED_PILL_ACTIVE_CLASS } from '@/lib/utils'
import type { DateFilterValue } from '@/components/ui/date-filter'
import {
  ChevronLeft, ChevronRight, Minus, Plus, X, Check,
  Search, Filter, PlusCircle, Eye, EyeOff, Clock, CheckCircle2, AlertCircle,
  UserCheck, Users, CalendarDays, Lock, Edit2, ChevronDown, Trash2, Copy, ExternalLink,
  List, LayoutGrid, MoreVertical, CheckCircle, PlusIcon, FileDownIcon,
} from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import AppSelect from '@/components/ui/app-select'
import Combobox from '@/components/ui/combobox'
import { TitleAutocomplete } from '@/components/tasks/title-autocomplete'
import { normalizeTaskTitle } from '@/lib/utils/title-case'

const QuickCreateClientModal = dynamic(() => import('@/components/tasks/quick-create-modals').then(mod => mod.QuickCreateClientModal), { ssr: false })
const QuickCreateServiceModal = dynamic(() => import('@/components/tasks/quick-create-modals').then(mod => mod.QuickCreateServiceModal), { ssr: false })
import { usePermissions } from '@/contexts/permission-context'
import { useRole } from '@/contexts/role-context'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { formatDate } from '@/lib/utils/format-date'
const ActivityPanel = dynamic(() => import('@/components/activity/activity-panel'), { ssr: false })
// Matches the loading strategy the task modal already uses for this button.
const DiscussButton = dynamic(() => import('@/components/chat/discuss-button').then(m => m.DiscussButton), { ssr: false })
import { PageShell, PageContent, StickyToolbar, PageChrome } from '@/components/layout/page-shell'
import { todayISO, toISODate } from '@/lib/utils/local-date'

// Heavy task editor — only mount when opened; bundle splits off the
// contributions route chunk.
const TaskEditModal = dynamic(
  () => import('@/components/ui/task-edit-modal').then(m => m.TaskEditModal),
  { ssr: false },
)

interface Score { task_id: string; employee_id: string; earnings_inr?: number; score_percentage: number; calculated_at?: string }
interface Assignment { task_id: string; employee_id: string }

interface VisibilitySettings {
  billing: string
  contributions: string
  employee_names: string
}

interface Props {
  tasks: any[]
  employees: any[]
  groups: any[]
  parameters: any[]
  tools: any[]
  parameterServices: { parameter_id: string; service_id: string }[]
  toolServices: { tool_id: string; service_id: string }[]
  groupServices: { group_id: string; service_id: string }[]
  /** employee ↔ service assignments — scopes the scoring UI to each task's service team */
  employeeServices?: { employee_id: string; service_id: string }[]
  scores: Score[]
  clients: { id: string; name: string; code?: string }[]
  services: { id: string; name: string }[]
  taskAssignments: Assignment[]
  contributorRecords: { task_id: string; employee_id: string; parameter_id?: string; value: number }[]
  taskToolRecords: { task_id: string; tool_id: string }[]
  pricingMatrix: { client_id: string; service_id: string; commission_percentage: number | null; price: number | null; currency: string | null }[]
  performanceHistory: any[]
  visibilitySettings?: VisibilitySettings
  /**
   * Per-field financial visibility from the server. earnings = user holds
   * `contributions.view_earnings`; pricing = user holds `tasks.view_pricing`.
   * When false, the corresponding ₹ fields are absent from `scores` and
   * `tasks` props (stripped server-side) — the client only uses these flags
   * to suppress UI cells/columns that would otherwise render '—'.
   */
  permissionFlags: {
    earnings: boolean
    pricing:  boolean
    /** true = admin/view_all; false = employee sees only their own contributions */
    viewAll?: boolean
    /** true = may see the per-task activity log + post log notes */
    viewActivity?: boolean
  }
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────
function fmt(date: string) {
  try {
    return new Date(date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return date }
}

/** Apply an operator to a string field value. */
function cmpText(val: string | null | undefined, op: FacetOp, text: string): boolean {
  const v = (val || '').toLowerCase()
  const q = text.toLowerCase()
  return op === 'is' ? v === q : v.includes(q)
}
/** Apply an operator to a numeric field value. */
function cmpNum(val: number | null | undefined, op: FacetOp, text: string): boolean {
  const n = Number(val ?? 0)
  const m = Number(text)
  if (!Number.isFinite(m)) return true            // non-numeric query → don't exclude
  switch (op) {
    case '>':  return n > m
    case '<':  return n < m
    case '>=': return n >= m
    case '<=': return n <= m
    case '!=': return n !== m
    default:   return n === m                      // '=' and text ops fall back to equality
  }
}
/** Does a single search facet match a task? Field-aware + operator-aware. */
function facetMatchesTask(t: any, f: SearchFacet): boolean {
  const op = f.op || 'contains'
  switch (f.field) {
    case 'client':  return cmpText(t.client?.name, op, f.text)
    case 'service': return cmpText(t.service?.name, op, f.text)
    case 'title':   return cmpText(t.title, op, f.text)
    case 'task':    return cmpNum(t.task_number, op, f.text)
    case 'amount':  return cmpNum(t.billing_amount_inr, op, f.text)
    case 'any':
    default:
      // Generic: any of title / client / service / code contains the text.
      return cmpText(t.title, 'contains', f.text)
        || cmpText(t.client?.name, 'contains', f.text)
        || cmpText(t.service?.name, 'contains', f.text)
        || taskCodeMatches(t, f.text)
  }
}

function StatusBadge({ done, total }: { done: number; total: number }) {
  if (total === 0) return null
  if (done === 0) return (
    <span className="flex items-center gap-1 text-[11px] text-amber-400 font-medium">
      <AlertCircle className="w-3.5 h-3.5" /> Pending
    </span>
  )
  if (done >= total) return (
    <span className="flex items-center gap-1 text-[11px] text-green-400 font-medium">
      <CheckCircle2 className="w-3.5 h-3.5" /> Done
    </span>
  )
  return (
    <span className="flex items-center gap-1 text-[11px] text-blue-400 font-medium">
      <Clock className="w-3.5 h-3.5" /> Partial
    </span>
  )
}

// ─────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────
export default function ContributionsClient({
  tasks: initialTasks, employees, groups, parameters, tools,
  parameterServices, toolServices, groupServices: groupServicesFromDB,
  employeeServices = [],
  scores, clients, services, taskAssignments: taskAssignmentsFromDB,
  contributorRecords, taskToolRecords, pricingMatrix,
  performanceHistory, visibilitySettings,
  permissionFlags,
}: Props) {

  // ── Toast ───────────────────────────────────────────
  const toast = useToast()
  const { can } = usePermissions()

  // Inline quick-create (client / service) from the Add Task dropdowns — same as
  // the Tasks page. Local lists so newly added ones appear immediately.
  const [clientList, setClientList] = useState(clients)
  const [serviceList, setServiceList] = useState(services)
  const [quickCreate, setQuickCreate] = useState<{ kind: 'client' | 'service'; query: string } | null>(null)
  const canCreateClient  = can('clients.create')
  const canCreateService = can('services.create')

  // ── View state ──────────────────────────────────────
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [view, setView] = useState<'list' | 'entry'>('list')
  const [selectedTask, setSelectedTask] = useState<any>(null)

  // ── List screen view mode (list / board / calendar) ──
  const [listViewMode, setListViewMode] = useState<'list' | 'board' | 'calendar'>((searchParams.get('view') as any) || 'list')
  const [calViewYear, setCalViewYear] = useState(() => new Date().getFullYear())
  const [calViewMonth, setCalViewMonth] = useState(() => new Date().getMonth())

  // ── Local tasks (mutable — newly created tasks appear immediately) ──
  const [localTasks, setLocalTasks] = useState(initialTasks)

  // ── Add Task modal state ──────────────────────────────
  const [showAddTask, setShowAddTask] = useState(false)
  const [addTaskForm, setAddTaskForm] = useState({
    title: '',
    client_id: '',
    service_id: '',
    task_date: todayISO(),
    billing_amount_inr: '',
    status: 'pending',
  })
  const [addingTask, setAddingTask] = useState(false)
  const [addTaskError, setAddTaskError] = useState('')
  const [duplicatingTaskId, setDuplicatingTaskId] = useState<string | null>(null)

  // ── Filters ─────────────────────────────────────────
  // Odoo-style tokenized search: field-scoped facet pills + the live draft.
  // Convention: same field OR (Client: a OR Client: b); generic text AND
  // (narrows); across fields AND. The trimmed draft is a generic facet so
  // typing still filters live before it's committed.
  const [searchFacets, setSearchFacets] = useState<SearchFacet[]>(() => {
    try { const raw = searchParams.get('sf'); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [searchDraft, setSearchDraft] = useState('')
  const activeFacets = useMemo<SearchFacet[]>(
    () => searchDraft.trim() ? [...searchFacets, { field: 'any', op: 'contains', text: searchDraft.trim() }] : searchFacets,
    [searchFacets, searchDraft],
  )
  const hasSearch = activeFacets.length > 0
  // Client & Service are multi-value (stack several, OR within the category).
  const [filterClients, setFilterClients] = useState<string[]>(() => (searchParams.get('client') || '').split(',').filter(Boolean))
  const [filterServices, setFilterServices] = useState<string[]>(() => (searchParams.get('service') || '').split(',').filter(Boolean))
  const [filterEmployee, setFilterEmployee] = useState(searchParams.get('employee') || '')
  // Toggle helpers for the multi-select dropdowns.
  const toggleClient  = (id: string) => setFilterClients(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const toggleService = (id: string) => setFilterServices(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const [filterEmployeeMode, setFilterEmployeeMode] = useState<'worked' | 'solo' | 'any' | 'without'>((searchParams.get('empmode') as any) || 'worked')
  // "My Tasks" / "Not Assigned to Me" quick toggle — independent of the Employee
  // dropdown (which picks any single teammate). Available to anyone with an
  // employee record, not just role==='employee' — admins can contribute too.
  const [myScope, setMyScope] = useState<'mine' | 'not_mine' | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'done' | 'missing'>((searchParams.get('status') as any) || 'all')
  const [sortBy, setSortBy] = useState<'today_first' | 'date_desc' | 'date_asc' | 'amount_desc' | 'client'>((searchParams.get('sort') as any) || 'today_first')
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [mobileLimit, setMobileLimit] = useState(100)
  const [filterDate, setFilterDate] = useState<DateFilterValue>(() => {
    const d = searchParams.get('date')
    try { return d ? JSON.parse(d) : null } catch { return null }
  })

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    
    if (listViewMode && listViewMode !== 'list') params.set('view', listViewMode); else params.delete('view')
    if (searchFacets.length) params.set('sf', JSON.stringify(searchFacets)); else params.delete('sf')
    if (filterClients.length) params.set('client', filterClients.join(',')); else params.delete('client')
    if (filterServices.length) params.set('service', filterServices.join(',')); else params.delete('service')
    if (filterEmployee) params.set('employee', filterEmployee); else params.delete('employee')
    if (filterEmployeeMode && filterEmployeeMode !== 'worked') params.set('empmode', filterEmployeeMode); else params.delete('empmode')
    if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter); else params.delete('status')
    if (sortBy && sortBy !== 'today_first') params.set('sort', sortBy); else params.delete('sort')
    if (filterDate) params.set('date', JSON.stringify(filterDate)); else params.delete('date')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [listViewMode, searchFacets, filterClients, filterServices, filterEmployee, filterEmployeeMode, statusFilter, sortBy, filterDate, pathname, router, searchParams])
  const autoRecalcRan = useRef(false)

  // ── Financial visibility ─────────────────────────────
  // Default OFF — initial render is the privacy-respecting employee view.
  // Admins can flip to financials mode via the eye toggle in the header.
  const [showFinancials, setShowFinancials] = useState(false)

  // ── Entry-view state ─────────────────────────────────
  const [contributions, setContributions] = useState<Record<string, Record<string, number>>>({})
  const [toolsUsed, setToolsUsed] = useState<Record<string, boolean>>({})
  const [serviceCommPct, setServiceCommPct] = useState(50)
  const [predefinedCommPct, setPredefinedCommPct] = useState<number | null>(null) // from pricing matrix
  const [commOverrideReason, setCommOverrideReason] = useState('')
  const [importedScores, setImportedScores] = useState<any[]>([])
  const [showCommOverride, setShowCommOverride] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expandedEmployees, setExpandedEmployees] = useState<Set<string>>(new Set())
  const [activeGroups, setActiveGroups] = useState<Set<string>>(new Set())
  const [activeSubParams, setActiveSubParams] = useState<Set<string>>(new Set())
  // Per emp+group: whether the "less-used parameters" section is expanded
  const [expandedSubGroups, setExpandedSubGroups] = useState<Set<string>>(new Set())

  // ── Auto-save draft ──────────────────────────────────
  const [draftSaved, setDraftSaved] = useState(false)
  const draftKey = (taskId: string) => `cirqle_draft_${taskId}`

  // ── Task edit modal state ────────────────────────────
  const [editingTask, setEditingTask] = useState<any>(null)

  // ── Highlight task from ?highlight= URL param ────────
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('highlight')
    if (!id) return
    setHighlightedTaskId(id)
    setTimeout(() => {
      const el = document.querySelector(`[data-taskid="${id}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 300)
    setTimeout(() => setHighlightedTaskId(null), 2500)
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  const supabase = createClient()
  const { dn, isUnlocked, openUnlockModal } = usePrivacy()
  const { role, employee: currentEmployee } = useRole()

  // ── Visibility helpers ────────────────────────────────
  function canSee(setting: string | undefined): boolean {
    if (!setting || setting === 'all') return true
    if (setting === 'admin_only') return role === 'super_admin' || role === 'accounts'
    if (setting === 'team_lead') return role === 'super_admin' || role === 'accounts' || role === 'team_lead'
    return true
  }
  const showBilling      = canSee(visibilitySettings?.billing)
  const showContribs     = canSee(visibilitySettings?.contributions)
  const showEmpNames     = canSee(visibilitySettings?.employee_names)

  // ── Bulk-selection state ──────────────────────────────
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())
  const [bulkMode, setBulkMode] = useState(false)

  // ── Board view: Group By + Date granularity + settings popover ──
  const [boardGroupBy, setBoardGroupBy] = useState<'employee' | 'client' | 'service' | 'status' | 'date'>('status')
  const [boardDateGranularity, setBoardDateGranularity] = useState<'preset' | 'daily' | 'weekly' | 'monthly'>('preset')
  const [showBoardSettings, setShowBoardSettings] = useState(false)
  const boardSettingsRef = useRef<HTMLDivElement>(null)

  // ── Missing-scores toast visibility ───────────────────
  const [showMissingBanner, setShowMissingBanner] = useState(true)
  useEffect(() => {
    function h(e: MouseEvent) {
      const target = e.target as Element | null
      // Skip closing if click landed inside a portaled FilterDropdown / DateFilter panel
      if (target && typeof target.closest === 'function' && target.closest('[data-filter-dropdown-panel="true"]')) return
      if (boardSettingsRef.current && !boardSettingsRef.current.contains(e.target as Node)) setShowBoardSettings(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const rawContribTaskIds = useMemo(() => new Set(contributorRecords.map(c => c.task_id)), [contributorRecords])

  // ── Auto-save draft to localStorage ──────────────────
  useEffect(() => {
    if (view !== 'entry' || !selectedTask) return
    const hasData = Object.values(contributions).some(m => Object.values(m).some(v => v > 0))
      || Object.values(toolsUsed).some(Boolean)
    if (!hasData) return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey(selectedTask.id), JSON.stringify({ contributions, toolsUsed, serviceCommPct }))
        setDraftSaved(true)
        setTimeout(() => setDraftSaved(false), 2000)
      } catch { /* ignore quota errors */ }
    }, 1500) // 1.5s debounce
    return () => clearTimeout(timer)
  }, [contributions, toolsUsed, serviceCommPct, selectedTask, view])

  // ── Assignment state (with localStorage fallback) ─────
  const [assignments, setAssignments] = useState<Assignment[]>([])

  useEffect(() => {
    if (taskAssignmentsFromDB.length > 0) {
      setAssignments(taskAssignmentsFromDB)
    } else {
      try {
        const saved = JSON.parse(localStorage.getItem('cirqle_task_assignments') || '[]')
        setAssignments(saved)
      } catch { /* ignore */ }
    }
  }, [taskAssignmentsFromDB])

  // ── Silent auto-recalculate missing OR stale scores on mount ──────────────
  // Runs once when the page loads. Recalculates and saves scores in the
  // background — no button, no manual step. Two cases are repaired:
  //
  //   1. MISSING  — task has raw contributions but no contribution_scores row
  //                 (e.g. from old saves before scoring existed).
  //
  //   2. STALE    — task has score rows whose earnings_inr are ALL zero, yet
  //                 the task now has billing_amount_inr > 0. This happens when
  //                 a task is scored BEFORE its billing/price is set (pool = 0
  //                 → earnings = 0), then billing is added later. The score
  //                 snapshot is never recomputed, so payroll keeps reading ₹0.
  //                 Detecting & recomputing here makes the scores self-heal.
  useEffect(() => {
    if (autoRecalcRan.current) return
    autoRecalcRan.current = true

    // GUARD 1 — a viewer without pricing visibility is served a task payload
    // WITHOUT billing_amount_inr (see the two selects in page.tsx), which
    // would read as a 0 pool and this repair path would SAVE ₹0 over real
    // earnings. Money must never be recomputed from a payload deliberately
    // stripped of it: if you cannot see the basis, you do not get to rewrite
    // the result.
    if (!permissionFlags?.pricing) return

    const taskIdsWithContribs = new Set(contributorRecords.map(c => c.task_id))
    const scoredTaskIds = new Set(scores.map(s => s.task_id))

    // Case 2 prep: per task, does ANY score row have non-zero earnings?
    const taskHasNonZeroEarnings = new Map<string, boolean>()
    scores.forEach(s => {
      const prev = taskHasNonZeroEarnings.get(s.task_id) || false
      taskHasNonZeroEarnings.set(s.task_id, prev || (s.earnings_inr ?? 0) > 0)
    })

    const tasksNeedingScores = initialTasks.filter((t: any) => {
      const hasContribs = taskIdsWithContribs.has(t.id)
      if (!hasContribs) return false
      const hasScore = scoredTaskIds.has(t.id)
      // Case 1: contributions but no score row at all.
      if (!hasScore) return true
      // Case 2: scored, but every row is ₹0 while the task now has billing.
      const billing = t.billing_amount_inr || 0
      const stale = billing > 0 && taskHasNonZeroEarnings.get(t.id) === false
      return stale
    })
    if (tasksNeedingScores.length === 0) return

    async function doSilentRecalc() {
      const taskIds = tasksNeedingScores.map((t: any) => t.id)
      const { data: allContribs } = await supabase
        .from('contributions')
        .select('task_id, employee_id, parameter_id, value')
        .in('task_id', taskIds)
        .gt('value', 0)

      if (!allContribs?.length) return

      const byTask: Record<string, any[]> = {}
      allContribs.forEach((c: any) => {
        if (!byTask[c.task_id]) byTask[c.task_id] = []
        byTask[c.task_id].push(c)
      })

      let savedCount = 0
      // Months whose payroll may be recalculated afterwards. Closed months are
      // deliberately excluded: their saves are prior-period corrections, and
      // recalculatePayrollForMonth would restate every PENDING payslip in them.
      const openMonths = new Set<string>()
      let closedCorrections = 0
      let queuedAdjustments = 0
      for (const task of tasksNeedingScores) {
        const contribs = byTask[task.id]
        if (!contribs?.length) continue

        const linkedGroupIds = groupServicesFromDB
          .filter((gs: any) => gs.service_id === task.service_id)
          .map((gs: any) => gs.group_id)
        const taskGroups = linkedGroupIds.length > 0
          ? groups.filter((g: any) => linkedGroupIds.includes(g.id))
          : groups
        const taskParams = parameters.filter((p: any) => taskGroups.some((g: any) => g.id === p.group_id))

        const pricing = pricingMatrix.find(
          (p: any) => p.client_id === task.client?.id && p.service_id === task.service_id
        )
        const commPct = pricing?.commission_percentage ?? 50

        const usedToolIds = new Set(
          taskToolRecords.filter((tt: any) => tt.task_id === task.id).map((tt: any) => tt.tool_id)
        )
        const linkedToolIds = toolServices
          .filter((ts: any) => ts.service_id === task.service_id)
          .map((ts: any) => ts.tool_id)
        const taskToolsForCalc = tools
          .filter((t: any) => linkedToolIds.length > 0 ? linkedToolIds.includes(t.id) : true)
          .map((t: any) => ({ tool: t, used: usedToolIds.has(t.id) }))

        const contribArray = contribs.map((c: any) => ({
          id: '', task_id: c.task_id, parameter_id: c.parameter_id,
          employee_id: c.employee_id, value: c.value,
          locked: false, created_at: '', updated_at: '',
        }))

        const effectiveEmployees = employees.map((emp: any) => ({
          ...emp,
          performance_rating: getEffectivePerformanceRating(emp.id, task.task_date, performanceHistory, emp.performance_rating)
        }))

        try {
          const result = calculateCommission({
            taskId: task.id,
            billingAmountINR: task.billing_amount_inr || 0,
            serviceCommissionPct: commPct,
            employees: effectiveEmployees, groups: taskGroups,
            parameters: taskParams,
            toolsUsed: taskToolsForCalc,
            contributions: contribArray,
          })
          // GUARD 2 — independent of why: a repair that computes ₹0 for a task
          // that currently has non-zero stored earnings is destroying data, not
          // healing it. Skip and leave the existing figures alone. A genuine
          // zero (no billing, no work value) is reached through an explicit
          // save, not this background path.
          const computedTotal = result.employeeEarnings.reduce((sum: number, e: any) => sum + (e.earnings || 0), 0)
          const storedTotal = scores
            .filter((sc: any) => sc.task_id === task.id)
            .reduce((sum: number, sc: any) => sum + (sc.earnings_inr ?? 0), 0)
          if (computedTotal === 0 && storedTotal > 0) continue

          if (result.employeeEarnings.length > 0) {
            // Score-only recalc through the guarded server action: preserves
            // manual overrides and refuses finalized payroll months, instead
            // of the old browser-side delete-then-insert that clobbered both.
            const res = await saveTaskContributions({
              taskId: task.id,
              scores: result.employeeEarnings.map((e: any) => ({
                employeeId: e.employeeId,
                scorePercentage: e.scorePercentage,
                earnings: e.earnings,
              })),
            })
            if (res.ok) {
              savedCount++
              if (res.closedPeriod) {
                // Correction to closed books: the server has already queued the
                // money difference. Touch nothing else for this month.
                closedCorrections++
                queuedAdjustments += res.adjustmentsRecorded ?? 0
              } else {
                if (task.task_date) {
                  const d = new Date(task.task_date)
                  openMonths.add(`${d.getFullYear()}-${d.getMonth() + 1}`)
                }
              }
            }
          }
        } catch { /* skip tasks that fail calculation */ }
      }

      // Auto-recalculate payroll for the OPEN months only. This used to derive
      // the month set from every task in the batch, which — now that closed
      // months save successfully — would have recalculated payroll for exactly
      // the months whose books are shut.
      openMonths.forEach((monthKey: string) => {
        const [year, month] = monthKey.split('-').map(Number)
        recalculatePayrollForMonth({ month, year, source: 'contribution_edit' }).catch(() => {
          // Silently ignore payroll recalc errors
        })
      })

      // A silent bulk correction to closed books is exactly what must not
      // happen — surface it even though this path runs in the background.
      if (closedCorrections > 0) {
        toast.info(
          `${closedCorrections} task${closedCorrections === 1 ? '' : 's'} corrected in closed periods`,
          queuedAdjustments > 0
            ? `Historical payroll was not changed. ${queuedAdjustments} prior-period adjustment${queuedAdjustments === 1 ? '' : 's'} queued for the next open payroll.`
            : 'Historical payroll was not changed. Run Check corrections on those month cards to queue any difference.',
          10000,
        )
      }

      // Money must never move invisibly. This repair path writes contribution
      // scores AND restates pending payroll for the open months it touched, so
      // it announces itself — previously the only trace was numbers quietly
      // changing between two page loads.
      if (savedCount > 0) {
        const months = openMonths.size
        toast.info(
          `${savedCount} task${savedCount === 1 ? '' : 's'} rescored automatically`,
          months > 0
            ? `Earnings were missing or out of date on ${savedCount === 1 ? 'this task' : 'these tasks'}. Pending payroll for ${months} open month${months === 1 ? '' : 's'} was updated to match. Paid payslips were not touched.`
            : `Earnings were missing or out of date. No payroll needed updating.`,
          8000,
        )
        // Refresh server data so counts & payroll reflect the new scores
        router.refresh()
      }
    }

    doSilentRecalc()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived data ─────────────────────────────────────
  // DB rows only — no localStorage fallback. The server recalc paths
  // (integrity.ts, /api/recalc-commissions) read only the DB junction, and
  // "no rows = all groups" is now the consistent rule everywhere; a stale
  // localStorage copy would silently restrict this screen to different groups
  // than every other path computes with.
  const groupServices = groupServicesFromDB

  const mergedParameters = useMemo(() => {
    try {
      const meta: Record<string, any> = JSON.parse(localStorage.getItem('cirqle_param_meta') || '{}')
      if (!Object.keys(meta).length) return parameters
      return parameters.map(p => meta[p.id] ? { ...p, ...meta[p.id] } : p)
    } catch { return parameters }
  }, [parameters])

  // Tasks with contribution_scores (calculated) — used for "Missing" filter
  // Only contribution_scores counts as "scored" — raw contributions alone do NOT
  const taskScoredSet = useMemo(() => {
    const s = new Set<string>()
    scores.forEach(score => s.add(score.task_id))
    return s
  }, [scores])

  // Contributor lookup: taskId → Set<employeeId>
  // Merges both contribution_scores (calculated saves) and contributions (raw saves)
  const taskScoreMap = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    scores.forEach(s => {
      if (s.score_percentage > 0 || (s.earnings_inr ?? 0) > 0) {
        if (!m[s.task_id]) m[s.task_id] = new Set()
        m[s.task_id].add(s.employee_id)
      }
    })
    contributorRecords.forEach(c => {
      if (!m[c.task_id]) m[c.task_id] = new Set()
      m[c.task_id].add(c.employee_id)
    })
    return m
  }, [scores, contributorRecords])

  // taskId → empId → { pct, earnings_inr } — for showing scores on list cards
  const taskScoreDetailMap = useMemo(() => {
    const m: Record<string, Record<string, { pct: number; earnings: number | null }>> = {}
    scores.forEach(s => {
      if (s.score_percentage > 0 || (s.earnings_inr ?? 0) > 0) {
        if (!m[s.task_id]) m[s.task_id] = {}
        m[s.task_id][s.employee_id] = { pct: s.score_percentage, earnings: s.earnings_inr ?? null }
      }
    })
    return m
  }, [scores])

  // Tools lookup: taskId → tool_id[]
  const taskToolsMap = useMemo(() => {
    const m: Record<string, string[]> = {}
    taskToolRecords.forEach(r => {
      if (!m[r.task_id]) m[r.task_id] = []
      if (!m[r.task_id].includes(r.tool_id)) m[r.task_id].push(r.tool_id)
    })
    return m
  }, [taskToolRecords])

  // taskId → task_date, used to date each historical contribution for recency.
  const taskDateById = useMemo(() => {
    const m = new Map<string, string>()
    localTasks.forEach((t: any) => { if (t.task_date) m.set(t.id, t.task_date) })
    return m
  }, [localTasks])

  // Per-employee parameter usage from the full contributions ledger:
  // empId → paramId → { count, last } where count = how many tasks they've used
  // that parameter on and last = most recent task_date (ms). Drives the
  // "most-used parameters first" ordering in the entry form.
  const paramUsageByEmp = useMemo(() => {
    const m = new Map<string, Map<string, { count: number; last: number }>>()
    for (const r of contributorRecords as any[]) {
      if (!r.parameter_id || (r.value ?? 0) <= 0) continue
      if (!m.has(r.employee_id)) m.set(r.employee_id, new Map())
      const inner = m.get(r.employee_id)!
      const prev = inner.get(r.parameter_id) || { count: 0, last: 0 }
      const d = taskDateById.get(r.task_id)
      const ts = d ? new Date(d + 'T00:00:00').getTime() : 0
      inner.set(r.parameter_id, { count: prev.count + 1, last: Math.max(prev.last, ts) })
    }
    return m
  }, [contributorRecords, taskDateById])

  // Split a group's sub-parameters into the employee's frequently-used ones
  // (shown up-front as ready steppers) and the rest (behind a "more" toggle).
  // Ranking = usage count + a recency boost, so what they "mostly and recently"
  // do floats to the top. Any param with a current value is always shown.
  function rankSubParams(empId: string, subs: any[]) {
    const usage = paramUsageByEmp.get(empId)
    const now = Date.now()
    const scored = subs.map(p => {
      const u = usage?.get(p.id)
      const count = u?.count || 0
      const last = u?.last || 0
      const daysAgo = last ? (now - last) / 86400000 : Infinity
      const recencyBoost = daysAgo < 30 ? 6 : daysAgo < 90 ? 3 : daysAgo < 180 ? 1 : 0
      const hasVal = (contributions[p.id]?.[empId] || 0) > 0
      return { p, score: count + recencyBoost, hasVal }
    })
    const sorted = [...scored].sort((a, b) =>
      b.score - a.score || (a.p.display_order || 0) - (b.p.display_order || 0))
    const N = 4
    const frequentSet = new Set<string>()
    scored.forEach(s => { if (s.hasVal) frequentSet.add(s.p.id) })
    for (const s of sorted) {
      if (frequentSet.size >= N) break
      if (s.score > 0) frequentSet.add(s.p.id)
    }
    // No history at all → fall back to first N by display order so the form
    // still surfaces something sensible to tap.
    if (frequentSet.size === 0) sorted.slice(0, N).forEach(s => frequentSet.add(s.p.id))
    return {
      frequent: subs.filter(p => frequentSet.has(p.id)),
      rest:     subs.filter(p => !frequentSet.has(p.id)),
    }
  }

  // Order an employee's groups by their own history (same frequency+recency
  // signal as parameters, aggregated across each group's params). Groups with
  // any value in the CURRENT task always float to the top; new employees with
  // no history keep the configured display order. Returns the ordered groups
  // tagged with whether each is the single "most-used" group (for the badge).
  function rankGroups(empId: string, gps: any[]) {
    const usage = paramUsageByEmp.get(empId)
    const now = Date.now()
    const scored = gps.map(g => {
      let count = 0, last = 0
      for (const p of g.params) {
        const u = usage?.get(p.id)
        if (u) { count += u.count; last = Math.max(last, u.last) }
      }
      const daysAgo = last ? (now - last) / 86400000 : Infinity
      const recencyBoost = daysAgo < 30 ? 6 : daysAgo < 90 ? 3 : daysAgo < 180 ? 1 : 0
      const isActive = g.params.some((p: any) => (contributions[p.id]?.[empId] || 0) > 0)
      return { g, score: count + recencyBoost, isActive }
    })
    scored.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      return b.score - a.score || (a.g.display_order || 0) - (b.g.display_order || 0)
    })
    // The top group earns the "Most Used" badge only when it has real history
    // and there's more than one group to compare against.
    const topId = scored.length > 1 && scored[0]?.score > 0 ? scored[0].g.id : null
    return scored.map(s => ({ ...s, isMostUsed: s.g.id === topId }))
  }

  // Assignment lookup: taskId → Set<employeeId>
  const taskAssignmentMap = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    assignments.forEach(a => {
      if (!m[a.task_id]) m[a.task_id] = new Set()
      m[a.task_id].add(a.employee_id)
    })
    return m
  }, [assignments])

  // Service team lookup: serviceId → Set<employeeId> (employee_services junction)
  const serviceEmployeeMap = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    employeeServices.forEach(es => {
      if (!m[es.service_id]) m[es.service_id] = new Set()
      m[es.service_id].add(es.employee_id)
    })
    return m
  }, [employeeServices])

  // Employees relevant to a task: its service's assigned team, plus anyone who
  // already contributed / was assigned (historic data must never disappear).
  // A service with no assigned employees falls back to the full roster, so
  // nothing changes until assignments are configured.
  function employeesForTask(task: any): any[] {
    const team = task?.service_id ? serviceEmployeeMap[task.service_id] : undefined
    if (!team || team.size === 0) return employees
    return employees.filter(e =>
      team.has(e.id)
      || taskScoreMap[task.id]?.has(e.id)
      || taskAssignmentMap[task.id]?.has(e.id)
    )
  }

  // ── Smart Mode: with a date filter active, the Employee/Client/Service
  // dropdowns only offer values present in tasks within the selected period
  // (current selection is kept so it stays clearable).
  const dateScopedTasks = useMemo(
    () => (filterDate ? localTasks.filter((t: any) => matchesDateFilter(t.task_date, filterDate)) : null),
    [localTasks, filterDate],
  )
  const scopedEmployeeOptions = useMemo(() => {
    const all = employees.map((emp: any) => ({ value: emp.id, label: dn(emp) }))
    if (!dateScopedTasks) return all
    const ids = new Set<string>()
    dateScopedTasks.forEach((t: any) => {
      taskScoreMap[t.id]?.forEach((id: string) => ids.add(id))
      taskAssignmentMap[t.id]?.forEach((id: string) => ids.add(id))
    })
    return all.filter(o => ids.has(o.value) || o.value === filterEmployee)
  }, [dateScopedTasks, employees, dn, taskScoreMap, taskAssignmentMap, filterEmployee])
  const scopedClientOptions = useMemo(() => {
    const all = clients.map(c => ({ value: c.id, label: c.name }))
    if (!dateScopedTasks) return all
    const ids = new Set(dateScopedTasks.map((t: any) => t.client?.id).filter(Boolean))
    return all.filter(o => ids.has(o.value) || filterClients.includes(o.value))
  }, [dateScopedTasks, clients, filterClients])
  const scopedServiceOptions = useMemo(() => {
    const all = services.map(s => ({ value: s.id, label: s.name }))
    if (!dateScopedTasks) return all
    const ids = new Set(dateScopedTasks.map((t: any) => t.service_id).filter(Boolean))
    return all.filter(o => ids.has(o.value) || filterServices.includes(o.value))
  }, [dateScopedTasks, services, filterServices])

  async function toggleAssignment(taskId: string, empId: string) {
    const isAssigned = taskAssignmentMap[taskId]?.has(empId)
    const next = isAssigned
      ? assignments.filter(a => !(a.task_id === taskId && a.employee_id === empId))
      : [...assignments, { task_id: taskId, employee_id: empId }]
    setAssignments(next)
    localStorage.setItem('cirqle_task_assignments', JSON.stringify(next))
    try {
      if (isAssigned) {
        await supabase.from('task_assignments').delete().eq('task_id', taskId).eq('employee_id', empId)
      } else {
        await supabase.from('task_assignments').insert({ task_id: taskId, employee_id: empId })
      }
    } catch { /* pre-migration: localStorage is source of truth */ }
  }

  // ── Task filtering + grouping ─────────────────────────
  const filteredTasks = useMemo(() => {
    return localTasks.filter(t => {
      // Search facets w/ operators: generic 'any' ANDs (each narrows); same
      // named field ORs; across fields AND. See facetMatchesTask().
      for (const f of activeFacets) {
        if (f.field === 'any' && !facetMatchesTask(t, f)) return false
      }
      const namedByField: Record<string, SearchFacet[]> = {}
      for (const f of activeFacets) if (f.field !== 'any') (namedByField[f.field] ||= []).push(f)
      for (const fs of Object.values(namedByField)) {
        if (!fs.some(f => facetMatchesTask(t, f))) return false
      }
      if (filterClients.length && !filterClients.includes(t.client?.id)) return false
      if (filterServices.length && !filterServices.includes(t.service_id)) return false
      if (!matchesDateFilter(t.task_date, filterDate)) return false
      const contributed = taskScoreMap[t.id]
      const doneCount = contributed ? contributed.size : 0
      if (filterEmployee) {
        const hasContributed = contributed?.has(filterEmployee)
        if (filterEmployeeMode === 'without') {
          // Everyone EXCEPT this person: tasks they did not contribute to and
          // are not assigned to. Answers "what did the rest of the team do".
          const isAssigned = taskAssignmentMap[t.id]?.has(filterEmployee)
          if (hasContributed || isAssigned) return false
        } else if (filterEmployeeMode === 'solo') {
          // Only tasks where this employee is the SOLE contributor
          if (!hasContributed) return false
          if ((contributed?.size ?? 0) > 1) return false
        } else if (filterEmployeeMode === 'worked') {
          // Tasks this employee worked on (with others is fine)
          if (!hasContributed) return false
        } else {
          // 'any': contributed or assigned
          const isAssigned = taskAssignmentMap[t.id]?.has(filterEmployee)
          if (!hasContributed && !isAssigned) return false
        }
      }
      if (myScope && currentEmployee) {
        const isMine = !!contributed?.has(currentEmployee.id) || !!taskAssignmentMap[t.id]?.has(currentEmployee.id)
        if (myScope === 'mine' && !isMine) return false
        if (myScope === 'not_mine' && isMine) return false
      }
      if (statusFilter === 'pending' && doneCount > 0) return false   // Pending = zero contributions
      if (statusFilter === 'done' && doneCount === 0) return false     // Done = at least 1 contributed
      if (statusFilter === 'missing') {
        // Tasks whose task-status is 'done' but have NO contribution_scores yet
        // NOTE: raw contributions don't count — only calculated scores do
        if (t.status !== 'done') return false
        if (taskScoredSet.has(t.id)) return false
      }
      return true
    })
  }, [localTasks, activeFacets, filterClients, filterServices, filterDate, filterEmployee, filterEmployeeMode, statusFilter, taskScoreMap, taskAssignmentMap, employees, myScope, currentEmployee])

  // canSeeFinancials: requires (a) the legacy visibility-settings gate AND
  // (b) the new granular `contributions.view_earnings` permission. Both
  // conditions must hold; permissionFlags is sourced from the server and
  // tells the client whether earnings_inr is even present in the payload.
  const canSeeFinancials = role !== 'employee' && showContribs && showBilling && permissionFlags.earnings

  // Whether the current user can see all employees' contributions.
  // Falls back to role-based check for backwards compat (no viewAll flag = old behaviour).
  const canViewAll = permissionFlags.viewAll ?? (role !== 'employee')

  // In 'own' scope, the entry form only shows the logged-in employee's card.
  // Either way the roster is first scoped to the open task's service team
  // (employee_services) so unrelated departments never clutter the entry form.
  const serviceScopedEmployees = selectedTask ? employeesForTask(selectedTask) : employees
  const scopedEmployees = canViewAll
    ? serviceScopedEmployees
    : serviceScopedEmployees.filter(e => e.id === currentEmployee?.id)

  // Most recent save time for the open task (shown in the per-employee summary).
  const taskLastSaved = useMemo(() => {
    if (!selectedTask) return null
    const ds = scores
      .filter(s => s.task_id === selectedTask.id && s.calculated_at)
      .map(s => s.calculated_at as string)
      .sort()
    return ds.length
      ? formatDate(ds[ds.length - 1])
      : null
  }, [scores, selectedTask])

  // For employee/view_only role, only show their assigned tasks — then apply quick sort
  const myVisibleTasks = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    if (sortBy === 'today_first') {
      const todayTasks = filteredTasks.filter(t => t.task_date === today)
      const rest = filteredTasks.filter(t => t.task_date !== today).sort((a, b) => (b.task_date || '').localeCompare(a.task_date || ''))
      return [...todayTasks, ...rest]
    }
    if (sortBy === 'date_asc')    return [...filteredTasks].sort((a, b) => (a.task_date || '').localeCompare(b.task_date || ''))
    if (sortBy === 'date_desc')   return [...filteredTasks].sort((a, b) => (b.task_date || '').localeCompare(a.task_date || ''))
    if (sortBy === 'amount_desc') return [...filteredTasks].sort((a, b) => (b.billing_amount_inr ?? 0) - (a.billing_amount_inr ?? 0))
    if (sortBy === 'client')      return [...filteredTasks].sort((a, b) => (a.client?.name || '').localeCompare(b.client?.name || ''))
    return filteredTasks
  }, [filteredTasks, sortBy])

  const tasksByDate = useMemo(() => {
    const map: Record<string, any[]> = {}
    
    // To prevent massive DOM lag on mobile, we limit the initial render to mobileLimit tasks
    // unless they are explicitly searching or filtering by employee.
    const hasTightFilter = hasSearch || !!filterEmployee || !!myScope
    const tasksToRender = hasTightFilter ? myVisibleTasks : myVisibleTasks.slice(0, mobileLimit)

    tasksToRender.forEach(t => {
      const d = t.task_date || 'Unknown'
      if (!map[d]) map[d] = []
      map[d].push(t)
    })
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a))
  }, [myVisibleTasks, hasSearch, filterEmployee, myScope])

  // ── Entry-view derived data ───────────────────────────
  const filteredGroups = useMemo(() => {
    if (!selectedTask) return groups
    const linked = groupServices.filter(gs => gs.service_id === selectedTask.service_id).map(gs => gs.group_id)
    // No linked groups = ALL groups available — same fallback as openTask,
    // the silent recalc, integrity.ts and /api/recalc-commissions, and what
    // the Settings service form promises.
    if (!linked.length) return groups
    return groups.filter(g => linked.includes(g.id))
  }, [selectedTask, groups, groupServices])

  const filteredParams = useMemo(() => {
    const ids = filteredGroups.map(g => g.id)
    return mergedParameters.filter(p => ids.includes(p.group_id))
  }, [filteredGroups, mergedParameters])

  const filteredTools = useMemo(() => {
    if (!selectedTask) return tools
    const linked = toolServices.filter(ts => ts.service_id === selectedTask.service_id).map(ts => ts.tool_id)
    // No linked tools = ALL tools available — matches the recalculation paths
    // (same empty-junction fallback rule as filteredGroups above).
    if (!linked.length) return tools
    return tools.filter(t => linked.includes(t.id))
  }, [selectedTask, tools, toolServices])

  const groupedParams = useMemo(() => {
    return filteredGroups.map(g => {
      const params = filteredParams.filter(p => p.group_id === g.id)
      const master = params.find(p => p.is_master === true) || params.find(p => p.weight === 1) || params[0]
      const subs = params.filter(p => p.id !== master?.id)
      return { ...g, master, subs, params }
    }).filter(g => g.params.length > 0)
  }, [filteredGroups, filteredParams])

  // ── Auto-calculate commissions (fires on every change) ──
  // Always calculate scores — independent of showFinancials display toggle
  const calculatedResult = useMemo(() => {
    if (!selectedTask) return null
    const hasAny = Object.values(contributions).some(m => Object.values(m).some(v => v > 0))
    if (!hasAny) return null
    const contribArray = Object.entries(contributions).flatMap(([paramId, empMap]) =>
      Object.entries(empMap).map(([empId, value]) => ({
        id: '', task_id: selectedTask.id, parameter_id: paramId, employee_id: empId, value,
        locked: false, created_at: '', updated_at: '',
      }))
    )

    const effectiveEmployees = employees.map((emp: any) => ({
      ...emp,
      performance_rating: getEffectivePerformanceRating(emp.id, selectedTask.task_date, performanceHistory, emp.performance_rating)
    }))

    try {
      return calculateCommission({
        taskId: selectedTask.id,
        billingAmountINR: selectedTask.billing_amount_inr || 0,
        serviceCommissionPct: serviceCommPct,
        employees: effectiveEmployees, groups,
        parameters: filteredParams,
        toolsUsed: filteredTools.map(t => ({ tool: t, used: toolsUsed[t.id] || false })),
        contributions: contribArray,
      })
    } catch { return null }
  }, [contributions, toolsUsed, serviceCommPct, selectedTask, employees, groups, filteredParams, filteredTools, performanceHistory])

  // ── Entry-view helpers ────────────────────────────────
  function setContrib(paramId: string, empId: string, val: number) {
    setContributions(prev => ({ ...prev, [paramId]: { ...(prev[paramId] || {}), [empId]: Math.max(0, val) } }))
  }

  function toggleGroup(empId: string, groupId: string) {
    const key = `${empId}:${groupId}`
    setActiveGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        const group = groupedParams.find(g => g.id === groupId)
        if (group) {
          group.params.forEach((p: any) => setContrib(p.id, empId, 0))
          setActiveSubParams(sp => { const n = new Set(sp); group.subs.forEach((p: any) => n.delete(`${empId}:${p.id}`)); return n })
        }
      } else { next.add(key) }
      return next
    })
  }


  async function openTask(task: any) {
    // Reset everything first, show entry view immediately
    setSelectedTask(task)
    setContributions({}); setToolsUsed({})
    setExpandedEmployees(new Set()); setActiveGroups(new Set()); setActiveSubParams(new Set())
    setCommOverrideReason(''); setShowCommOverride(false)

    // Auto-load commission rate: the pricing matrix, else 50.
    const pricing = pricingMatrix.find(
      p => p.client_id === (task.client?.id) && p.service_id === task.service_id
    )
    if (pricing?.commission_percentage != null) {
      setServiceCommPct(pricing.commission_percentage)
      setPredefinedCommPct(pricing.commission_percentage)
    } else {
      setServiceCommPct(50)
      setPredefinedCommPct(null)
    }

    setView('entry')

    setImportedScores([])
    // Fetch any previously saved contributions + tools for this task
    const [contribRes, toolRes, scoreRes] = await Promise.all([
      supabase.from('contributions').select('parameter_id, employee_id, value').eq('task_id', task.id),
      supabase.from('task_tools').select('tool_id').eq('task_id', task.id),
      supabase.from('contribution_scores').select('employee_id, score_percentage, earnings_inr').eq('task_id', task.id),
    ])

    if (scoreRes.data?.length && (!contribRes.data || contribRes.data.length === 0)) {
      setImportedScores(scoreRes.data)
    }

    if (contribRes.data?.length) {
      // Build group lookup inline (can't use groupedParams useMemo — selectedTask state not flushed yet)
      const linkedGroupIds = groupServices
        .filter(gs => gs.service_id === task.service_id)
        .map(gs => gs.group_id)
      const taskGroups = linkedGroupIds.length > 0
        ? groups.filter(g => linkedGroupIds.includes(g.id))
        : groups
      const taskParams = mergedParameters.filter(p => taskGroups.some(g => g.id === p.group_id))
      const taskGroupedParams = taskGroups.map(g => {
        const params = taskParams.filter(p => p.group_id === g.id)
        const master = params.find(p => p.is_master === true) || params.find(p => p.weight === 1) || params[0]
        const subs = params.filter(p => p.id !== master?.id)
        return { ...g, master, subs, params }
      }).filter(g => g.params.length > 0)

      const contribs: Record<string, Record<string, number>> = {}
      const newActiveGroups = new Set<string>()
      const newActiveSubParams = new Set<string>()
      const newExpandedEmps = new Set<string>()

      contribRes.data.forEach(({ parameter_id, employee_id, value }: any) => {
        if (value <= 0) return
        if (!contribs[parameter_id]) contribs[parameter_id] = {}
        contribs[parameter_id][employee_id] = value

        // Activate the group this param belongs to
        const group = taskGroupedParams.find(g => g.params.some((p: any) => p.id === parameter_id))
        if (group) {
          newActiveGroups.add(`${employee_id}:${group.id}`)
          // If it's a sub-param (not the master), also mark it active
          if (group.master?.id !== parameter_id) {
            newActiveSubParams.add(`${employee_id}:${parameter_id}`)
          }
        }
        // Note: we intentionally do NOT add to newExpandedEmps here —
        // admin cards start collapsed; tap to open the one you want.
      })

      setContributions(contribs)
      setActiveGroups(newActiveGroups)
      setActiveSubParams(newActiveSubParams)
      setExpandedEmployees(new Set()) // always start collapsed
    }

    if (toolRes.data?.length) {
      const toolsMap: Record<string, boolean> = {}
      toolRes.data.forEach(({ tool_id }: any) => { toolsMap[tool_id] = true })
      setToolsUsed(toolsMap)
    }

    // If no DB data found, try loading draft from localStorage
    if (!contribRes.data?.length && !toolRes.data?.length) {
      try {
        const draft = localStorage.getItem(draftKey(task.id))
        if (draft) {
          const { contributions: dc, toolsUsed: dt, serviceCommPct: dsp } = JSON.parse(draft)
          if (dc) setContributions(dc)
          if (dt) setToolsUsed(dt)
          if (dsp) setServiceCommPct(dsp)
          // Re-expand employees that have data
          const empIds = new Set<string>()
          Object.values(dc || {}).forEach((empMap: any) => Object.keys(empMap).forEach(id => empIds.add(id)))
          // Don't auto-expand for admin — only own-scope expands below
        }
      } catch { /* ignore */ }
    }

    // In 'own' scope, auto-expand the current employee's card so they
    // land directly on the entry form — no extra tap needed.
    if (!canViewAll && currentEmployee?.id) {
      setExpandedEmployees(prev => { const n = new Set(prev); n.add(currentEmployee.id); return n })
    }
  }

  async function handleSave() {
    if (!selectedTask) return
    setSaving(true)
    const toolInserts = filteredTools.filter(t => toolsUsed[t.id]).map(t => ({ task_id: selectedTask.id, tool_id: t.id }))

    // Phase 3.0 — one guarded server action instead of browser-side
    // delete-then-reinsert. The server enforces permission checks and
    // finalized-month protection, preserves manual overrides, and logs the
    // activity entry itself. On error we surface it and keep the draft.
    const saveRes = await saveTaskContributions({
      taskId: selectedTask.id,
      contributions,
      scores: calculatedResult
        ? calculatedResult.employeeEarnings.map((e: any) => ({
            employeeId: e.employeeId,
            scorePercentage: e.scorePercentage,
            earnings: e.earnings,
          }))
        : undefined,
      toolIds: toolInserts.map(t => t.tool_id),
      markDone: true,   // server only advances pending/in_progress → done
    })

    if (!saveRes.ok) {
      setSaving(false)
      toast.error('Failed to save contributions', saveRes.error || 'Unknown error', 6000)
      return   // keep the draft — do NOT show success or clear it
    }

    // ── Closed period: the money must NOT be re-derived here ─────────────────
    // A correction to a closed month is carried by the prior-period adjustment
    // ledger, which the server already queued. Running the two follow-ups below
    // would defeat that: recalculatePayrollForMonth rewrites every PENDING
    // payslip for the month, so an explicitly locked month (whose payslips are
    // still pending) would have its historical payroll silently restated —
    // exactly what closing the books is meant to prevent.
    if (!saveRes.closedPeriod) {
      // Auto-recalculate pending payroll for this month when contributions change
      if (selectedTask.task_date) {
        const taskDate = new Date(selectedTask.task_date)
        const month = taskDate.getMonth() + 1
        const year = taskDate.getFullYear()
        // Fire-and-forget payroll recalculation
        recalculatePayrollForMonth({ month, year, source: 'contribution_edit' }).catch(() => {
          // Silently ignore payroll recalc errors; contribution save succeeded
        })
      }
    }

    setSaving(false)

    // Manually-overridden scores are re-inserted verbatim by the server, never
    // replaced by the freshly computed figure. Saying only "saved" made that
    // look like a failed write: the edit appeared to take, then the old number
    // came back on reload with nothing explaining why. Say it out loud instead.
    if ((saveRes.preservedOverrides ?? 0) > 0) {
      const n = saveRes.preservedOverrides!
      toast.info(
        `${n} ${n === 1 ? 'score kept its manual override' : 'scores kept their manual overrides'}`,
        'Their parameters were saved, but the score % and ₹ stay as manually set — recalculation cannot overwrite an override. Clear the override to recompute.',
        8000,
      )
    }

    // Closed period: say what moved and what did not, instead of a bare
    // "saved" that hides the prior-period adjustment.
    if (saveRes.closedPeriod) {
      const notice = closedPeriodNotice(saveRes.correctedMonth, saveRes.adjustmentsRecorded)
      toast.info(notice.title, notice.body, 10000)
    } else if (calculatedResult && calculatedResult.employeeEarnings.length > 0) {
      // Auto-dismiss toast showing who was paid what
      const lines = calculatedResult.employeeEarnings
        .map((e: any) => `${employees.find((emp: any) => emp.id === e.employeeId)?.cqid ?? '?'} ₹${Math.round(e.earnings).toLocaleString('en-IN')}`)
        .join(' · ')
      toast.success('Contributions saved', lines, 3500)
    } else {
      toast.success('Contributions saved')
    }

    // Clear draft on successful save
    try { localStorage.removeItem(draftKey(selectedTask.id)) } catch { /* ignore */ }

    // Brief pause so toast is visible before switching back to list
    await new Promise(r => setTimeout(r, 400))
    setView('list')
  }

  // ── Edit Task handlers ────────────────────────────────
  function openEditTask(task: any) {
    setEditingTask(task)
  }

  // ── Bulk actions ─────────────────────────────────────
  async function bulkUpdateStatus(status: string) {
    const ids = [...selectedTasks]
    if (ids.length === 0) return
    await Promise.all(ids.map(id => supabase.from('tasks').update({ status }).eq('id', id)))
    setLocalTasks(prev => prev.map(t => selectedTasks.has(t.id) ? { ...t, status } : t))
    setSelectedTasks(new Set())
    setBulkMode(false)
    toast.success(`${ids.length} task${ids.length !== 1 ? 's' : ''} updated`)
    router.refresh()
  }

  // In-app confirmation, NOT window.confirm: the desktop shell returns false
  // from native confirm without drawing a dialog, so bulk delete silently did
  // nothing there. The copy also names the earnings consequence, which the
  // one-line native prompt never did.
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)

  async function bulkDeleteTasks() {
    const ids = [...selectedTasks]
    if (ids.length === 0) return
    await Promise.all(ids.map(id =>
      supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    ))
    setLocalTasks(prev => prev.filter(t => !selectedTasks.has(t.id)))
    setSelectedTasks(new Set())
    setBulkMode(false)
    toast.success(`${ids.length} task${ids.length !== 1 ? 's' : ''} moved to trash`)
    router.refresh()
  }


  // ── Duplicate task ──────────────────────────────────────
  async function handleDuplicateTask(task: any) {
    setDuplicatingTaskId(task.id)
    // Auto-assign the next sequential task number (same rule as the Tasks page)
    // so the duplicate isn't created without a number.
    const maxRow = await supabase
      .from('tasks')
      .select('task_number')
      .order('task_number', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    const payload: any = {
      task_number: nextTaskNumber(maxRow.data?.task_number),
      title: task.title,
      status: 'pending',
      task_date: todayISO(),
      quantity: task.quantity || 1,
    }
    if (task.client?.id) payload.client_id = task.client.id
    if (task.service_id) payload.service_id = task.service_id
    // Carry the full billing snapshot so the copy bills identically.
    if (task.billing_amount_inr) payload.billing_amount_inr = task.billing_amount_inr
    if (task.billing_amount) payload.billing_amount = task.billing_amount
    if (task.currency) payload.currency = task.currency

    const { data, error } = await supabase
      .from('tasks')
      .insert(payload)
      .select('id, task_number, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services!service_id(id, name)')
      .single()

    if (!error && data) {
      setLocalTasks(prev => [data, ...prev])
      // No amount carried over → backfill from client/service pricing.
      if (!(data as any).billing_amount_inr && (data as any).service_id) {
        void serverFillTaskBilling((data as any).id, task.client?.id || null, (data as any).service_id, task.quantity || 1)
      }
      toast.success('Task duplicated', `"${task.title}" copied to today`)
    } else if (error) {
      toast.error('Failed to duplicate', error.message)
    }
    setDuplicatingTaskId(null)
  }

  // ── Add Task handler ──────────────────────────────────
  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault()
    if (!addTaskForm.title.trim()) { setAddTaskError('Task title is required'); return }
    setAddingTask(true); setAddTaskError('')
    const payload: any = {
      title: normalizeTaskTitle(addTaskForm.title),
      status: addTaskForm.status,
      task_date: addTaskForm.task_date || todayISO(),
    }
    if (addTaskForm.client_id) payload.client_id = addTaskForm.client_id
    if (addTaskForm.service_id) payload.service_id = addTaskForm.service_id
    if (addTaskForm.billing_amount_inr) payload.billing_amount_inr = parseFloat(addTaskForm.billing_amount_inr as string) || 0

    const { data, error } = await supabase
      .from('tasks')
      .insert(payload)
      .select('id, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services!service_id(id, name)')
      .single()

    if (error) { setAddTaskError(error.message); setAddingTask(false); return }
    if (data) {
      setLocalTasks(prev => [data, ...prev])
      setShowAddTask(false)
      setAddTaskForm({ title: '', client_id: '', service_id: '', task_date: todayISO(), billing_amount_inr: '', status: 'pending' })
    }
    setAddingTask(false)
  }

  // ─────────────────────────────────────────────────────
  // RENDER — LIST VIEW
  // ─────────────────────────────────────────────────────
  if (view === 'list') {
    const pendingCount = localTasks.filter(t => !taskScoreMap[t.id] || taskScoreMap[t.id].size === 0).length
    const doneCount = localTasks.filter(t => taskScoreMap[t.id] && taskScoreMap[t.id].size > 0).length
    // Missing = task is marked 'done' but has no contribution_scores (only checks scores, not raw contributions)
    const missingCount = localTasks.filter(t => t.status === 'done' && !taskScoredSet.has(t.id)).length

    // Count of active filters inside the Filter popover (excludes statusFilter — that's the tabs row)
    const activeFilterCount =
      filterClients.length +
      filterServices.length +
      (filterDate ? 1 : 0) +
      (filterEmployee ? 1 : 0) +
      (myScope ? 1 : 0)
    const hasAnyFilter = activeFilterCount > 0 || hasSearch || statusFilter !== 'all'

    const headerActions = (
      <>
        {/* Admin view toggle — matches Tasks header button sizing */}
        {canSeeFinancials && (
          <button onClick={() => setShowFinancials(f => !f)}
            title={showFinancials ? 'Switch to employee view' : 'Switch to admin view'}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 py-2 bg-secondary hover:bg-secondary/80 transition-colors">
            {showFinancials ? <Eye className="w-4 h-4 text-blue-400" /> : <EyeOff className="w-4 h-4 text-amber-400" />}
            <span className="hidden sm:inline">{showFinancials ? 'Admin' : 'Employee'}</span>
          </button>
        )}
        {/* Add task — matches Tasks Add Task button */}
        {canSeeFinancials && (
          <button onClick={() => setShowAddTask(true)}
            className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity">
            <Plus className="w-4 h-4" /> Add Task
          </button>
        )}
      </>
    )

    return (
      <PageShell>
        {bulkDeleteConfirm && (
          <ConfirmDialog
            title={`Move ${selectedTasks.size} task${selectedTasks.size === 1 ? '' : 's'} to Trash?`}
            body={`They can be restored from Tasks → Trash for 45 days. Contribution scores on them stop counting toward earnings, and pending payroll for any open month is recalculated. Paid payslips are not touched.`}
            confirmLabel="Move to Trash"
            danger
            onConfirm={() => { setBulkDeleteConfirm(false); void bulkDeleteTasks() }}
            onCancel={() => setBulkDeleteConfirm(false)}
          />
        )}
        <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
        <PageChrome>
          <Header
            title="Contributions"
            subtitle={`${localTasks.length} task${localTasks.length !== 1 ? 's' : ''}`}
            actions={headerActions}
          />

          <StickyToolbar>
          {/* Row 1: [Select] · [Search flex-1] · [List|Board|Calendar] · [⚙ board-only] */}
          <div className="flex flex-col lg:flex-row lg:items-center gap-1.5 lg:gap-2 w-full">
            {/* Left group: Select */}
            {canSeeFinancials && (
              <div className="flex items-center gap-1.5 shrink-0 order-2 sm:order-none hidden sm:flex">
                <button
                  onClick={() => { setBulkMode(m => !m); setSelectedTasks(new Set()) }}
                  className={`h-[34px] px-3 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 shadow-sm cursor-pointer ${
                    bulkMode
                      ? 'bg-violet-500 text-white shadow-violet-500/30'
                      : 'bg-secondary border border-border text-foreground hover:bg-secondary/60'
                  }`}>
                  <CheckCircle className="w-3 h-3" /> Select
                </button>
                {bulkMode && (() => {
                  const allSelected = myVisibleTasks.length > 0 && myVisibleTasks.every(t => selectedTasks.has(t.id))
                  return (
                    <button
                      onClick={() => {
                        if (allSelected) setSelectedTasks(new Set())
                        else setSelectedTasks(new Set(myVisibleTasks.map(t => t.id)))
                      }}
                      title={allSelected ? 'Deselect all visible tasks' : 'Select all visible tasks'}
                      className={`h-[34px] px-3 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 shadow-sm cursor-pointer ${
                        allSelected
                          ? 'bg-violet-500/20 border border-violet-500/40 text-violet-700 dark:text-violet-200'
                          : 'bg-secondary border border-border text-foreground hover:bg-secondary/60'
                      }`}
                    >
                      {allSelected ? <Check className="w-3 h-3" /> : <span className="w-3 h-3 rounded-sm border border-current opacity-60" />}
                      All ({myVisibleTasks.length})
                    </button>
                  )
                })()}
              </div>
            )}

            <div className="w-full lg:w-auto lg:flex-1 shrink-0">
              <TokenizedSearch
                className="w-full"
                facets={searchFacets}
                onFacetsChange={setSearchFacets}
                draft={searchDraft}
                onDraftChange={setSearchDraft}
                placeholder="Search tasks, clients, services, code…"
                resultCount={filteredTasks.length}
                resultNoun="task"
                fields={[
                  { key: 'title', label: 'Title', type: 'text' },
                  { key: 'client', label: 'Client', type: 'text' },
                  { key: 'service', label: 'Service', type: 'text' },
                  { key: 'task', label: 'Task #', type: 'number' },
                  ...(showBilling ? [{ key: 'amount', label: 'Amount ₹', type: 'number' as const }] : []),
                ]}
              />
            </div>

            {/* Filters Row (Mobile focused horizontally scrollable) */}
            <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar w-full lg:w-auto shrink-0 pb-1 lg:pb-0 [&>*]:shrink-0">
              {/* My Tasks / Not Assigned to Me — available to anyone with an employee
                  record (admins can be assignees/contributors too, not just employees). */}
              {currentEmployee && (
                <>
                  <button
                    onClick={() => setMyScope(s => s === 'mine' ? null : 'mine')}
                    title="Tasks assigned to or contributed by me"
                    className={`h-[34px] px-3 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
                      myScope === 'mine'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-secondary text-muted-foreground border-foreground/15 hover:text-foreground hover:bg-foreground/5'
                    }`}
                  >
                    My Tasks
                  </button>
                  <button
                    onClick={() => setMyScope(s => s === 'not_mine' ? null : 'not_mine')}
                    title="Tasks I'm not assigned to or haven't contributed to — see what's not mine"
                    className={`h-[34px] px-3 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
                      myScope === 'not_mine'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-secondary text-muted-foreground border-foreground/15 hover:text-foreground hover:bg-foreground/5'
                    }`}
                  >
                    Not Assigned to Me
                  </button>
                </>
              )}

              {/* Mobile Filters Toggle */}
              <button
                onClick={() => setShowMobileFilters(f => !f)}
                className={`sm:hidden h-[34px] px-3 rounded-xl text-xs font-medium border transition-colors cursor-pointer flex items-center gap-1.5 ${
                  showMobileFilters || hasAnyFilter
                    ? 'bg-foreground/10 border-foreground/20 text-foreground'
                    : 'bg-secondary border-foreground/15 text-muted-foreground hover:text-foreground'
                }`}
              >
                <MoreVertical size={14} /> Filters
              </button>
            </div>

            {/* View segment */}
            <div ref={boardSettingsRef} className={`relative shrink-0 order-3 sm:order-none ${role === 'employee' ? 'hidden sm:block' : ''}`}>
              <div className="hidden sm:flex items-center bg-secondary border border-foreground/15 rounded-xl p-1 gap-0.5">
                {([
                  { key: 'list',     Icon: List,         label: 'List',     hideOnMobile: false },
                  { key: 'board',    Icon: LayoutGrid,   label: 'Board',    hideOnMobile: false },
                  { key: 'calendar', Icon: CalendarDays, label: 'Calendar', hideOnMobile: true  },
                ] as const).map(({ key, Icon, label, hideOnMobile }) => (
                  <span key={key} className={`flex items-center ${hideOnMobile ? 'hidden sm:flex' : ''}`}>
                    <button
                      onClick={() => setListViewMode(key)}
                      className={`cursor-pointer px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                        listViewMode === key
                          ? 'bg-foreground/10 text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                    </button>
                    {key === 'board' && listViewMode === 'board' && (
                      <button
                        onClick={() => setShowBoardSettings(v => !v)}
                        title="Board settings"
                        className={`ml-0.5 px-2 py-1.5 rounded-lg flex items-center justify-center transition-colors ${
                          showBoardSettings
                            ? 'bg-foreground/10 text-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]'
                        }`}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {listViewMode === 'board' && showBoardSettings && (
                <div className="absolute right-0 top-full mt-1.5 z-50 bg-secondary border border-foreground/15 rounded-xl shadow-2xl p-3 min-w-[220px] space-y-3">
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">Group by</label>
                    <AppSelect value={boardGroupBy} onChange={e => setBoardGroupBy(e.target.value as typeof boardGroupBy)}>
                      <option value="status">Status</option>
                      <option value="employee">Employee</option>
                      <option value="client">Client</option>
                      <option value="service">Service</option>
                      <option value="date">Date</option>
                    </AppSelect>
                  </div>
                  {boardGroupBy === 'date' && (
                    <div>
                      <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">Date granularity</label>
                      <AppSelect value={boardDateGranularity} onChange={e => setBoardDateGranularity(e.target.value as typeof boardDateGranularity)}>
                        <option value="preset">Today · Week · Month</option>
                        <option value="daily">By day</option>
                        <option value="weekly">By week</option>
                        <option value="monthly">By month</option>
                      </AppSelect>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Advanced Filters Container (Collapsible on mobile) */}
          <div className={`${showMobileFilters ? 'flex flex-col gap-2 pt-2' : 'hidden'} sm:flex sm:flex-col sm:gap-2 sm:pt-0 w-full`}>
            {/* Row 2: Dropdowns */}
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <DateFilter value={filterDate} onChange={setFilterDate} />
              
              <FilterDropdown
                options={scopedEmployeeOptions}
                value={filterEmployee}
                onChange={v => { setFilterEmployee(v); setFilterEmployeeMode('worked') }}
                placeholder="Employee"
                sortKey="employees"
              />
              {filterEmployee && (
                <div className="flex items-center bg-secondary rounded-lg p-0.5 gap-0.5 border border-border/50 shrink-0">
                  <button type="button" onClick={() => setFilterEmployeeMode('worked')}
                    title="Tasks this employee worked on"
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-all ${filterEmployeeMode === 'worked' ? 'bg-primary text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                    Worked
                  </button>
                  <button type="button" onClick={() => setFilterEmployeeMode('solo')}
                    title="Sole contributor"
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-all ${filterEmployeeMode === 'solo' ? 'bg-amber-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                    Solo
                  </button>
                  <button type="button" onClick={() => setFilterEmployeeMode('any')}
                    title="Contributed or assigned"
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-all ${filterEmployeeMode === 'any' ? 'bg-primary text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                    + Assigned
                  </button>
                  {/* "Everyone else" — the inverse of the three modes above, so
                      one picker answers both "what did they do" and "what did
                      the rest of the team do without them". */}
                  <button type="button" onClick={() => setFilterEmployeeMode('without')}
                    title="Tasks everyone EXCEPT this person worked on"
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-all ${filterEmployeeMode === 'without' ? 'bg-rose-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                    Everyone else
                  </button>
                </div>
              )}
              <FilterDropdown
                multiple
                options={scopedClientOptions}
                value=""
                onChange={() => {}}
                values={filterClients}
                onToggle={toggleClient}
                onClear={() => setFilterClients([])}
                placeholder="Client"
                sortKey="clients"
              />
              <FilterDropdown
                multiple
                options={scopedServiceOptions}
                value=""
                onChange={() => {}}
                values={filterServices}
                onToggle={toggleService}
                onClear={() => setFilterServices([])}
                placeholder="Service"
                sortKey="services"
              />
              <FilterDropdown
                options={[
                  { value: 'today_first', label: 'Today First' },
                  { value: 'date_desc',   label: 'Newest' },
                  { value: 'date_asc',    label: 'Oldest' },
                  { value: 'amount_desc', label: 'Amount ↓' },
                  { value: 'client',      label: 'Client A→Z' },
                ]}
                value={sortBy === 'today_first' ? '' : sortBy}
                onChange={v => setSortBy((v || 'today_first') as typeof sortBy)}
                placeholder="Sort by"
              />

              {/* thin separator between filter dropdowns and status chips */}
              <span className="hidden sm:block w-px h-5 bg-foreground/10 shrink-0" />

              {/* Status chips — merged from former Row 3 */}
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as any)}
                className="sm:hidden h-[34px] px-2 rounded-xl text-xs font-medium bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer w-full"
              >
                <option value="all">All ({localTasks.length})</option>
                <option value="pending">Pending ({pendingCount})</option>
                <option value="done">Scored ({doneCount})</option>
                <option value="missing">Missing ({missingCount})</option>
              </select>
              {([
                { key: 'all',     label: 'All',     count: localTasks.length },
                { key: 'pending', label: 'Pending', count: pendingCount     },
                { key: 'done',    label: 'Scored',  count: doneCount        },
                { key: 'missing', label: 'Missing', count: missingCount     },
              ] as const).map(({ key, label, count }) => (
                <button key={key} onClick={() => setStatusFilter(key as any)}
                  className={`hidden sm:flex h-[34px] px-3 rounded-xl text-xs font-medium transition-colors items-center gap-1.5 cursor-pointer shrink-0 ${
                    statusFilter === key
                      ? key === 'missing'
                        ? 'bg-orange-500/20 text-orange-700 dark:text-orange-300 border border-orange-500/30'
                        : 'gradient-bg text-white'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                  }`}>
                  {label}
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                    statusFilter === key && key === 'missing' ? 'bg-orange-500/30 text-orange-700 dark:text-orange-300' :
                    statusFilter === key ? 'bg-foreground/20 text-white' : 'bg-border/50 opacity-60'
                  }`}>{count}</span>
                  {key === 'missing' && count > 0 && statusFilter !== 'missing' && (
                    <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                  )}
                </button>
              ))}
              {hasAnyFilter && (
                <button
                  onClick={() => { setSearchFacets([]); setSearchDraft(''); setFilterClients([]); setFilterServices([]); setFilterEmployee(''); setFilterEmployeeMode('worked'); setFilterDate(null); setStatusFilter('all'); setMyScope(null) }}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-foreground/[0.04] transition-colors flex items-center gap-1 shrink-0"
                >
                  <X size={12} /> Clear all
                </button>
              )}
            </div>
          </div>
        </StickyToolbar>
        </PageChrome>

        <PageContent>

          {/* ── Tokenized active filters (ERPNext-style chips) ── */}
          <ActiveFilterChips
            className="mb-3"
            chips={[
              // Search keywords show as pills inside the search bar itself, not here.
              ...(statusFilter !== 'all' ? [{ key: 'status', label: 'Status', value: statusFilter === 'missing' ? 'Needs scoring' : statusFilter[0].toUpperCase() + statusFilter.slice(1), onRemove: () => setStatusFilter('all') }] : []),
              // One chip per selected client / service (multi-value).
              ...filterClients.map((id: string) => ({ key: 'client:' + id, label: 'Client', value: clients.find((c: any) => c.id === id)?.name || 'Selected', onRemove: () => toggleClient(id) })),
              ...filterServices.map((id: string) => ({ key: 'service:' + id, label: 'Service', value: services.find((s: any) => s.id === id)?.name || 'Selected', onRemove: () => toggleService(id) })),
              ...(filterEmployee ? [{ key: 'employee', label: 'Employee', value: dn(employees.find((e: any) => e.id === filterEmployee)) || 'Selected', onRemove: () => { setFilterEmployee(''); setFilterEmployeeMode('worked') } }] : []),
              ...(filterDate ? [{ key: 'date', label: 'Date', value: getDateFilterLabel(filterDate), onRemove: () => setFilterDate(null) }] : []),
            ]}
            onClearAll={() => { setSearchFacets([]); setSearchDraft(''); setFilterClients([]); setFilterServices([]); setFilterEmployee(''); setFilterEmployeeMode('worked'); setFilterDate(null); setStatusFilter('all'); setMyScope(null) }}
          />

          {/* ── Missing-scores toast (bottom-right) — list view only ──
              text-orange-700 dark:text-orange-300/400 read fine on the dark theme's near-black backdrop
              but are far too pale against the light theme's white backdrop (same
              20%-opacity tinted background reads as pale-on-pale either way) —
              darker/more saturated base shades for light mode, original pale
              shades kept under dark: for the dark theme. */}
          {missingCount > 0 && listViewMode === 'list' && showMissingBanner && (
            <div className="fixed bottom-6 right-6 z-40 bg-orange-50 dark:bg-orange-950/90 backdrop-blur-md border border-orange-500/40 rounded-lg px-4 py-3 flex items-center gap-3 max-w-sm shadow-2xl">
              <AlertCircle className="w-4 h-4 text-orange-700 dark:text-orange-400 shrink-0" />
              <p className="text-xs text-orange-900 dark:text-orange-300 leading-relaxed flex-1">
                <span className="font-semibold">{missingCount} task{missingCount === 1 ? '' : 's'}</span> need scoring.{' '}
                <button onClick={() => setStatusFilter('missing')} className="underline hover:text-orange-700 dark:hover:text-orange-700 dark:text-orange-200 font-semibold">View</button>
              </p>
              <button onClick={() => setShowMissingBanner(false)} className="shrink-0 text-orange-700 hover:text-orange-900 dark:text-orange-400 dark:hover:text-orange-700 dark:text-orange-300">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── No employees warning ── */}
          {employees.length === 0 && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
              <Users className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">No employees found</p>
                <p className="text-xs text-amber-400/70 mt-0.5">
                  Add employees in{' '}
                  <Link href="/dashboard/payroll" className="underline hover:text-amber-700 dark:text-amber-300">HR &amp; Payroll</Link>
                  {' '}before recording contributions.
                </p>
              </div>
            </div>
          )}

          {/* ── Task list grouped by date ── */}
          {listViewMode === 'list' && (
          tasksByDate.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No tasks found</p>
              <p className="text-xs mt-1">Try changing your filters or add a new task</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Select-all row removed — "All" toggle button in toolbar replaces this */}
              {tasksByDate.map(([date, dateTasks]) => (
                <div key={date}>
                  <div className="flex items-center gap-3 mb-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{fmt(date)}</div>
                    <div className="flex-1 h-px bg-border" />
                    {showBilling && (() => {
                      const dayTotal = dateTasks.reduce((s, t) => s + (t.billing_amount_inr || 0), 0)
                      return dayTotal > 0 ? (
                        <span className="text-xs font-semibold text-foreground tabular-nums">₹{dayTotal.toLocaleString('en-IN')}</span>
                      ) : null
                    })()}
                    <span className="text-xs text-muted-foreground">{dateTasks.length} task{dateTasks.length !== 1 ? 's' : ''}</span>
                  </div>

                  <div className="space-y-2">
                    {dateTasks.map(task => {
                      const contributed = taskScoreMap[task.id]
                      const doneEmps = contributed ? [...contributed] : []

                      const isSelected = selectedTasks.has(task.id)
                      return (
                        <div key={task.id}
                          data-taskid={task.id}
                          onClick={() => {
                            if (bulkMode) {
                              setSelectedTasks(prev => {
                                const next = new Set(prev)
                                if (next.has(task.id)) next.delete(task.id)
                                else next.add(task.id)
                                return next
                              })
                            } else {
                              openTask(task)
                            }
                          }}
                          className={`hover-gradient-card bg-card border rounded-xl px-4 py-3.5 group select-none border-border`}>
                          {/* The action column is shrink-0, so on a phone it took ~130px
                              of a 366px card and left the content 202px. Everything then
                              wrapped: the title onto two lines, client and service onto
                              their own rows, and the contributor chips one per row —
                              CQID001 (64px) and CQID002 100% (115px) could not share a
                              178px line. Below sm the content now takes the full width
                              and the buttons wrap beneath it. */}
                          <div className="flex flex-wrap sm:flex-nowrap items-start gap-x-3 gap-y-2">
                            {bulkMode && (
                              <div className="pt-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => setSelectedTasks(prev => {
                                    const next = new Set(prev)
                                    if (next.has(task.id)) next.delete(task.id)
                                    else next.add(task.id)
                                    return next
                                  })}
                                  className="w-4 h-4 rounded accent-violet-500 cursor-pointer"
                                />
                              </div>
                            )}
                            <div className={cn(
                              "basis-full sm:basis-auto sm:flex-1 min-w-0 flex flex-col items-start gap-0.5",
                              BRANDED_PILL_BASE_CLASS,
                              highlightedTaskId === task.id ? BRANDED_PILL_ACTIVE_CLASS : (bulkMode && isSelected) ? BRANDED_PILL_SELECTED_CLASS : ''
                            )}>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span
                                  title={`Task code · click to copy ${taskCode(task)}`}
                                  onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(taskCode(task)) }}
                                  className="text-[10px] font-mono font-semibold text-muted-foreground/60 bg-foreground/[0.04] border border-foreground/15 px-1.5 py-0.5 rounded shrink-0 cursor-pointer hover:text-foreground hover:border-foreground/25 transition-colors"
                                >
                                  {taskCode(task)}
                                </span>
                                <p className="font-semibold text-sm">{task.title}</p>
                                <StatusBadge done={doneEmps.length} total={employeesForTask(task).length} />
                              </div>
                              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                                {task.client?.name && <span className="font-medium text-foreground/70">{task.client.name}{task.client?.code && <span className="ml-1 text-[10px] font-mono text-muted-foreground/50">{task.client.code}</span>}</span>}
                                {task.client?.name && task.service?.name && <span>·</span>}
                                {task.service?.name && <span>{task.service.name}</span>}
                                {/* Qty is not price data — visible to everyone, admin and employee alike. */}
                                {(task.quantity ?? 1) > 1 && (
                                  <><span>·</span><span className="font-medium text-violet-400/80">×{task.quantity} qty</span></>
                                )}
                                {canSeeFinancials && showFinancials && (task.billing_amount_inr || 0) > 0 && (
                                  <span className="inline-flex items-center gap-1">
                                    <span>·</span>
                                    <span className="font-semibold text-foreground">₹{(task.billing_amount_inr || 0).toLocaleString('en-IN')}</span>
                                  </span>
                                )}
                              </div>

                              {/* Tool tags — tools used on this task */}
                              {taskToolsMap[task.id]?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {taskToolsMap[task.id].map(toolId => {
                                    const tool = tools.find(t => t.id === toolId)
                                    return tool ? (
                                      <span key={toolId} className="text-[10px] bg-purple-500/10 border border-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded font-medium">
                                        {tool.name}
                                      </span>
                                    ) : null
                                  })}
                                </div>
                              )}

                              {/* Employee chips — buttons are valid inside a div */}
                              {employees.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-1.5 items-center" onClick={e => e.stopPropagation()}>
                                  {employeesForTask(task).map(emp => {
                                    const done = contributed?.has(emp.id)
                                    const assigned = taskAssignmentMap[task.id]?.has(emp.id)
                                    const scoreDetail = taskScoreDetailMap[task.id]?.[emp.id]
                                    const chipStyle = done
                                      ? 'bg-green-100 border-green-300 text-green-700 dark:bg-green-500/10 dark:border-green-500/20 dark:text-green-400'
                                      : assigned
                                        ? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-500/10 dark:border-blue-500/25 dark:text-blue-400'
                                        : 'bg-gray-100 border-gray-200 text-gray-400 dark:bg-secondary dark:border-transparent dark:text-muted-foreground/40'
                                    return (
                                      <button key={emp.id} type="button"
                                        onClick={showFinancials && !done ? () => toggleAssignment(task.id, emp.id) : undefined}
                                        title={showFinancials ? (done ? `${dn(emp)} contributed` : assigned ? `Unassign ${dn(emp)}` : `Assign ${dn(emp)}`) : undefined}
                                        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border transition-all ${chipStyle} ${showFinancials && !done ? 'hover:scale-105 cursor-pointer' : 'cursor-default'}`}>
                                        {done ? <Check className="w-2.5 h-2.5" /> : assigned ? <UserCheck className="w-2.5 h-2.5" /> : null}
                                        {dn(emp)}
                                        {done && scoreDetail && (
                                          <span className="font-semibold">
                                            {scoreDetail.pct.toFixed(0)}%
                                            {canSeeFinancials && showFinancials && scoreDetail.earnings !== null && (
                                              <span className="ml-0.5 text-green-600 dark:text-green-300">₹{Math.round(scoreDetail.earnings).toLocaleString('en-IN')}</span>
                                            )}
                                          </span>
                                        )}
                                      </button>
                                    )
                                  })}
                                  {showFinancials && (
                                    <span className="text-[10px] text-muted-foreground/35 ml-0.5">
                                      {taskAssignmentMap[task.id]?.size ? `${taskAssignmentMap[task.id].size} assigned` : 'click chip to assign'}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-1 shrink-0 ml-auto sm:ml-1" onClick={e => e.stopPropagation()}>
                              {/* Super admin: jump directly to task in Tasks page */}
                              {role === 'super_admin' && (
                                <a
                                  href={`/dashboard/tasks?highlight=${task.id}`}
                                  title={`Open "${task.title}" in Tasks`}
                                  onClick={e => e.stopPropagation()}
                                  className="p-1.5 rounded-md text-muted-foreground/50 hover:text-violet-400 hover:bg-violet-500/10 transition-all">
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                              {/* Same per-task discussion room as Tasks and
                                  Requests — scoring a contribution is exactly
                                  when you need to ask about the work. */}
                              <DiscussButton entityType="task" entityId={task.id} variant="icon"
                                label="Discuss this task" panelTitle={task.title} />
                              <button type="button"
                                onClick={() => openEditTask(task)}
                                title="Edit task details"
                                className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-secondary transition-all">
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button type="button"
                                onClick={() => handleDuplicateTask(task)}
                                title="Duplicate task to today"
                                disabled={duplicatingTaskId === task.id}
                                className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-secondary transition-all disabled:opacity-40">
                                {duplicatingTaskId === task.id
                                  ? <span className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin inline-block" />
                                  : <Copy className="w-3.5 h-3.5" />
                                }
                              </button>
                              <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              
              {/* Load More Button for Mobile */}
              {myVisibleTasks.length > mobileLimit && !hasSearch && !filterEmployee && (
                <button
                  onClick={() => setMobileLimit(l => l + 100)}
                  className="sm:hidden w-full mt-4 h-[44px] bg-secondary border border-border text-foreground hover:bg-secondary/60 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                >
                  Load More
                </button>
              )}
            </div>
          )
          )}

          {/* ── Board view ── */}
          {listViewMode === 'board' && (() => {
            const statusColor = (s: string) => {
              switch (s) {
                case 'done': return 'bg-green-500/15 text-green-400 border border-green-500/20'
                case 'in_progress': return 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
                case 'pending': return 'bg-amber-500/15 text-amber-400 border border-amber-500/20'
                case 'cancelled': return 'bg-red-500/15 text-red-400 border border-red-500/20'
                default: return 'bg-secondary text-muted-foreground border border-border'
              }
            }
            const statusLabel = (s: string) => {
              switch (s) {
                case 'done': return 'Done'
                case 'in_progress': return 'In Progress'
                case 'pending': return 'Pending'
                case 'cancelled': return 'Cancelled'
                default: return s || '—'
              }
            }
            type BoardCol = { key: string; title: string; color: string; badge: string; tasks: any[] }
            const colMap = new Map<string, BoardCol>()
            const cols: BoardCol[] = []
            const pushTo = (key: string, title: string, color: string, badge: string, task: any) => {
              if (!colMap.has(key)) {
                const col: BoardCol = { key, title, color, badge, tasks: [] }
                colMap.set(key, col); cols.push(col)
              }
              colMap.get(key)!.tasks.push(task)
            }

            myVisibleTasks.forEach(t => {
              if (boardGroupBy === 'employee') {
                const assignedIds = taskAssignmentMap[t.id] ? [...taskAssignmentMap[t.id]] : []
                const contribIds = taskScoreMap[t.id] ? [...taskScoreMap[t.id]] : []
                const allIds = [...new Set([...assignedIds, ...contribIds])]
                if (allIds.length === 0) {
                  pushTo('unassigned', 'Unassigned', 'bg-secondary border-border text-muted-foreground', '?', t)
                } else {
                  allIds.forEach(eId => {
                    const emp = employees.find(e => e.id === eId)
                    const title = emp ? dn(emp) : 'Unknown'
                    pushTo(eId, title, 'bg-violet-500/15 border-violet-500/20 text-violet-700 dark:text-violet-300', emp?.cqid || '•', t)
                  })
                }
              } else if (boardGroupBy === 'client') {
                const key = t.client?.id || 'unclient'
                const title = t.client?.name || 'No Client'
                pushTo(key, title, 'bg-cyan-500/15 border-cyan-500/20 text-cyan-700 dark:text-cyan-300', '•', t)
              } else if (boardGroupBy === 'service') {
                const key = t.service_id || 'noservice'
                const title = t.service?.name || 'No Service'
                pushTo(key, title, 'bg-emerald-500/15 border-emerald-500/20 text-emerald-700 dark:text-emerald-300', '•', t)
              } else if (boardGroupBy === 'status') {
                // Default: scoring-status (pending / partial / scored / missing)
                const scored = taskScoredSet.has(t.id)
                const hasAnyContrib = (taskScoreMap[t.id]?.size || 0) > 0
                if (t.status === 'done' && !scored && !hasAnyContrib) {
                  pushTo('missing', 'Missing (done, not scored)', 'bg-orange-500/15 border-orange-500/20 text-orange-400', '!', t)
                } else if (scored) {
                  pushTo('scored', 'Fully Scored', 'bg-green-500/15 border-green-500/20 text-green-400', '✓', t)
                } else if (hasAnyContrib) {
                  pushTo('partial', 'Partial Scoring', 'bg-blue-500/15 border-blue-500/20 text-blue-400', '½', t)
                } else {
                  pushTo('pending', 'Pending', 'bg-amber-500/15 border-amber-500/20 text-amber-400', '⋯', t)
                }
              } else if (boardGroupBy === 'date') {
                if (!t.task_date) {
                  pushTo('nodate', 'No Date', 'bg-secondary border-border text-muted-foreground', '•', t)
                  return
                }
                if (boardDateGranularity === 'preset') {
                  const todayD = new Date(); todayD.setHours(0, 0, 0, 0)
                  const taskD = new Date(t.task_date + 'T00:00:00'); taskD.setHours(0, 0, 0, 0)
                  const diff = Math.floor((taskD.getTime() - todayD.getTime()) / 86400000)
                  if (diff === 0) pushTo('today', 'Today', 'bg-violet-500/15 border-violet-500/20 text-violet-700 dark:text-violet-300', '★', t)
                  else if (diff > 0 && diff <= 7) pushTo('week', 'This Week', 'bg-blue-500/15 border-blue-500/20 text-blue-400', '⋯', t)
                  else if (diff > 7) pushTo('later', 'Later', 'bg-secondary border-border text-muted-foreground', '→', t)
                  else pushTo('past', 'Past', 'bg-secondary border-border text-muted-foreground', '·', t)
                } else if (boardDateGranularity === 'daily') {
                  pushTo(t.task_date, fmt(t.task_date), 'bg-cyan-500/15 border-cyan-500/20 text-cyan-700 dark:text-cyan-300', '·', t)
                } else if (boardDateGranularity === 'weekly') {
                  const d = new Date(t.task_date + 'T00:00:00')
                  const ws = new Date(d); ws.setDate(d.getDate() - d.getDay())
                  // `ws` is LOCAL midnight on the week's Sunday, so serialising
                  // it through UTC named the Saturday before — every week, not
                  // just some. The board grouped on that key and labelled the
                  // column "Week of <Saturday>".
                  const key = toISODate(ws)
                  pushTo(key, `Week of ${fmt(key)}`, 'bg-blue-500/15 border-blue-500/20 text-blue-700 dark:text-blue-300', 'W', t)
                } else if (boardDateGranularity === 'monthly') {
                  const key = t.task_date.substring(0, 7)
                  const title = new Date(t.task_date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' })
                  pushTo(key, title, 'bg-emerald-500/15 border-emerald-500/20 text-emerald-700 dark:text-emerald-300', 'M', t)
                }
              }
            })

            // Sort date columns chronologically when grouping by date (daily/weekly/monthly use ISO-like keys)
            if (boardGroupBy === 'date' && boardDateGranularity !== 'preset') {
              cols.sort((a, b) => a.key.localeCompare(b.key))
            }

            const visibleCols = cols.filter(c => c.tasks.length > 0)

            return (
              // Board scroll container — owns BOTH x and y scroll. Sticky column headers
              // (top-0 inside) work because this is the nearest scroll ancestor.
              // Height = viewport - sticky page header (92px) - sticky toolbar (~120px) - some padding.
              <div className="overflow-auto pb-4 h-[calc(100dvh-220px)]">
                <div className="flex gap-4 min-w-max">
                  {visibleCols.length === 0 && (
                    <p className="text-sm text-muted-foreground italic px-2 py-10">No tasks match the current filters.</p>
                  )}
                  {visibleCols.map(col => (
                    <div key={col.key} className="w-72 flex flex-col gap-3 shrink-0">
                      {/* Column header — sticky to top of board scroll container so it stays visible while scrolling cards */}
                      <div className="sticky top-0 z-10 flex items-center gap-2 px-1 py-2 bg-background/95 backdrop-blur-sm rounded-lg">
                        <div className={`w-7 h-7 rounded-full border flex items-center justify-center shrink-0 ${col.color}`}>
                          <span className="text-[10px] font-bold">{col.badge}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{col.title}</p>
                          <p className="text-[10px] text-muted-foreground">{col.tasks.length} task{col.tasks.length !== 1 ? 's' : ''}</p>
                        </div>
                      </div>

                      {/* Cards */}
                      <div className="space-y-2">
                        {col.tasks.map(task => {
                          const contributorIds = taskScoreMap[task.id] ? [...taskScoreMap[task.id]] : []
                          const assignedIds = taskAssignmentMap[task.id] ? [...taskAssignmentMap[task.id]] : []
                          return (
                            <button
                              key={task.id}
                              onClick={() => openTask(task)}
                              className="hover-gradient-card w-full text-left bg-card border rounded-xl p-3 border-border"
                            >
                              <div className="flex flex-col items-start gap-0.5 min-w-0">
                                <div className="flex items-center gap-1.5 mb-0.5">
                                  <span
                                    title={`Task code · click to copy ${taskCode(task)}`}
                                    onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(taskCode(task)) }}
                                    className="text-[9px] font-mono font-semibold text-muted-foreground/60 bg-foreground/[0.04] border border-foreground/15 px-1 py-0.5 rounded shrink-0 cursor-pointer hover:text-foreground hover:border-foreground/25 transition-colors"
                                  >
                                    {taskCode(task)}
                                  </span>
                                </div>
                                <p className="text-sm font-medium text-foreground leading-tight truncate">{task.title}</p>
                              </div>
                              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">{task.client?.name || '—'}{task.client?.code ? ` · ${task.client.code}` : ''}</span>
                                {task.service?.name && <span className="text-[10px] text-cyan-400/60">{task.service.name}</span>}
                                {(task.quantity ?? 1) > 1 && <span className="text-[10px] text-violet-400/80 font-medium">×{task.quantity} qty</span>}
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusColor(task.status)}`}>{statusLabel(task.status)}</span>
                                <span className="text-[10px] text-muted-foreground/50">{task.task_date}</span>
                              </div>
                              {/* Contributor + assignment chips */}
                              {(contributorIds.length > 0 || assignedIds.length > 0) && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {contributorIds.map(eId => {
                                    const e = employees.find(x => x.id === eId)
                                    if (!e) return null
                                    const isBulkImported = !rawContribTaskIds.has(task.id)
                                    return (
                                      <span key={'c' + eId} className={`text-[9px] ${isBulkImported ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' : 'bg-green-500/10 text-green-400 border-green-500/20'} border px-1.5 py-0.5 rounded-full`} title={isBulkImported ? 'Imported via Bulk Import' : ''}>
                                        ✓ {e.cqid} {isBulkImported && '(Imported)'}
                                      </span>
                                    )
                                  })}
                                  {assignedIds.filter(id => !contributorIds.includes(id)).map(eId => {
                                    const e = employees.find(x => x.id === eId)
                                    if (!e) return null
                                    return (
                                      <span key={'a' + eId} className="text-[9px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded-full">
                                        {e.cqid}
                                      </span>
                                    )
                                  })}
                                </div>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* ── Calendar view ── */}
          {listViewMode === 'calendar' && (() => {
            const firstDay = new Date(calViewYear, calViewMonth, 1)
            const lastDay = new Date(calViewYear, calViewMonth + 1, 0)
            const firstWeekday = firstDay.getDay()
            void lastDay
            const grid: { date: Date; inMonth: boolean }[] = []
            const start = new Date(calViewYear, calViewMonth, 1 - firstWeekday)
            for (let i = 0; i < 42; i++) {
              const d = new Date(start)
              d.setDate(start.getDate() + i)
              grid.push({ date: d, inMonth: d.getMonth() === calViewMonth })
            }
            const tasksByDateMap = new Map<string, typeof localTasks>()
            myVisibleTasks.forEach(t => {
              if (!t.task_date) return
              if (!tasksByDateMap.has(t.task_date)) tasksByDateMap.set(t.task_date, [])
              tasksByDateMap.get(t.task_date)!.push(t)
            })
            const monthLabel = firstDay.toLocaleString('en-US', { month: 'long', year: 'numeric' })
            const today = new Date(); today.setHours(0, 0, 0, 0)
            const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

            return (
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        let y = calViewYear, m = calViewMonth - 1
                        if (m < 0) { m = 11; y -= 1 }
                        setCalViewYear(y); setCalViewMonth(m)
                      }}
                      className="p-1.5 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        const n = new Date()
                        setCalViewYear(n.getFullYear()); setCalViewMonth(n.getMonth())
                      }}
                      className="text-xs px-3 py-1.5 rounded-lg border border-foreground/15 hover:border-foreground/25 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Today
                    </button>
                    <button
                      onClick={() => {
                        let y = calViewYear, m = calViewMonth + 1
                        if (m > 11) { m = 0; y += 1 }
                        setCalViewYear(y); setCalViewMonth(m)
                      }}
                      className="p-1.5 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  <h3 className="text-sm font-semibold">{monthLabel}</h3>
                  <span className="text-[10px] text-muted-foreground">{myVisibleTasks.length} task{myVisibleTasks.length !== 1 ? 's' : ''} this view</span>
                </div>

                <div className="grid grid-cols-7 border-b border-border bg-secondary/30">
                  {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                    <div key={d} className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-center">{d}</div>
                  ))}
                </div>

                <div className="grid grid-cols-7">
                  {grid.map((cell, i) => {
                    const key = ymd(cell.date)
                    const dayTasks = tasksByDateMap.get(key) || []
                    const isToday = cell.date.getTime() === today.getTime()
                    return (
                      <div
                        key={i}
                        className={`min-h-[100px] border-r border-b border-border/40 p-1.5 ${!cell.inMonth ? 'bg-black/20 opacity-40' : ''} ${(i+1) % 7 === 0 ? 'border-r-0' : ''} ${i >= 35 ? 'border-b-0' : ''} ${isToday ? 'bg-primary/[0.06] ring-1 ring-inset ring-primary/30' : ''}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-[11px] font-medium ${isToday ? 'bg-primary text-white rounded-full w-5 h-5 flex items-center justify-center' : 'text-muted-foreground'}`}>
                            {cell.date.getDate()}
                          </span>
                          {dayTasks.length > 0 && (
                            <span className="text-[9px] bg-violet-500/15 text-violet-400 border border-violet-500/20 px-1 rounded-full">{dayTasks.length}</span>
                          )}
                        </div>
                        <div className="space-y-0.5">
                          {dayTasks.slice(0, 3).map(task => {
                            const scored = taskScoredSet.has(task.id)
                            return (
                              <button
                                key={task.id}
                                onClick={() => openTask(task)}
                                className={`w-full text-left text-[10px] truncate px-1.5 py-0.5 rounded transition-opacity hover:opacity-80 ${
                                  scored ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'
                                }`}
                                title={`${taskCode(task)} · ${task.title} — ${task.client?.name || ''}`}
                              >
                                <span className="opacity-60 mr-1 font-mono">{taskCode(task)}</span>{task.title}
                              </button>
                            )
                          })}
                          {dayTasks.length > 3 && <p className="text-[9px] text-muted-foreground px-1.5">+{dayTasks.length - 3} more</p>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </PageContent>

        {/* ── Edit Task Modal ── */}
        {editingTask && (
          <TaskEditModal
            task={editingTask}
            clients={clients}
            services={services}
            clientPricings={pricingMatrix.map(p => ({
              client_id: p.client_id,
              service_id: p.service_id,
              price: p.price ?? 0,
              currency: p.currency ?? 'INR',
              commission_percentage: p.commission_percentage ?? 0,
            }))}
            showFinancials={showFinancials}
            onSaved={(data) => setLocalTasks(prev => prev.map(t => t.id === data.id ? data : t))}
            onDeleted={(id) => setLocalTasks(prev => prev.filter(t => t.id !== id))}
            onClose={() => setEditingTask(null)}
          />
        )}

        {/* ── Add Task Modal ── */}
        {showAddTask && (
          <ModalOverlay onClose={() => { setShowAddTask(false); setAddTaskError('') }} sheetOnMobile>
            <div className="bg-card border border-border w-full h-full sm:h-auto sm:max-w-md sm:max-h-[90vh] shadow-2xl rounded-t-2xl sm:rounded-2xl flex flex-col">
              {/* Mobile drag-handle hint */}
              <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
                <div className="w-10 h-1 rounded-full bg-foreground/20" />
              </div>
              <div className="flex items-center justify-between px-5 py-3 sm:py-4 border-b border-border shrink-0">
                <div>
                  <h2 className="font-bold text-base">Add New Task</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Create a task to track contributions</p>
                </div>
                <button onClick={() => { setShowAddTask(false); setAddTaskError('') }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleAddTask} className="px-5 pt-4 pb-4 space-y-4 overflow-y-auto flex-1">
                {/* Title — autocomplete + correction (same as Tasks page) */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Task Title *</label>
                  <TitleAutocomplete
                    value={addTaskForm.title}
                    onChange={v => setAddTaskForm(f => ({ ...f, title: v }))}
                    required
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="e.g. Big Mid Week Offer Flyer"
                    localTitles={localTasks.map(t => t.title).filter(Boolean) as string[]}
                  />
                </div>

                {/* Date + Status row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Task Date</label>
                    <div className="relative">
                      <CalendarDays className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                      <input type="date"
                        value={addTaskForm.task_date}
                        onChange={e => setAddTaskForm(f => ({ ...f, task_date: e.target.value }))}
                        className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Status</label>
                    <AppSelect value={addTaskForm.status} onChange={e => setAddTaskForm(f => ({ ...f, status: e.target.value }))}>
                      <option value="pending">Pending</option>
                      <option value="in_progress">In Progress</option>
                      <option value="done">Done</option>
                    </AppSelect>
                  </div>
                </div>

                {/* Client + Service row — searchable comboboxes with add-new */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Client</label>
                    <Combobox
                      options={clientList.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                      value={addTaskForm.client_id}
                      onChange={id => setAddTaskForm(f => ({ ...f, client_id: id }))}
                      placeholder="Search client…"
                      sortKey="clients"
                      onAddNew={canCreateClient ? (q => setQuickCreate({ kind: 'client', query: q })) : undefined}
                      addNewLabel="Add client"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Service</label>
                    <Combobox
                      options={serviceList.map(s => ({ id: s.id, label: s.name }))}
                      value={addTaskForm.service_id}
                      onChange={id => setAddTaskForm(f => ({ ...f, service_id: id }))}
                      placeholder="Search service…"
                      sortKey="services"
                      onAddNew={canCreateService ? (q => setQuickCreate({ kind: 'service', query: q })) : undefined}
                      addNewLabel="Add service"
                    />
                  </div>
                </div>

                {/* Billing amount */}
                {showFinancials && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Billing Amount (₹)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">₹</span>
                      <input type="number" min="0" step="1"
                        value={addTaskForm.billing_amount_inr}
                        onChange={e => setAddTaskForm(f => ({ ...f, billing_amount_inr: e.target.value }))}
                        className="w-full bg-secondary border border-border rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        placeholder="0" />
                    </div>
                  </div>
                )}

                {addTaskError && (
                  <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{addTaskError}</p>
                )}

                {/* Sticky action footer */}
                <div className="sticky bottom-0 -mx-5 px-5 -mb-4 pb-4 pt-3 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 border-t border-border flex gap-3">
                  <button type="button" onClick={() => { setShowAddTask(false); setAddTaskError('') }}
                    className="flex-1 bg-secondary border border-border text-sm font-medium px-4 py-3 sm:py-2.5 rounded-lg hover:bg-secondary/80 transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={addingTask}
                    className="flex-1 gradient-bg text-white text-sm font-medium px-4 py-3 sm:py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2">
                    {addingTask ? (
                      <><span className="w-4 h-4 border-2 border-foreground/30 border-t-white rounded-full animate-spin" />Creating…</>
                    ) : (
                      <><PlusCircle className="w-4 h-4" />Create Task</>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </ModalOverlay>
        )}

        {/* Inline quick-create: Client */}
        {quickCreate?.kind === 'client' && (
          <QuickCreateClientModal
            initialName={quickCreate.query}
            canSeePricing={showFinancials}
            onClose={() => setQuickCreate(null)}
            onCreated={(client) => {
              setClientList(prev => [{ id: client.id, name: client.name, code: client.code }, ...prev])
              setAddTaskForm(f => ({ ...f, client_id: client.id }))
              setQuickCreate(null)
              toast.success(`Client "${client.name}" added`)
            }}
          />
        )}

        {/* Inline quick-create: Service */}
        {quickCreate?.kind === 'service' && (
          <QuickCreateServiceModal
            initialName={quickCreate.query}
            canSeePricing={showFinancials}
            onClose={() => setQuickCreate(null)}
            onCreated={(service) => {
              setServiceList(prev => [...prev, { id: service.id, name: service.name }])
              setAddTaskForm(f => ({ ...f, service_id: service.id }))
              setQuickCreate(null)
              toast.success(`Service "${service.name}" added`)
            }}
          />
        )}

        {/* ── Bulk action toolbar ── */}
        {bulkMode && selectedTasks.size > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-2 duration-200">
            <div className="flex items-center gap-2 bg-secondary border border-foreground/20 rounded-2xl shadow-2xl shadow-black/60 px-4 py-3">
              <span className="text-xs font-semibold text-muted-foreground pr-2 border-r border-foreground/15">
                {selectedTasks.size} selected
              </span>
              <button onClick={() => bulkUpdateStatus('done')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 text-xs font-semibold transition-colors border border-emerald-500/20">
                <CheckCircle className="w-3.5 h-3.5" /> Mark Done
              </button>
              <button onClick={() => bulkUpdateStatus('pending')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 text-xs font-semibold transition-colors border border-amber-500/20">
                <Clock className="w-3.5 h-3.5" /> Mark Pending
              </button>
              {canSeeFinancials && (
                <button onClick={() => setBulkDeleteConfirm(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/15 text-red-400 hover:bg-red-500/25 text-xs font-semibold transition-colors border border-red-500/20">
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              )}
              <button onClick={() => { setSelectedTasks(new Set()); setBulkMode(false) }}
                className="ml-1 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </PageShell>
    )
  }

  // ─────────────────────────────────────────────────────
  // RENDER — ENTRY VIEW
  // ─────────────────────────────────────────────────────
  const totalEarnings = calculatedResult
    ? calculatedResult.employeeEarnings.reduce((s: number, e: any) => s + e.earnings, 0)
    : 0

  return (
    <div className="flex flex-col min-h-full">

      {/* ── Sticky top nav bar ── */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-md border-b border-border">

        {/* Main nav row */}
        <div className="px-6 py-3 flex items-center gap-3">
          <button onClick={() => setView('list')}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          {/* Draft saved indicator */}
          {draftSaved && (
            <span className="text-[11px] text-muted-foreground/60 flex items-center gap-1 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400/60" />
              Draft saved
            </span>
          )}
          <div className="w-px h-5 bg-border shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {selectedTask?.id && (
                <span
                  title={`Task code · click to copy ${taskCode(selectedTask)}`}
                  onClick={() => navigator.clipboard?.writeText(taskCode(selectedTask))}
                  className="text-[10px] font-mono font-semibold text-muted-foreground/70 bg-foreground/[0.04] border border-foreground/15 px-1.5 py-0.5 rounded shrink-0 cursor-pointer hover:text-foreground hover:border-foreground/25 transition-colors"
                >
                  {taskCode(selectedTask)}
                </span>
              )}
              <p className="font-semibold text-sm truncate leading-tight">{selectedTask?.title}</p>
            </div>
            <p className="text-[11px] text-muted-foreground truncate leading-tight">
              {[selectedTask?.client?.name, selectedTask?.service?.name].filter(Boolean).join(' · ')}
              {(selectedTask?.quantity ?? 1) > 1 && <> · ×{selectedTask.quantity} qty</>}
              {canSeeFinancials && showFinancials && (selectedTask?.billing_amount_inr || 0) > 0 && (
                <> · ₹{(selectedTask?.billing_amount_inr || 0).toLocaleString('en-IN')}</>
              )}
            </p>
          </div>
          {/* Assigned employee avatars */}
          {selectedTask && taskAssignmentMap[selectedTask.id]?.size > 0 && (
            <div className="flex -space-x-1.5 shrink-0">
              {employees
                .filter(e => taskAssignmentMap[selectedTask.id]?.has(e.id))
                .slice(0, 4)
                .map(emp => (
                  <div key={emp.id} title={dn(emp)}
                    className="w-7 h-7 rounded-full gradient-bg flex items-center justify-center text-white text-[10px] font-bold border-2 border-background">
                    {emp.cqid?.replace('CQID', '') || '?'}
                  </div>
                ))}
            </div>
          )}
          {canSeeFinancials && (
            <button onClick={() => setShowFinancials(f => !f)}
              title={showFinancials ? 'Employee view (hide financials)' : 'Admin view (show financials)'}
              className="shrink-0 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 py-1.5 transition-colors">
              {showFinancials ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> Admin</>}
            </button>
          )}
        </div>

        {/* Pool-basis warning — shows when the pool basis is 0 but contributions are entered */}
        {canSeeFinancials && showFinancials && calculatedResult && (selectedTask?.billing_amount_inr || 0) === 0 && (
          <div className="px-6 py-2 bg-amber-500/10 border-t border-amber-500/25 flex items-center gap-2">
            <span className="text-[11px] text-amber-400 font-medium">
              ⚠ No billing amount set on this task — commission will be ₹0. Edit the task to add a billing amount first.
            </span>
          </div>
        )}

        {/* Commission summary bar — admin only, always visible */}
        {canSeeFinancials && showFinancials && (
          <div className="px-6 py-2 bg-card/40 border-t border-border/40 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-muted-foreground">Commission:</span>
              <span className="text-xs font-bold">{serviceCommPct}%</span>
              {predefinedCommPct !== null && serviceCommPct === predefinedCommPct ? (
                <span className="text-[9px] bg-green-500/10 border border-green-500/20 text-green-400 px-1.5 py-0.5 rounded font-medium">pre-defined</span>
              ) : predefinedCommPct !== null ? (
                <span className="text-[9px] bg-amber-500/10 border border-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded font-medium">overridden</span>
              ) : null}
              <span className="text-[11px] text-muted-foreground">→ pool</span>
              <span className="text-xs font-bold gradient-text">
                ₹{((selectedTask?.billing_amount_inr || 0) * serviceCommPct / 100).toLocaleString('en-IN')}
              </span>
            </div>
            <button type="button" onClick={() => setShowCommOverride(v => !v)}
              className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground underline underline-offset-2 transition-colors">
              {showCommOverride ? 'cancel' : 'override rate'}
            </button>
            {/* Live per-employee earnings in the header */}
            {calculatedResult && (
              <div className="ml-auto flex items-center gap-3 flex-wrap">
                {calculatedResult.employeeEarnings.map((e: any) => {
                  const emp = employees.find((em: any) => em.id === e.employeeId)
                  return (
                    <span key={e.employeeId} className="text-[11px] font-semibold text-green-400">
                      {emp ? dn(emp) : '?'} · ₹{e.earnings.toFixed(0)}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Scrollable content ── */}
      <div className="p-6 space-y-5 pb-28">

        {/* Commission override panel */}
        {canSeeFinancials && showFinancials && showCommOverride && (
          <div className="bg-card border border-amber-500/20 rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Override Commission Rate
            </p>
            <p className="text-[11px] text-muted-foreground">
              {predefinedCommPct !== null
                ? `Pre-defined rate for this client / service: ${predefinedCommPct}%`
                : 'No pre-defined rate for this client / service combination.'}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {[30, 40, 50, 60].map(p => (
                <button key={p} type="button" onClick={() => setServiceCommPct(p)}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${serviceCommPct === p ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
                  {p}%
                </button>
              ))}
              <input type="number" min="0" max="100" step="1" value={serviceCommPct}
                onChange={e => setServiceCommPct(parseFloat(e.target.value) || 0)}
                className="w-16 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="%" />
              {predefinedCommPct !== null && serviceCommPct !== predefinedCommPct && (
                <button type="button" onClick={() => setServiceCommPct(predefinedCommPct)}
                  className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-lg hover:bg-secondary transition-colors border border-transparent hover:border-border">
                  Reset to {predefinedCommPct}%
                </button>
              )}
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground mb-1.5 block">
                Reason for override{predefinedCommPct !== null ? ' *' : ' (optional)'}
              </label>
              <input value={commOverrideReason} onChange={e => setCommOverrideReason(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="e.g. Special project rate, client negotiation…" />
            </div>
          </div>
        )}

        {/* Bulk imported scores notice */}
        {importedScores.length > 0 && !Object.keys(contributions).length && (
          <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 space-y-3">
            <h3 className="text-orange-400 font-semibold text-sm flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400" /> Imported via Bulk Import
            </h3>
            <p className="text-xs text-muted-foreground">
              This task has pre-calculated contribution percentages from a bulk import. No parameters were filled out.
              Saving new parameters below will overwrite these imported scores.
            </p>
            <div className="flex flex-wrap gap-2">
              {importedScores
                // Employees only see their own contribution row here. The full
                // distribution is admin-only — leaking other contributors'
                // names or percentages would breach privacy hardening, and
                // the server only loads the current user's employee row for
                // employees so unresolved rows would render as a 4-char ID
                // hash, which is both ugly and a fragment leak.
                .filter(s => role !== 'employee' || s.employee_id === currentEmployee?.id)
                .map((s, i) => {
                  const emp = employees.find((e: any) => e.id === s.employee_id)
                  // For admins: any unresolved row points to a deleted/archived
                  // employee — render a clean placeholder, not an id fragment.
                  const label = emp ? dn(emp) : 'Unknown member'
                  return (
                    <span key={i} className="bg-secondary border border-border px-3 py-1.5 rounded-lg text-xs font-medium">
                      {label} <span className="text-primary ml-1">{s.score_percentage}%</span>
                      {showFinancials && s.earnings_inr > 0 && <span className="opacity-60 ml-1">(₹{Math.round(s.earnings_inr)})</span>}
                    </span>
                  )
                })}
            </div>
          </div>
        )}

        {/* Assigned employees strip */}
        {selectedTask && (() => {
          const assignedIds = taskAssignmentMap[selectedTask.id]
          if (!assignedIds?.size) return null
          const assignedEmps = employees.filter(e => assignedIds.has(e.id))
          return (
            <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-muted-foreground/60 flex items-center gap-1 shrink-0">
                <UserCheck className="w-3 h-3" /> Assigned:
              </span>
              {assignedEmps.map(emp => (
                <span key={emp.id} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 font-medium">
                  {dn(emp)}
                </span>
              ))}
            </div>
          )
        })()}

        {/* ── Tools ── */}
        {filteredTools.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Tools Used</p>
            <div className="flex flex-wrap gap-2">
              {filteredTools.map(tool => {
                const used = toolsUsed[tool.id] || false
                return (
                  <button key={tool.id} type="button"
                    onClick={() => setToolsUsed(prev => ({ ...prev, [tool.id]: !prev[tool.id] }))}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                      used ? 'bg-purple-500/15 border-purple-500/30 text-purple-700 dark:text-purple-300' : 'bg-secondary border-transparent text-muted-foreground hover:border-border'
                    }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${used ? 'bg-purple-400' : 'bg-muted-foreground/40'}`} />
                    {tool.name}
                    {showFinancials && <span className="text-xs opacity-60">−{tool.fixed_percentage}%</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── No employees guide ── */}
        {employees.length === 0 && (
          <div className="bg-card border border-border rounded-xl p-8 text-center">
            <Users className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
            <p className="font-semibold text-sm mb-1">No employees set up yet</p>
            <p className="text-xs text-muted-foreground mb-4">
              You need to add employees before recording contributions.
            </p>
            <Link href="/dashboard/payroll"
              className="inline-flex items-center gap-2 gradient-bg text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:opacity-90 transition-opacity">
              <PlusCircle className="w-4 h-4" /> Go to HR &amp; Payroll
            </Link>
          </div>
        )}

        {/* ── Employee cards ── */}
        {scopedEmployees.length > 0 && (
          <div className="space-y-2">
            {scopedEmployees.map(emp => {
              const isExpanded = expandedEmployees.has(emp.id)
              const isOwnScope = !canViewAll
              const groupSummary = groupedParams
                .filter(g => activeGroups.has(`${emp.id}:${g.id}`))
                .map(g => {
                  const mv = contributions[g.master?.id]?.[emp.id] || 0
                  const st = g.subs.reduce((s: number, p: any) => s + (contributions[p.id]?.[emp.id] || 0), 0)
                  const isPct = (g.master?.input_type || 'count') === 'percentage'
                  return { name: g.name, masterVal: mv, subTotal: st, isPct }
                })
                .filter(g => g.masterVal > 0 || g.subTotal > 0)

              return (
                <div key={emp.id} className={`bg-card border rounded-xl overflow-hidden transition-all ${isExpanded || isOwnScope ? 'border-primary/20' : 'border-border'}`}>

                  {/* Own-scope: static header — card always open, no toggle needed */}
                  {isOwnScope ? (
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
                      <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0">
                        {emp.cqid?.replace('CQID', '') || '?'}
                      </div>
                      <div>
                        <p className="font-semibold text-sm">{dn(emp)}</p>
                        <p className="text-xs text-muted-foreground">{emp.cqid}</p>
                      </div>
                    </div>
                  ) : (
                    <button type="button"
                      onClick={() => setExpandedEmployees(prev => { const n = new Set(prev); n.has(emp.id) ? n.delete(emp.id) : n.add(emp.id); return n })}
                      className={cn("w-full flex items-center justify-between px-4 py-3.5", ROW_INTERACTIVE_CLASS)}>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0">
                          {emp.cqid?.replace('CQID', '') || '?'}
                        </div>
                        <div className="text-left min-w-0">
                          <p className="font-semibold text-sm">{dn(emp)}</p>
                          <p className="text-xs text-muted-foreground">{emp.cqid}</p>
                        </div>
                        {groupSummary.length > 0 && (
                          <div className="flex gap-1.5 ml-1 flex-wrap">
                            {groupSummary.map(g => (
                              <span key={g.name} className="text-xs bg-primary/15 text-primary px-2 py-0.5 rounded-full font-medium whitespace-nowrap">
                                {g.name.replace(' Group', '')}: {g.masterVal > 0 ? `${g.masterVal}${g.isPct ? '%' : ''}` : '—'}
                                {g.subTotal > 0 && <span className="opacity-70"> +{g.subTotal}</span>}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {(() => {
                          const saved = selectedTask && scores.find(s => s.task_id === selectedTask.id && s.employee_id === emp.id && s.score_percentage > 0)
                          if (saved) return (
                            <span className="flex items-center gap-1 text-xs font-semibold text-primary/80">
                              {saved.score_percentage.toFixed(1)}%
                              {canSeeFinancials && showFinancials && (saved.earnings_inr ?? 0) > 0 && (
                                <span className="text-green-400">₹{Math.round(saved.earnings_inr!).toLocaleString('en-IN')}</span>
                              )}
                            </span>
                          )
                          if (!groupSummary.length) return <span className="text-xs text-muted-foreground/50">tap to expand</span>
                          return null
                        })()}
                        {isExpanded ? <ChevronLeft className="w-4 h-4 text-muted-foreground rotate-90" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                      </div>
                    </button>
                  )}

                  {(isExpanded || isOwnScope) && (
                    <div className="border-t border-border p-4 space-y-2">
                      {groupedParams.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-4">
                          No contribution groups with parameters are available for this service. Configure in{' '}
                          <Link href="/dashboard/settings" className="underline hover:text-foreground">Settings</Link>.
                        </p>
                      )}
                      {/* Per-employee summary — instant feedback without scrolling to the breakdown */}
                      {groupedParams.length > 0 && (() => {
                        const used = groupedParams.reduce((acc, g) =>
                          acc + g.params.filter((p: any) => (contributions[p.id]?.[emp.id] || 0) > 0).length, 0)
                        const liveEmp = calculatedResult?.employeeEarnings.find((e: any) => e.employeeId === emp.id)
                        return (
                          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap rounded-xl border border-border bg-secondary/30 px-3 py-2 text-xs">
                            <span className="text-muted-foreground">Used <span className="font-semibold text-foreground">{used}</span></span>
                            {liveEmp && <span className="text-muted-foreground">Score <span className="font-semibold text-primary">{liveEmp.scorePercentage.toFixed(1)}%</span></span>}
                            {canSeeFinancials && liveEmp && (
                              <span className="text-muted-foreground">Earns <span className="font-semibold text-green-600 dark:text-green-400">₹{Math.round(liveEmp.earnings).toLocaleString('en-IN')}</span></span>
                            )}
                            {taskLastSaved && <span className="text-muted-foreground/70 ml-auto">Saved {taskLastSaved}</span>}
                          </div>
                        )
                      })()}

                      {rankGroups(emp.id, groupedParams).map(({ g: group, isMostUsed }) => {
                        const groupKey = `${emp.id}:${group.id}`
                        const isGroupOn = activeGroups.has(groupKey)
                        const master = group.master
                        const masterVal = contributions[master?.id]?.[emp.id] || 0
                        const isPct = (master?.input_type || 'count') === 'percentage'
                        const subActiveCount = group.subs.filter((p: any) =>
                          (contributions[p.id]?.[emp.id] || 0) > 0 || activeSubParams.has(`${emp.id}:${p.id}`)
                        ).length
                        const totalP = group.params.length
                        const doneP = group.params.filter((p: any) => (contributions[p.id]?.[emp.id] || 0) > 0).length
                        const progressPct = totalP ? (doneP / totalP) * 100 : 0

                        return (
                          <div key={group.id}
                            className={`rounded-xl border transition-all ${isGroupOn ? 'border-primary/25 bg-primary/[0.03]' : 'border-border bg-secondary/20'}`}>

                            <button type="button" onClick={() => toggleGroup(emp.id, group.id)}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left">
                              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                                isGroupOn ? 'border-primary bg-primary' : 'border-muted-foreground/30 hover:border-muted-foreground'
                              }`}>
                                {isGroupOn && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className={`text-sm font-semibold ${isGroupOn ? 'text-foreground' : 'text-muted-foreground'}`}>
                                    {group.name}
                                  </p>
                                  {isMostUsed && (
                                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-300 border border-blue-500/25 whitespace-nowrap">
                                      🔥 Most Used
                                    </span>
                                  )}
                                  <span className="text-[10px] text-muted-foreground shrink-0">{doneP}/{totalP}</span>
                                </div>
                                {/* progress bar */}
                                <div className="mt-1.5 h-1 w-full max-w-[170px] rounded-full bg-foreground/10 overflow-hidden">
                                  <div className="h-full rounded-full bg-blue-500 dark:bg-blue-400 transition-all" style={{ width: `${progressPct}%` }} />
                                </div>
                              </div>
                              {isGroupOn && masterVal > 0 && (
                                <span className="text-xs font-semibold gradient-text shrink-0">
                                  {masterVal}{isPct ? '%' : ' items'}
                                  {subActiveCount > 0 && ` · ${subActiveCount} rev`}
                                </span>
                              )}
                            </button>

                            {isGroupOn && (
                              <div className="px-4 pb-4 space-y-4 border-t border-border/50 pt-4">
                                {master && (
                                  <div>
                                    <div className="flex items-center gap-2 mb-2">
                                      <span className="text-sm font-semibold">{master.name}</span>
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                                        isPct ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-secondary text-muted-foreground border-border'
                                      }`}>
                                        {isPct ? '% effort' : '# count'}
                                      </span>
                                      {masterVal > 0 && (
                                        <span className="ml-auto text-lg font-bold gradient-text">
                                          {masterVal}{isPct ? '%' : ''}
                                        </span>
                                      )}
                                    </div>
                                    {isPct ? (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        {[25, 50, 75, 100].map(pct => (
                                          <button key={pct} type="button"
                                            onClick={() => setContrib(master.id, emp.id, masterVal === pct ? 0 : pct)}
                                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                                              masterVal === pct ? 'gradient-bg text-white shadow-sm' : 'bg-secondary text-muted-foreground hover:text-foreground'
                                            }`}>
                                            {pct}%
                                          </button>
                                        ))}
                                        <input type="number" min="0" max="100" step="1"
                                          value={masterVal || ''}
                                          onChange={e => setContrib(master.id, emp.id, parseInt(e.target.value) || 0)}
                                          className="w-16 bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
                                          placeholder="custom" />
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-2">
                                        <button type="button" onClick={() => setContrib(master.id, emp.id, Math.max(0, masterVal - 1))}
                                          disabled={masterVal === 0}
                                          className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center hover:bg-secondary/60 active:scale-90 disabled:opacity-30 disabled:active:scale-100 transition-all">
                                          <Minus className="w-4 h-4" />
                                        </button>
                                        <input type="number" inputMode="numeric" min="0" step="1"
                                          value={masterVal || ''}
                                          onChange={e => setContrib(master.id, emp.id, parseInt(e.target.value) || 0)}
                                          className="w-16 h-10 bg-background border border-border rounded-lg px-2 text-base text-center font-bold focus:outline-none focus:ring-2 focus:ring-primary/50"
                                          placeholder="0" />
                                        <button type="button" onClick={() => setContrib(master.id, emp.id, masterVal + 1)}
                                          className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center hover:bg-secondary/60 active:scale-90 transition-all">
                                          <Plus className="w-4 h-4" />
                                        </button>
                                        <span className="text-xs text-muted-foreground">items</span>
                                      </div>
                                    )}
                                  </div>
                                )}

                                {group.subs.length > 0 && (() => {
                                  const { frequent, rest } = rankSubParams(emp.id, group.subs)
                                  const expandKey = `${emp.id}:${group.id}`
                                  const showAll = expandedSubGroups.has(expandKey)
                                  const visible = showAll ? [...frequent, ...rest] : frequent

                                  // One full-width row per parameter: name on the left, a large
                                  // −/N/+ stepper on the right. Big tap targets work on phone and
                                  // desktop alike; active rows glow amber so progress is obvious.
                                  const Row = (param: any) => {
                                    const count = contributions[param.id]?.[emp.id] || 0
                                    return (
                                      <div key={param.id}
                                        className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${
                                          count > 0
                                            ? 'border-blue-500/40 bg-blue-50/80 dark:bg-blue-950/30 dark:border-blue-800 border-l-4 border-l-blue-500 dark:border-l-blue-400'
                                            : 'border-border bg-secondary/20 hover:border-border/60 hover:bg-secondary/40'
                                        }`}>
                                        <span className={`flex-1 min-w-0 flex items-center gap-1.5 text-sm ${count > 0 ? 'font-semibold text-blue-900 dark:text-blue-100' : 'text-muted-foreground'}`}>
                                          {count > 0 && (
                                            <span className="w-4 h-4 rounded-full bg-blue-500 dark:bg-blue-400 flex items-center justify-center shrink-0">
                                              <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                                            </span>
                                          )}
                                          <span className="truncate">{param.name}</span>
                                        </span>
                                        <div className="flex items-center gap-1 shrink-0">
                                          <button type="button" aria-label={`Decrease ${param.name}`}
                                            onClick={() => setContrib(param.id, emp.id, Math.max(0, count - 1))}
                                            disabled={count === 0}
                                            className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center hover:bg-secondary/60 active:scale-90 disabled:opacity-30 disabled:active:scale-100 transition-all">
                                            <Minus className="w-4 h-4" />
                                          </button>
                                          <input type="number" inputMode="numeric" min="0" step="1"
                                            value={count || ''} placeholder="0"
                                            onChange={e => setContrib(param.id, emp.id, parseInt(e.target.value) || 0)}
                                            className={`w-12 h-9 bg-background border rounded-lg text-center text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                                              count > 0 ? 'border-blue-400 dark:border-blue-600 text-blue-900 dark:text-blue-100' : 'border-border text-foreground'
                                            }`} />
                                          <button type="button" aria-label={`Increase ${param.name}`}
                                            onClick={() => setContrib(param.id, emp.id, count + 1)}
                                            className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center hover:bg-secondary/60 active:scale-90 transition-all">
                                            <Plus className="w-4 h-4" />
                                          </button>
                                        </div>
                                      </div>
                                    )
                                  }

                                  return (
                                    <div>
                                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                                        {isPct ? 'Revisions received' : 'Items handled'}
                                      </p>
                                      <div className="space-y-1.5">
                                        {visible.map(Row)}
                                      </div>
                                      {rest.length > 0 && (
                                        <button type="button"
                                          onClick={() => setExpandedSubGroups(prev => {
                                            const n = new Set(prev); n.has(expandKey) ? n.delete(expandKey) : n.add(expandKey); return n
                                          })}
                                          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                                          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAll ? 'rotate-180' : ''}`} />
                                          {showAll ? 'Show fewer' : `${rest.length} more ${isPct ? 'revision' : 'item'}${rest.length !== 1 ? 's' : ''}`}
                                        </button>
                                      )}
                                    </div>
                                  )
                                })()}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── Commission Breakdown ── */}
        {calculatedResult && showFinancials && (
          <div className="rounded-2xl overflow-hidden shadow-xl shadow-green-500/5 border border-green-500/20">
            {/* Header */}
            <div className="px-5 py-4 bg-gradient-to-r from-green-500/10 to-emerald-500/5 border-b border-green-500/15 flex items-center gap-3">
              <div className="flex items-center gap-2 flex-1">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <h3 className="text-sm font-bold">Commission Breakdown</h3>
                <span className="text-[10px] bg-green-500/15 border border-green-500/20 text-green-400 px-1.5 py-0.5 rounded font-medium">Live</span>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-muted-foreground">Effective pool</p>
                <p className="text-sm font-bold gradient-text">
                  ₹{calculatedResult.remainingPool.toFixed(0)}
                  {calculatedResult.toolDeductions.length > 0 && (
                    <span className="text-[10px] font-normal text-muted-foreground ml-1">after deductions</span>
                  )}
                </p>
              </div>
            </div>

            {/* Tool deductions */}
            {calculatedResult.toolDeductions.length > 0 && (
              <div className="px-5 py-3 bg-red-500/5 border-b border-border flex flex-wrap gap-3">
                {calculatedResult.toolDeductions.map((d: any, i: number) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">{d.toolName}</span>
                    <span className="text-red-400 font-semibold">−₹{d.amount.toFixed(0)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Employee rows */}
            <div className="divide-y divide-border/50">
              {calculatedResult.employeeEarnings.map((e: any) => {
                const pct = Math.min(e.scorePercentage, 100)
                const emp = employees.find((em: any) => em.id === e.employeeId)
                return (
                  <div key={e.employeeId} className={cn("px-5 py-4 flex items-center gap-4", ROW_INTERACTIVE_CLASS)}>
                    <div className="w-10 h-10 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-sm">
                      {emp?.cqid?.replace('CQID', '') || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <p className="font-semibold text-sm">{dn(emp ?? { name: e.employeeName })}</p>
                        {emp?.performance_rating && (
                          <span className="text-[10px] bg-secondary border border-border px-1.5 py-0.5 rounded text-muted-foreground">
                            {emp.performance_rating}% rating
                          </span>
                        )}
                        {e.groupBreakdown?.length > 0 && e.groupBreakdown.map((g: any) => (
                          <span key={g.groupName} className="text-[10px] bg-secondary border border-border rounded px-1.5 py-0.5 text-muted-foreground">
                            {g.groupName.replace(' Group', '')}: {g.score.toFixed(0)}%
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-secondary rounded-full h-2">
                          <div className="h-2 rounded-full gradient-bg transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 w-9 text-right">{pct.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-green-400 text-xl leading-tight">₹{e.earnings.toFixed(0)}</p>
                      <p className="text-[10px] text-muted-foreground">earned</p>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Footer total */}
            <div className="px-5 py-3 bg-green-500/5 border-t border-green-500/15 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Total payable to employees</span>
              <div className="text-right">
                <span className="font-bold text-lg gradient-text">₹{totalEarnings.toFixed(0)}</span>
                <span className="text-xs text-muted-foreground ml-1.5">/ ₹{calculatedResult.remainingPool.toFixed(0)} pool</span>
              </div>
            </div>
          </div>
        )}

        {/* ── Activity timeline (unified per-task thread) ──
            Gated by `contributions.view_activity`; basic employees without it
            see neither the timeline nor the Log note affordance. */}
        {selectedTask && (permissionFlags.viewActivity ?? false) && (
          <div className="bg-card border border-border rounded-xl p-4">
            <ActivityPanel entityType="task" entityId={selectedTask.id} />
          </div>
        )}

      </div>

      {/* ── Fixed bottom action bar ──
          On mobile: spans full width (sidebar is hidden behind hamburger), and
          sits --bottom-nav-h above the bottom edge so the employee bottom nav
          (fixed, z-50) cannot paint over it — see globals.css.
          On md+: clears the 240px desktop sidebar via left-60. */}
      {/* pr-20 reserves the bottom-right corner so the floating chat launcher
          (fixed bottom-right, ~4.25rem) never overlaps the last action button. */}
      <div className="fixed bottom-[var(--bottom-nav-h,0px)] left-0 md:left-60 right-0 z-20 bg-card/95 backdrop-blur-md border-t border-border pl-4 sm:pl-6 pr-20 py-3 sm:py-3.5 flex items-center gap-2 sm:gap-3 flex-wrap pb-[var(--bottom-bar-pb,0.75rem)]">
        {/* whitespace-nowrap + a shorter mobile label: with the sibling buttons
            and pr-20 taking their share of a 375px bar, the flex-1 basis left
            here is ~100px — enough to wrap "Save & Mark Done" onto three lines
            rather than shrink it. min-w-0 keeps it from pushing the row wider
            than the viewport instead. */}
        <button onClick={handleSave} disabled={saving}
          className="flex-1 sm:flex-initial min-w-0 flex items-center justify-center gap-2 gradient-bg text-white text-sm font-semibold px-4 sm:px-6 py-3 sm:py-2.5 rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity shadow-md shadow-primary/20 whitespace-nowrap">
          {saving
            ? <><span className="w-4 h-4 border-2 border-foreground/30 border-t-white rounded-full animate-spin" /> Saving…</>
            : calculatedResult
              ? <>
                  <Check className="w-4 h-4 shrink-0" />
                  <span className="sm:hidden">Save &amp; Done</span>
                  <span className="hidden sm:inline">Save &amp; Mark Done</span>
                </>
              : <>
                  <span className="sm:hidden">Save</span>
                  <span className="hidden sm:inline">Save Contributions</span>
                </>
          }
        </button>
        <button onClick={() => setView('list')}
          className="flex items-center gap-2 bg-secondary border border-border text-sm font-medium px-4 sm:px-5 py-3 sm:py-2.5 rounded-xl hover:bg-secondary/80 transition-colors shrink-0">
          <ChevronLeft className="w-4 h-4" /> <span className="hidden sm:inline">Back to list</span>
        </button>
        {/* Discard draft button — only shown if there's a local draft */}
        {selectedTask && (() => {
          try { return !!localStorage.getItem(draftKey(selectedTask.id)) } catch { return false }
        })() && (
          <button
            onClick={() => {
              if (!selectedTask) return
              try { localStorage.removeItem(draftKey(selectedTask.id)) } catch { /* ignore */ }
              setContributions({}); setToolsUsed({})
              setExpandedEmployees(new Set()); setActiveGroups(new Set()); setActiveSubParams(new Set())
              toast.info('Draft discarded')
            }}
            title="Discard draft"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-400 px-3 py-2 rounded-lg hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all shrink-0">
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">Discard draft</span>
          </button>
        )}
        {calculatedResult && showFinancials && (
          <div className="ml-auto text-right">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide leading-tight">Total payable</p>
            <p className="text-2xl font-black gradient-text leading-tight">₹{totalEarnings.toFixed(0)}</p>
          </div>
        )}
      </div>

    </div>
  )
}
