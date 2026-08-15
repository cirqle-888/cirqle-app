'use client'

import { useState, useMemo, useEffect, useRef, Fragment, useCallback } from 'react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import dynamic from 'next/dynamic'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { getStatusColor, getStatusLabel } from '@/lib/utils/invoice'
import { Plus, X, Hash, Clock, CheckCircle, Pencil, Trash2, AlertTriangle, RefreshCw, TrendingDown, Users, Ban, Search, ExternalLink, ChevronDown, ChevronLeft, ChevronRight, Layers, LayoutGrid, List, CalendarDays, MoreVertical, Building2, BarChart2, Copy, GripVertical, Settings2, ChevronUp, Inbox, Loader2 } from 'lucide-react'
import { formatCurrency } from '@/lib/calculations/currency'
import Link from 'next/link'
import Combobox from '@/components/ui/combobox'
import { TitleAutocomplete } from '@/components/tasks/title-autocomplete'

const QuickCreateClientModal = dynamic(() => import('@/components/tasks/quick-create-modals').then(mod => mod.QuickCreateClientModal), { ssr: false })
const QuickCreateServiceModal = dynamic(() => import('@/components/tasks/quick-create-modals').then(mod => mod.QuickCreateServiceModal), { ssr: false })
import { markRequestPromoted, getRequestBriefForTask } from '@/app/(dashboard)/dashboard/requests/actions'
import { createContributionSlots } from '@/app/(dashboard)/dashboard/contributions/actions'
import { DiscussButton } from '@/components/chat/discuss-button'
import AppSelect from '@/components/ui/app-select'
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { DateFilter, matchesDateFilter, getDateFilterLabel } from '@/components/ui/date-filter'
import type { DateFilterValue } from '@/components/ui/date-filter'
import { ActiveFilterChips } from '@/components/ui/active-filter-chips'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import type { Currency } from '@/types'
import { taskCode, taskCodeMatches, nextTaskNumber } from '@/lib/utils/task-code'
import { deriveWorkScope, retryWithoutScope, withoutScope, isScopeColumnMissing } from '@/lib/finance/classify'
import { seedFromTasks } from '@/lib/hooks/use-smart-sort'
import { useRole } from '@/contexts/role-context'
import { usePermissions } from '@/contexts/permission-context'
import {
  serverDeleteTask,
  serverRestoreTask,
  serverPermanentDeleteTask,
  serverUpdateTaskStatus,
  serverBulkUpdateStatus,
  serverBulkAssignEmployees,
  serverBulkDeleteTasks,
  serverEmptyTrash,
  serverCancelTask,
  serverFillTaskBilling,
  logTaskCreated,
  logTaskAssignment,
  serverInlineTaskUpdate,
  checkPossibleDuplicateTask,
} from './actions'
import { TaskBillingSection } from '@/components/ui/task-billing-section'
import { computeTaskAmount, resolveTaskQuantity, resolvePricingType } from '@/lib/tasks/pricing'
import {
  emptyBillingRule, isBasisTask, sumBasis, computeRule, findDuplicateRules,
  type BillingRule,
} from '@/lib/tasks/derived-billing'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { BatchActionBar, type BatchAction } from '@/components/ui/batch-action-bar'
import { formatTaskDate, fullTaskDate } from '@/lib/utils/format-date'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { OverflowMenu } from '@/components/ui/overflow-menu'
import { Button } from '@/components/ui/button'
import { usePrivacy } from "@/contexts/privacy-context"
import { cn, ROW_INTERACTIVE_CLASS, BRANDED_PILL_BASE_CLASS, BRANDED_PILL_SELECTED_CLASS, BRANDED_PILL_ACTIVE_CLASS } from "@/lib/utils"
import { daysFromTodayISO, todayISO } from '@/lib/utils/local-date'

// Heavy modals — only mount when opened. Bundle is split off the tasks route
// chunk so the initial page download stays leaner. ssr:false because modals
// never render on the server pass (their state starts closed).
const TaskEditModal = dynamic(
  () => import('@/components/ui/task-edit-modal').then(m => m.TaskEditModal),
  { ssr: false },
)
const ClientEditModal = dynamic(
  () => import('@/components/ui/client-edit-modal').then(m => m.ClientEditModal),
  { ssr: false },
)

// ── Internal work (no client) ────────────────────────────────────────────────
// A task with client_id NULL is Cirqle's own work — internal marketing, brand
// design, company videos. The task→invoice DB trigger only fires for tasks
// WITH a client, so internal tasks can never generate an invoice. This
// sentinel is UI-only: it stands in for "internal" in the filter dropdown and
// the Add Task form, and is always converted to NULL before saving.
const INTERNAL_CLIENT = '__internal__'

// Shown wherever a client name would normally appear, so internal work reads
// as a deliberate label instead of a data gap ('—').
function InternalBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-cyan-500/15 text-cyan-400 border border-cyan-500/20 ${className}`}>
      Internal
    </span>
  )
}

interface Task {
  id: string
  task_number?: number | null
  title: string
  description?: string
  client_id: string | null
  service_id: string
  status: string
  billing_amount?: number       // stripped from employee payloads; present only for admins
  billing_amount_inr?: number   // stripped from employee payloads; present only for admins
  quantity?: number
  currency?: string             // stripped from employee payloads; present only for admins
  task_date: string
  created_at: string
  is_recurring?: boolean
  recurring_interval?: string | null
  recurring_end_date?: string | null
  recurring_parent_id?: string | null
  // Cancellation fields
  cancelled_by?: 'client' | 'company' | 'no_show' | null
  cancellation_notes?: string | null
  honor_contributions?: boolean
  loss_amount?: number
  completion_pct?: number
  // Variant fields (Phase 1)
  parent_task_id?: string | null
  variant_type?: 'revision' | 'concept' | 'size' | null
  variant_label?: string | null
  billing_mode?: 'fixed' | 'percent_of_parent' | 'parameter_driven'
  billing_percent?: number | null
  billing_override?: boolean
  is_billable?: boolean
  /** Package this task is delivered under. Affects invoicing only, never price. */
  package_id?: string | null
  client?: { id: string; name: string; code: string }
  service?: { id: string; name: string }
}

interface Service {
  id: string
  name: string
  pricing_type?: string
  default_price?: number
  default_currency?: string
}

interface VisibilitySettings {
  billing: string          // 'all' | 'team_lead' | 'admin_only'
  contributions: string
  employee_names: string
}

interface Props {
  /** Set when arriving via /dashboard/tasks?fromRequest=<id> — opens the Add
   *  Task modal prefilled from the external request (promotion flow). */
  promotionRequest?: {
    id: string; ref_no: number; title: string; description: string
    client_id: string | null; service_id: string | null; due_date: string | null
  } | null
  /** taskId → linked external request (REQ chip + brief modal on task rows). */
  requestRefByTaskId?: Record<string, { id: string; ref_no: number }>
  /** Pre-filled search (?q=… deep link, e.g. "#42" from a request). */
  initialSearch?: string
  /** Pre-selected client filter (?client=<id>), e.g. from a package's task link. */
  initialClient?: string
  /** Pre-selected service filter (?service=<id>). */
  initialService?: string
  /** Pre-selected date range (?from=&to=), e.g. a package's billing cycle. */
  initialDateRange?: { from: string; to: string } | null
  /** Count of new/unstarted external requests — badge on the Requests button. */
  pendingRequestCount?: number
  dbTaskTotal?: number
  /** True when the page was rendered with `?history=all` (window bypassed). */
  fullHistory?: boolean
  initialTasks: Task[]
  initialTrash: (Task & { deleted_at: string })[]
  clients: { id: string; name: string; code: string }[]
  services: Service[]
  clientPricings: { client_id: string; service_id: string; price: number; currency: string }[]
  employees: { id: string; cqid: string; name: string | null; is_active: boolean }[]
  taskAssignments: { task_id: string; employee_id: string }[]
  groups: { id: string; name: string; weight: number; display_order: number; is_active?: boolean }[]
  parameters: { id: string; name: string; group_id: string; weight: number; is_master?: boolean; input_type?: 'percentage' | 'count'; display_order: number }[]
  groupServices: { group_id: string; service_id: string }[]
  parameterServices: { parameter_id: string; service_id: string }[]
  taskGroups: { task_id: string; group_id: string }[]
  taskGroupAssignments: { task_id: string; group_id: string; employee_id: string }[]
  taskParamAssignments: { task_id: string; parameter_id: string; employee_id: string }[]
  /**
   * For employees: the union of task ids they personally have any history on
   * (assignments + group/param assignments + scores + contributions). The
   * "My Tasks" toggle uses this Set to scope the visible list to their own
   * work. Empty for admins (who don't need this lookup).
   */
  myTaskIds?: string[]
  visibilitySettings?: VisibilitySettings
  /**
   * Per-field financial visibility from the server. `pricing` = user holds
   * `tasks.view_pricing`. Contribution flags gate the Contributions tab in
   * the task edit modal.
   */
  permissionFlags?: {
    pricing: boolean
    contribView?: boolean
    contribViewAll?: boolean
    contribEdit?: boolean
    contribEarnings?: boolean
  }
}

// Task-driven status flow: New(pending) → In Progress → Delivered → Completed(done) → Cancelled.
// 'delivered' = work sent to client for review (auto-sets the linked request to "Under Review",
// NOT yet billable). 'done' = Completed/finalized (billable). 'invoiced' is system-managed
// (set automatically when invoice is sent) — excluded from the manual dropdown.
const STATUSES = ['pending', 'in_progress', 'delivered', 'done', 'invoiced', 'cancelled']
const MANUAL_STATUSES = ['pending', 'in_progress', 'delivered', 'done', 'cancelled']
// The pipeline the team ACTUALLY uses: pending → done → invoiced. The other
// statuses exist in the schema but have never been used (0 of 1,883 tasks as
// of Aug 2026), so the UI hides them — DATA-DRIVEN, not deleted: any status
// that gains live tasks (or is a row's current value) surfaces again
// automatically. Nothing in the schema or existing data changes.
const CORE_STATUSES = ['pending', 'done', 'invoiced']
const CORE_MANUAL_STATUSES = ['pending', 'done', 'cancelled']
/** Options for a manual status dropdown: the core set, plus the row's current
 *  status so an exotic value never renders as an empty select. */
const manualStatusOptions = (current?: string | null) =>
  MANUAL_STATUSES.filter(s => CORE_MANUAL_STATUSES.includes(s) || s === current)
const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

const RECURRING_INTERVALS = [
  { value: 'daily',     label: 'Daily' },
  { value: 'weekly',    label: 'Weekly' },
  { value: 'biweekly',  label: 'Bi-weekly' },
  { value: 'monthly',   label: 'Monthly' },
]

const EMPTY_FORM = {
  task_number: '',  // optional — auto-assigned if blank
  title: '',
  description: '',
  client_id: '',
  service_id: '',
  status: 'pending',
  quantity: '1',
  hours: '1',
  spend: '',       // for percentage_of_spend: client's total ad spend
  currency: 'INR' as Currency,
  task_date: todayISO(),
  is_recurring: false,
  recurring_interval: 'monthly',
  recurring_end_date: '',
  // ── Variant fields (Phase 1: manual entry; auto-fill comes in Phase 2) ──
  parent_task_id: '',                                                            // empty = original task
  variant_type: '' as '' | 'revision' | 'concept' | 'size',
  variant_label: '',                                                             // "Story", "Banner", "Concept 2"...
  billing_mode: 'fixed' as 'fixed' | 'percent_of_parent' | 'parameter_driven',
  billing_percent: '',                                                           // string for input; parsed on save
  billing_override: false,                                                       // true when user types a custom amount
  is_billable: true,                                                             // false = internal/non-billable concept
  manual_billing_amount: '',                                                     // user-typed override amount
  package_id: null as string | null,                                             // delivered under a package (invoicing only)
  // ── Derived billing ("Handling = 30% of this month's posters") ──
  derived_on: false,                                                             // the rule section is switched on
  derived_service_ids: [] as string[],                                           // source services
  derived_percent: '',                                                           // string for input; parsed on save
  derived_min: '',                                                               // optional floor (INR), Advanced
  derived_max: '',                                                               // optional ceiling (INR), Advanced
}

// ── Reorderable column system ─────────────────────────────────────────────────
type ColKey = 'client' | 'service' | 'date' | 'billing' | 'qty' | 'total' | 'status'
const DEFAULT_COL_ORDER: ColKey[] = ['client', 'service', 'date', 'billing', 'qty', 'total', 'status']
const COL_LABELS: Record<ColKey, string> = {
  client: 'Client', service: 'Service', date: 'Date',
  billing: 'Billing', qty: 'Qty', total: 'Total', status: 'Status',
}
// Qty (task count) is NOT price data — it stays visible to everyone (e.g. employees
// need to see how much they've delivered) even when Billing/Total are hidden.
const BILLING_COLS: ColKey[] = ['billing', 'total']

/** Draggable <th> wrapper — shows a grip handle on hover; handles the DnD transform. */
function SortableColHeader({ id, children, className }: {
  id: string; children: React.ReactNode; className?: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })
  return (
    <th
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className={`relative group ${className ?? ''}`}
    >
      {/* drag handle — desktop only, appears on header hover */}
      <span
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1/2 -translate-y-1/2 hidden md:flex items-center opacity-0 group-hover:opacity-40 hover:!opacity-100 cursor-grab active:cursor-grabbing text-muted-foreground transition-opacity touch-none"
        title="Drag to reorder"
        onClick={e => e.stopPropagation()}
      >
        <GripVertical className="w-3 h-3" />
      </span>
      {children}
    </th>
  )
}

/** Draggable row in the Columns panel (vertical sort). */
function SortablePanelRow({ id, label, onUp, onDown, isFirst, isLast }: {
  id: string; label: string
  onUp: () => void; onDown: () => void
  isFirst: boolean; isLast: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/60 group"
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition-colors touch-none"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </span>
      <span className="flex-1 text-xs">{label}</span>
      <button onClick={onUp} disabled={isFirst} aria-label={`Move ${label} column up`} className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors">
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button onClick={onDown} disabled={isLast} aria-label={`Move ${label} column down`} className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors">
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function TasksClient({ promotionRequest, requestRefByTaskId = {}, pendingRequestCount = 0, initialSearch = '', initialClient = '', initialService = '', initialDateRange = null, dbTaskTotal, fullHistory = false, initialTasks, initialTrash, clients, services: initialServices, clientPricings: initialClientPricings, employees, taskAssignments: initialTaskAssignments, groups, parameters, groupServices, parameterServices, taskGroups: initialTaskGroups, taskGroupAssignments: initialTaskGroupAssignments, taskParamAssignments: initialTaskParamAssignments, myTaskIds, visibilitySettings, permissionFlags }: Props) {
  const { role, employee: currentEmployee } = useRole()
  // Browser DB search runs through the anon/RLS client, which cannot reproduce
  // the server's service- and unit-scoped visibility model — so it is, and must
  // remain, unavailable to employees (runDbSearch guards on this too). Employees
  // reach older tasks through `?history=all`, which widens the SERVER query and
  // keeps every visibility filter in place.
  //
  // This flag also fixes a real defect: the affordances below used to key only on
  // `dbTaskTotal > tasks.length`, so any viewer with a partial set — every
  // service-scoped employee even before the history window existed — was shown a
  // "Search DB" button that silently did nothing.
  const canDbSearch = role !== 'employee'

  const { can } = usePermissions()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const { dn } = usePrivacy()

  // ── Visibility helpers ─────────────────────────────────────────────────────
  // Returns true if the current user's role meets the required visibility level
  function canSee(setting: string | undefined): boolean {
    if (!setting || setting === 'all') return true
    if (setting === 'admin_only') return role === 'super_admin' || role === 'accounts'
    if (setting === 'team_lead') return role === 'super_admin' || role === 'accounts' || role === 'team_lead'
    return true
  }
  // Billing visibility requires (a) the new granular `tasks.view_pricing`
  // perm AND (b) the legacy visibility-settings gate. The server has already
  // stripped financial fields for users without view_pricing; this flag
  // additionally suppresses the column header / cells so the UI doesn't render
  // '—' placeholders for hidden columns.
  const showBilling     = (permissionFlags?.pricing ?? false) && canSee(visibilitySettings?.billing)
  const showEmpNames    = canSee(visibilitySettings?.employee_names)
  const [editClientId, setEditClientId] = useState<string | null>(null)
  const [editClientServiceId, setEditClientServiceId] = useState<string | null>(null)
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null)

  // Scroll to and briefly highlight a task when arriving with ?highlight=<id>
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

  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)

  // ── Column order (persisted in localStorage) ────────────────────────────────
  const [colOrder, setColOrder] = useState<ColKey[]>(() => {
    try {
      const saved = localStorage.getItem('tasks-col-order')
      if (saved) {
        const parsed: ColKey[] = JSON.parse(saved)
        // merge: keep saved order, append any new keys not yet in saved list
        const missing = DEFAULT_COL_ORDER.filter(k => !parsed.includes(k))
        return [...parsed.filter(k => DEFAULT_COL_ORDER.includes(k)), ...missing]
      }
    } catch {}
    return [...DEFAULT_COL_ORDER]
  })
  const [showColPanel, setShowColPanel] = useState(false)
  const colPanelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem('tasks-col-order', JSON.stringify(colOrder))
  }, [colOrder])

  // close panel on outside click
  useEffect(() => {
    if (!showColPanel) return
    const h = (e: MouseEvent) => { if (colPanelRef.current && !colPanelRef.current.contains(e.target as Node)) setShowColPanel(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showColPanel])

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handleColHeaderDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    if (over && active.id !== over.id)
      setColOrder(prev => arrayMove(prev, prev.indexOf(active.id as ColKey), prev.indexOf(over.id as ColKey)))
  }, [])

  const handleColPanelDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    if (over && active.id !== over.id)
      setColOrder(prev => arrayMove(prev, prev.indexOf(active.id as ColKey), prev.indexOf(over.id as ColKey)))
  }, [])

  // Columns visible in table view — billing-group only when showBilling
  const visibleCols = useMemo(
    () => colOrder.filter(k => !BILLING_COLS.includes(k) || showBilling),
    [colOrder, showBilling],
  )
  const [trash, setTrash] = useState<(Task & { deleted_at: string })[]>(initialTrash)
  const [showTrash, setShowTrash] = useState(false)
  const [trashDbCount, setTrashDbCount] = useState<number | null>(null)
  const [dbSearchResults, setDbSearchResults] = useState<Task[] | null>(null)
  const [dbSearching, setDbSearching]         = useState(false)

  // ── Database search mode ─────────────────────────────────────────────────
  // When active, results are fetched directly from Supabase with the current
  // filters applied — gives access to every task regardless of the in-memory
  // loaded set (useful for very old or large datasets).
  const DB_PAGE_SIZE = 100
  const [dbMode, setDbMode]               = useState(false)
  const [dbModeResults, setDbModeResults] = useState<Task[]>([])
  const [dbModeTotal, setDbModeTotal]     = useState<number | null>(null)
  const [dbModeLoading, setDbModeLoading] = useState(false)
  const [dbModePage, setDbModePage]       = useState(0)

  async function runDbSearch(page = 0) {
    // Employee task lists are fully loaded server-side via the admin client. DB search
    // would use the anon client (RLS), which cannot safely scope results to the employee.
    // Since dbTaskTotal is undefined for employees, the auto-trigger and "Search DB" button
    // never fire — this guard is a belt-and-suspenders safety net.
    if (role === 'employee') return

    setDbModeLoading(true)
    try {
      // Detect soft-delete support once per call
      const probe = await supabase.from('tasks').select('deleted_at').limit(0)
      const hasSoftDelete = !probe.error

      type Q = ReturnType<typeof supabase.from> extends { select: (...a: any[]) => infer R } ? R : any

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from('tasks')
        .select('*, client:clients(id, name, code), service:services(id, name)', { count: 'exact' })

      if (hasSoftDelete) q = q.is('deleted_at', null)

      // Apply filters
      if (filterStatus)  q = q.eq('status', filterStatus)
      if (filterClient)  q = filterClient === INTERNAL_CLIENT ? q.is('client_id', null) : q.eq('client_id', filterClient)
      if (filterService) q = q.eq('service_id', filterService)

      // Search query
      if (searchQ) {
        const trimmed = searchQ.trim()
        if (trimmed.startsWith('#')) {
          const num = parseInt(trimmed.slice(1), 10)
          if (!isNaN(num)) q = q.eq('task_number', num)
        } else {
          // Full-text search on title; also match exact task number
          const num = parseInt(trimmed, 10)
          if (!isNaN(num) && String(num) === trimmed) {
            q = q.or(`title.ilike.%${trimmed}%,task_number.eq.${num}`)
          } else {
            q = q.ilike('title', `%${trimmed}%`)
          }
        }
      }

      // Sort
      if (sortBy === 'date_asc')    q = q.order('task_date',           { ascending: true,  nullsFirst: false })
      else if (sortBy === 'date_desc')   q = q.order('task_date',      { ascending: false, nullsFirst: false })
      else if (sortBy === 'amount_desc') q = q.order('billing_amount_inr', { ascending: false, nullsFirst: false })
      else if (sortBy === 'client')      q = q.order('client_id',      { ascending: true,  nullsFirst: false })
      else                               q = q.order('task_number',    { ascending: false, nullsFirst: false })

      // Paginate (Add deterministic stable sort for non-unique sorts)
      q = q.order('id', { ascending: true })
      q = q.range(page * DB_PAGE_SIZE, (page + 1) * DB_PAGE_SIZE - 1)

      const { data, count, error } = await q
      if (!error) {
        // Post-filter by assignee client-side (task_assignments is loaded).
        // Employees are blocked from reaching this code by the early return above,
        // so this filter only runs for admin/team_lead roles.
        let rows: Task[] = (data || []) as Task[]
        if (filterAssignee) {
          const assignedIds = new Set([
            ...localAssignments.filter(a => a.employee_id === filterAssignee).map(a => a.task_id),
            ...localGroupAssignments.filter(a => a.employee_id === filterAssignee).map(a => a.task_id),
            ...localParamAssignments.filter(a => a.employee_id === filterAssignee).map(a => a.task_id),
          ])
          rows = rows.filter(t => assignedIds.has(t.id))
        }
        setDbModeResults(rows)
        setDbModeTotal(count)
        setDbModePage(page)
        setDbMode(true)
      }
    } finally {
      setDbModeLoading(false)
    }
  }

  function exitDbMode() {
    setDbMode(false)
    setDbModeResults([])
    setDbModeTotal(null)
    setDbModePage(0)
  }

  // Fetch the live total count of soft-deleted tasks from the DB on mount
  // (initialTrash only covers the last 45 days, so the count may be higher)
  useEffect(() => {
    ;(async () => {
      const probe = await supabase.from('tasks').select('deleted_at').limit(0)
      if (probe.error) return // column doesn't exist — no soft-delete
      const { count } = await supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .not('deleted_at', 'is', null)
      if (count != null) setTrashDbCount(count)
    })()
  }, [])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterClient, setFilterClient] = useState(initialClient)
  const [filterService, setFilterService] = useState(initialService)
  // Tokenized search: field-scoped facet pills + operators. `searchQ` is derived
  // from the generic ('any') facets so the existing #number/DB-mode logic keeps
  // working unchanged; named-field facets are applied separately in filteredTasks.
  const [searchFacets, setSearchFacets] = useState<SearchFacet[]>(
    () => initialSearch ? [{ field: 'any', op: 'contains', text: initialSearch }] : [],
  )
  const [searchDraft, setSearchDraft] = useState('')
  const activeFacets = useMemo<SearchFacet[]>(
    () => searchDraft.trim() ? [...searchFacets, { field: 'any', op: 'contains' as const, text: searchDraft.trim() }] : searchFacets,
    [searchFacets, searchDraft],
  )
  const searchQ = useMemo(() => activeFacets.filter(f => f.field === 'any').map(f => f.text).join(' '), [activeFacets])
  const namedFacets = useMemo(() => activeFacets.filter(f => f.field !== 'any'), [activeFacets])
  const clearSearch = () => { setSearchFacets([]); setSearchDraft('') }

  // Request brief modal — opened from the REQ chip on a promoted task.
  const [requestBrief, setRequestBrief] = useState<{ loading: boolean; data?: any; error?: string } | null>(null)
  async function openRequestBrief(taskId: string) {
    setRequestBrief({ loading: true })
    const res = await getRequestBriefForTask(taskId)
    if (res.ok) setRequestBrief({ loading: false, data: res.data })
    else setRequestBrief({ loading: false, error: res.error })
  }

  const [sortBy, setSortBy] = useState<'today_first' | 'date_desc' | 'date_asc' | 'amount_desc' | 'client'>('today_first')
  const [tablePage, setTablePage] = useState(0)
  const [tablePageSize, setTablePageSize] = useState(50)
  const [mobileLimit, setMobileLimit] = useState(50)
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [previewTaskNumber, setPreviewTaskNumber] = useState<number | null>(null)

  // ── Request promotion (?fromRequest=…) — open Add Task prefilled (design §5).
  // The task is only created when the user presses Create Task; on success we
  // link it back to the request via markRequestPromoted.
  const [promotingRequestId, setPromotingRequestId] = useState<string | null>(null)
  useEffect(() => {
    if (!promotionRequest) return
    setForm({
      ...EMPTY_FORM,
      title: promotionRequest.title,
      description: promotionRequest.description,
      client_id: promotionRequest.client_id || '',
      service_id: promotionRequest.service_id || '',
      task_date: promotionRequest.due_date || todayISO(),
    })
    setPromotingRequestId(promotionRequest.id)
    setShowForm(true)
    // Strip the query param so a refresh doesn't re-trigger the prefill.
    window.history.replaceState(null, '', '/dashboard/tasks')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    seedFromTasks(initialTasks.map(t => ({
      clientId: t.client?.id,
      serviceId: t.service?.id,
      taskDate: t.task_date,
      createdAt: t.created_at,
    })))
  }, [])

  // Local copies so quick-set price updates reflect immediately without page reload
  const [services, setServices] = useState(initialServices)
  const [clientList, setClientList] = useState(clients)
  const [clientPricings, setClientPricings] = useState(initialClientPricings)

  // Inline quick-create (client / service) opened from the Add Task dropdowns.
  const [quickCreate, setQuickCreate] = useState<{ kind: 'client' | 'service'; query: string } | null>(null)
  const canCreateClient  = can('clients.create')
  const canCreateService = can('services.create')
  const canSeePricing    = permissionFlags?.pricing ?? false

  // ── Sticky header + toolbar measurement ────────────────────────────────────
  // Both the page Header and the task toolbar are sticky. We measure both with
  // ResizeObservers so the thead always sticks flush below the toolbar with
  // zero gap — no hardcoded pixel values that break when content wraps.
  const headerRef  = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [headerHeight,  setHeaderHeight]  = useState(92)
  const [toolbarHeight, setToolbarHeight] = useState(120)
  useEffect(() => {
    if (!headerRef.current) return
    const el = headerRef.current
    const measure = () => setHeaderHeight(el.offsetHeight)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!toolbarRef.current) return
    const el = toolbarRef.current
    const measure = () => setToolbarHeight(el.offsetHeight)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  // thead sticks right below the toolbar; toolbar sticks right below the header.
  const theadTop = headerHeight + toolbarHeight

  // Edit / delete state
  const [editTask, setEditTask] = useState<Task | null>(null)
  // When set to a task id, the edit modal opens on the Contributions tab
  const [openOnContribTab, setOpenOnContribTab] = useState<string | null>(null)

  // Cmd+S / Ctrl+S: submit the currently open form
  const addFormRef  = useRef<HTMLFormElement>(null)
  const editFormRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (showForm)    addFormRef.current?.requestSubmit()
        else if (editTask) editFormRef.current?.requestSubmit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showForm, editTask])
  const [editForm, setEditForm] = useState({ ...EMPTY_FORM, id: '' })
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null) // task id
  const [deleteConfirmHasScores, setDeleteConfirmHasScores] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editSaving, setEditSaving] = useState(false)

  // Quick-set price state
  const [quickSet, setQuickSet] = useState<{ mode: 'default' | 'client'; price: string; currency: Currency } | null>(null)
  const [quickSaving, setQuickSaving] = useState(false)

  // ── Possible-duplicate warning (same client + same title, created within
  // the last 24h) — surfaced live while filling the Add Task form. Catches
  // two people creating the same task without knowing about each other,
  // whether a minute apart or later the same day (e.g. one teammate's task
  // getting deleted as a "duplicate" of another's), without nagging on
  // legitimately recurring same-title tasks from weeks/months ago.
  const [dupWarning, setDupWarning] = useState<{ taskNumber: number | null; createdBy: string; minutesAgo: number } | null>(null)

  // Bulk selection state
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())
  const [bulkMode, setBulkMode] = useState(false)

  // Cancellation modal
  const [cancelModal, setCancelModal] = useState<Task | null>(null)
  const [cancelForm, setCancelForm] = useState({
    cancelled_by:        'client' as 'client' | 'company' | 'no_show',
    completion_pct:      50,
    honor_contributions: true,
    loss_amount:         '',
    notes:               '',
    record_cashbook:     true,
  })
  const [cancelSaving, setCancelSaving] = useState(false)

  // Assignment modal state
  const [assignModal, setAssignModal] = useState<{ taskId: string; taskNumber?: number | null; taskTitle: string; serviceId?: string } | null>(null)
  const [localAssignments, setLocalAssignments] = useState<{ task_id: string; employee_id: string }[]>(initialTaskAssignments)
  const [localTaskGroups, setLocalTaskGroups] = useState<{ task_id: string; group_id: string }[]>(initialTaskGroups)
  const [localGroupAssignments, setLocalGroupAssignments] = useState<{ task_id: string; group_id: string; employee_id: string }[]>(initialTaskGroupAssignments)
  const [localParamAssignments, setLocalParamAssignments] = useState<{ task_id: string; parameter_id: string; employee_id: string }[]>(initialTaskParamAssignments)
  const [assignSaving, setAssignSaving] = useState(false)
  const [assignSelected, setAssignSelected] = useState<Set<string>>(new Set())
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
  // empId → Set of groupIds assigned to that employee
  const [empGroups, setEmpGroups] = useState<Record<string, Set<string>>>({})
  // empId → Set of parameterIds assigned to that employee
  const [empParams, setEmpParams] = useState<Record<string, Set<string>>>({})
  // Which employee cards are expanded
  const [expandedEmpCards, setExpandedEmpCards] = useState<Set<string>>(new Set())
  // View mode & assignee filter
  const [viewMode, setViewMode] = useState<'table' | 'board' | 'calendar'>('table')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [filterDate, setFilterDate] = useState<DateFilterValue>(
    initialDateRange ? { type: 'range', from: initialDateRange.from, to: initialDateRange.to } : null,
  )
  // "My Tasks" / "Not Assigned to Me" quick toggle — independent of the Assignee
  // dropdown (which picks any single teammate). Available to anyone with an
  // employee record, not just role==='employee' — admins can be assignees too.
  const [myScope, setMyScope] = useState<'mine' | 'not_mine' | null>(null)
  // Calendar view state
  const [calViewYear, setCalViewYear] = useState(() => new Date().getFullYear())
  const [calViewMonth, setCalViewMonth] = useState(() => new Date().getMonth())
  // Inline edit mode for table view
  const [inlineEditMode, setInlineEditMode] = useState(false)
  // Workload report
  const [showWorkload, setShowWorkload] = useState(false)
  // Board grouping dimension
  const [boardGroupBy, setBoardGroupBy] = useState<'employee' | 'client' | 'service' | 'status' | 'date'>('employee')
  // Date granularity for board (only when boardGroupBy === 'date')
  const [boardDateGranularity, setBoardDateGranularity] = useState<'daily' | 'weekly' | 'monthly' | 'preset'>('preset')

  // Board settings popover state
  const [viewOpen, setViewOpen] = useState(false)
  const viewRef   = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function h(e: MouseEvent) {
      if (viewRef.current && !viewRef.current.contains(e.target as Node)) setViewOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const supabase = createClient()

  // Preview next task number when Add Task modal opens
  useEffect(() => {
    if (!showForm) { setPreviewTaskNumber(null); return }
    if (form.task_number) { setPreviewTaskNumber(parseInt(form.task_number, 10)); return }
    ;(async () => {
      const r = await supabase
        .from('tasks')
        .select('task_number')
        .order('task_number', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      setPreviewTaskNumber((r.data?.task_number ?? 0) + 1)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, form.task_number])

  // ── Possible-duplicate warning (same client + same title, created within
  // the last 24h) — surfaced live while filling the Add Task form. Catches
  // two people creating the same task without knowing about each other,
  // whether a minute apart or later the same day (e.g. one teammate's task
  // getting deleted as a "duplicate" of another's), without nagging on
  // legitimately recurring same-title tasks from weeks/months ago.
  useEffect(() => {
    if (!showForm) { setDupWarning(null); return }
    const title = form.title.trim()
    if (title.length < 3) { setDupWarning(null); return }
    const clientId = form.client_id === INTERNAL_CLIENT ? null : (form.client_id || null)

    const timer = setTimeout(async () => {
      // Server-side: activity_logs has no browser-readable RLS policy, so the
      // creator of a matching task can only be resolved there.
      const res = await checkPossibleDuplicateTask(title, clientId)
      if (!res.ok || !res.data) { setDupWarning(null); return }
      const { taskNumber, createdByEmployeeId, minutesAgo } = res.data
      const creator = createdByEmployeeId ? employees.find(e => e.id === createdByEmployeeId) : undefined
      setDupWarning({
        taskNumber,
        createdBy: creator ? dn(creator) : 'a teammate',
        minutesAgo,
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [showForm, form.title, form.client_id, employees, dn])

  // Sort services by most recently used
  const sortedServices = useMemo(() => {
    const lastUsed: Record<string, string> = {}
    initialTasks.forEach(t => {
      if (t.service?.id && (!lastUsed[t.service.id] || t.created_at > lastUsed[t.service.id])) {
        lastUsed[t.service.id] = t.created_at
      }
    })
    return [...services].sort((a, b) => {
      const aU = lastUsed[a.id], bU = lastUsed[b.id]
      if (aU && bU) return bU.localeCompare(aU)
      if (aU) return -1
      if (bU) return 1
      return a.name.localeCompare(b.name)
    })
  }, [services, initialTasks])

  // Derived: selected service object
  const selectedService = services.find(s => s.id === form.service_id)

  // Derived: unit price — client-specific matrix first, then service default.
  // Shared engine, so this form and the Edit modal can never disagree.
  const clientPrice = clientPricings.find(p => p.client_id === form.client_id && p.service_id === form.service_id)
  const pricingType = resolvePricingType(selectedService?.pricing_type)
  const unitPrice = clientPrice?.price ?? selectedService?.default_price ?? 0
  const unitCurrency = (clientPrice?.currency || selectedService?.default_currency || 'INR') as Currency

  // Derived: parent task (when creating a variant)
  const parentTask = useMemo(
    () => form.parent_task_id ? tasks.find(t => t.id === form.parent_task_id) : null,
    [form.parent_task_id, tasks]
  )

  // ── Variant: selected parameter IDs + per-parameter VALUE (count or %) ──
  // The billing math is GROUP-NORMALIZED:
  //   share(param)         = weight × (value if count, value/100 if percentage)
  //   group_internal_share = min(1.0, Σ share over selected params in that group)
  //   total_fraction       = Σ over relevant groups: normalized_group_weight × group_internal_share
  //   billing              = parent_billing × total_fraction
  //
  // Group weights are RELATIVE (matching the commission engine): each relevant
  // group's weight is divided by the relevant groups' total, so total_fraction
  // is mathematically capped at 1.0 no matter how many groups exist or what
  // their weights sum to. "Relevant" = the groups linked to the task's service
  // via group_services (none linked = all groups).
  const [variantParamIds, setVariantParamIds] = useState<Set<string>>(new Set())
  const [variantParamValues, setVariantParamValues] = useState<Record<string, string>>({})

  // Service ↔ parameter linkage (used to highlight relevant params for this service)
  const serviceLinkedParamIds = useMemo(() => {
    if (!form.service_id) return new Set<string>()
    const linkedGroupIds = new Set(groupServices.filter(g => g.service_id === form.service_id).map(g => g.group_id))
    const directParamIds = new Set(parameterServices.filter(p => p.service_id === form.service_id).map(p => p.parameter_id))
    const all = new Set<string>(directParamIds)
    parameters.forEach(p => { if (linkedGroupIds.has(p.group_id)) all.add(p.id) })
    return all
  }, [form.service_id, parameters, groupServices, parameterServices])

  /** Raw share of one parameter inside its group (before group cap). 0.0–∞ */
  function paramRawShare(paramId: string): number {
    const p = parameters.find(x => x.id === paramId)
    if (!p) return 0
    const rawValue = variantParamValues[paramId]
    const v = rawValue === '' || rawValue == null ? 1 : (parseFloat(rawValue) || 0)
    return p.input_type === 'percentage' ? p.weight * (v / 100) : p.weight * v
  }

  /** A group's internal share — sum of selected params in that group, capped at 1.0 */
  function computeGroupShare(groupId: string): number {
    const idsInGroup = [...variantParamIds].filter(id => parameters.find(x => x.id === id)?.group_id === groupId)
    if (idsInGroup.length === 0) return 0
    return Math.min(1, idsInGroup.reduce((sum, id) => sum + paramRawShare(id), 0))
  }

  /**
   * Normalized weight portion (0..1) of one group for the variant math.
   * Weights are relative — normalized over the groups relevant to the selected
   * service (group_services links; a service with no links = all groups), the
   * same rule the commission engine applies. Equals the old `weight / 100`
   * whenever the relevant weights sum to 100, so historical configurations
   * compute identical billing; unlike the old form it can never exceed 1.0.
   * Groups outside the relevant set contribute 0.
   */
  function variantGroupPortion(groupId: string): number {
    // Active groups only — this page loads contribution_groups unfiltered, and
    // archived groups must not dilute the denominator (the scoring surfaces
    // only ever see active groups).
    const activeGroups = groups.filter(g => g.is_active !== false)
    const linked = new Set(groupServices.filter(gs => gs.service_id === form.service_id).map(gs => gs.group_id))
    const linkedActive = form.service_id ? activeGroups.filter(g => linked.has(g.id)) : []
    const relevant = linkedActive.length > 0 ? linkedActive : activeGroups
    const totalWeight = relevant.reduce((s, g) => s + (g.weight || 0), 0)
    if (totalWeight <= 0) return 0
    const g = relevant.find(x => x.id === groupId)
    return g ? (g.weight || 0) / totalWeight : 0
  }

  /** Total task fraction. Σ over relevant groups: normalized_weight × group_share. Capped at 1.0. */
  function computeTotalFraction(): number {
    return groups.reduce((sum, g) => sum + variantGroupPortion(g.id) * computeGroupShare(g.id), 0)
  }

  // Auto-default billing_mode by variant_type
  useEffect(() => {
    if (!form.variant_type) return
    const desired = form.variant_type === 'revision' ? 'parameter_driven' : 'percent_of_parent'
    if (form.billing_mode !== desired && !form.billing_override) {
      setForm(p => ({ ...p, billing_mode: desired }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.variant_type])

  // Auto-sum selected parameters into billing_percent using group-normalized math
  useEffect(() => {
    if (form.billing_mode !== 'parameter_driven') return
    if (form.billing_override) return
    const pct = (computeTotalFraction() * 100).toFixed(2).replace(/\.?0+$/, '')
    if (form.billing_percent !== pct) {
      setForm(p => ({ ...p, billing_percent: pct }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantParamIds, variantParamValues, form.billing_mode, form.service_id, parameters, groups, groupServices])

  // Reset checklist & values when modal closes or parent unlinked
  useEffect(() => {
    if (!showForm || !form.parent_task_id) {
      setVariantParamIds(new Set())
      setVariantParamValues({})
    }
  }, [showForm, form.parent_task_id])

  // ── Derived billing rule (from the form) ─────────────────────────────────
  // Built with the SAME pure helpers the server recompute uses, so the preview
  // below and the saved amount can never disagree.
  const derivedRule = useMemo<BillingRule | null>(() => {
    if (!form.derived_on) return null
    const pct = parseFloat(form.derived_percent)
    if (!form.derived_service_ids.length || !Number.isFinite(pct) || pct <= 0) return null
    const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null }
    return {
      ...emptyBillingRule(),
      percent: pct,
      sources: { serviceIds: form.derived_service_ids },
      clamps: { minInr: num(form.derived_min), maxInr: num(form.derived_max) },
    }
  }, [form.derived_on, form.derived_percent, form.derived_service_ids, form.derived_min, form.derived_max])

  /**
   * Live preview: "18 matching tasks · AED 850 · Handling = AED 255".
   *
   * Computed over the tasks already loaded in the page — the server recompute
   * on save is authoritative, which is why the UI says "loaded tasks".
   */
  const derivedPreview = useMemo(() => {
    if (!derivedRule || !form.client_id || form.client_id === INTERNAL_CLIENT) return null
    const ctx = { clientId: form.client_id, taskDate: form.task_date, rule: derivedRule }
    const basisTasks = tasks.filter(t => isBasisTask(t as never, ctx))
    const basis = sumBasis(basisTasks as never)
    const amounts = computeRule(derivedRule, basis)
    const duplicates = findDuplicateRules(tasks as never, {
      clientId: form.client_id, taskDate: form.task_date,
      serviceIds: derivedRule.sources.serviceIds,
    })
    return { basis, amounts, duplicates }
  }, [derivedRule, form.client_id, form.task_date, tasks])

  // Derived: computed billing amount
  //   1. If user typed a manual override → that wins
  //   2. Else if linked to a parent task → derive from parent + billing_mode
  //   3. Else use the standard pricing-matrix calculation
  const computedAmount = useMemo(() => {
    // Derived tasks are priced by the server from their rule; the preview owns
    // the display, so the matrix engine must not also produce a number here.
    if (form.derived_on) return 0

    // Non-billable variant: ₹0
    if (form.parent_task_id && !form.is_billable) return 0

    // Manual override
    if (form.billing_override && form.manual_billing_amount) {
      return parseFloat(form.manual_billing_amount) || 0
    }

    // Variant of a parent task
    if (parentTask) {
      const parentBilling = parentTask.billing_amount_inr || 0
      let baseVariantAmount = 0
      if (form.billing_mode === 'percent_of_parent') {
        const pct = parseFloat(form.billing_percent) || 0
        baseVariantAmount = Math.round((parentBilling * pct / 100) * 100) / 100
      } else if (form.billing_mode === 'parameter_driven') {
        // Phase 1: surfaced as percent input; Phase 2 will sum parameter weights from contributions
        const pct = parseFloat(form.billing_percent) || 0
        baseVariantAmount = Math.round((parentBilling * pct / 100) * 100) / 100
      } else {
        // billing_mode === 'fixed' on a variant: user enters manual amount via manual_billing_amount
        baseVariantAmount = parseFloat(form.manual_billing_amount) || 0
      }

      // Apply standard quantity scaling based on service type
      if (pricingType === 'fixed_per_creative') return baseVariantAmount * (parseFloat(form.quantity) || 1)
      if (pricingType === 'hourly') return baseVariantAmount * (parseFloat(form.hours) || 1)
      if (pricingType === 'percentage_of_spend') return baseVariantAmount * (parseFloat(form.spend) || 0)
      
      return baseVariantAmount
    }

    // Standard pricing-matrix calculation (original task) — shared engine.
    if (!selectedService) return 0
    return computeTaskAmount({
      pricingType, unitPrice,
      quantity: form.quantity, hours: form.hours, spend: form.spend,
    })
  }, [pricingType, unitPrice, form.quantity, form.hours, form.spend, selectedService,
      parentTask, form.parent_task_id, form.is_billable, form.billing_mode, form.billing_percent,
      form.billing_override, form.manual_billing_amount, form.derived_on])

  const displayUnitPrice = useMemo(() => {
    if (parentTask && !form.billing_override && form.is_billable !== false) {
      if (pricingType === 'fixed_per_creative') return computedAmount / (parseFloat(form.quantity) || 1)
      if (pricingType === 'hourly') return computedAmount / (parseFloat(form.hours) || 1)
      if (pricingType === 'percentage_of_spend') return computedAmount / (parseFloat(form.spend) || 1)
      return computedAmount
    }
    return unitPrice
  }, [parentTask, form.billing_override, form.is_billable, pricingType, computedAmount, form.quantity, form.hours, form.spend, unitPrice])

  // When client or service changes, update currency
  function handleClientChange(clientId: string) {
    const cp = clientPricings.find(p => p.client_id === clientId && p.service_id === form.service_id)
    setForm(p => ({ ...p, client_id: clientId, currency: (cp?.currency as Currency) || p.currency }))
  }

  function handleServiceChange(serviceId: string) {
    const svc = services.find(s => s.id === serviceId)
    const cp = clientPricings.find(p => p.client_id === form.client_id && p.service_id === serviceId)
    const cur = (cp?.currency || svc?.default_currency || 'INR') as Currency
    setForm(p => ({ ...p, service_id: serviceId, currency: cur, quantity: '1', hours: '1' }))
  }

  async function saveQuickPrice() {
    if (!quickSet || !form.service_id) return
    setQuickSaving(true)
    const price = parseFloat(quickSet.price) || 0

    if (quickSet.mode === 'default') {
      await supabase.from('services').update({ default_price: price, default_currency: quickSet.currency }).eq('id', form.service_id)
      setServices(prev => prev.map(s => s.id === form.service_id ? { ...s, default_price: price, default_currency: quickSet.currency } : s))
    } else {
      // commission_percentage is deliberately ABSENT from this payload: an
      // omitted column is left untouched by ON CONFLICT DO UPDATE, so setting
      // a price can never overwrite an agreed commission. Sending 0 here used
      // to zero the pair's commission pool — every reader guards with
      // `?? 50` / `!= null`, and neither catches 0, so past earnings on that
      // pair silently recomputed to zero.
      //
      // is_active: true because entering a price for a client IS the act of
      // committing them to that service; without it a previously deactivated
      // pair would keep the new price but stay hidden from every picker.
      await supabase.from('client_service_pricing').upsert(
        {
          client_id: form.client_id, service_id: form.service_id,
          price, currency: quickSet.currency,
          is_active: true, deactivated_at: null, deactivated_by: null,
        },
        { onConflict: 'client_id,service_id' }
      )
      setClientPricings(prev => {
        const existing = prev.findIndex(p => p.client_id === form.client_id && p.service_id === form.service_id)
        const entry = { client_id: form.client_id, service_id: form.service_id, price, currency: quickSet.currency }
        return existing >= 0 ? prev.map((p, i) => i === existing ? entry : p) : [...prev, entry]
      })
    }
    setQuickSet(null)
    setQuickSaving(false)
  }

  function openEdit(task: Task) {
    setEditTask(task)
    setEditForm({
      id: task.id,
      task_number: task.task_number != null ? String(task.task_number) : '',
      title: task.title,
      description: task.description || '',
      client_id: task.client_id ?? '',   // internal task → '' in the form, saved back as NULL
      service_id: task.service_id,
      status: task.status,
      quantity: task.quantity ? String(task.quantity) : '1',
      hours: '1',
      spend: '',
      currency: task.currency as Currency,
      task_date: task.task_date,
      is_recurring: false,
      recurring_interval: 'monthly',
      recurring_end_date: '',
      // Variant fields (Phase 1): editing variants will get a dedicated panel in Phase 2
      parent_task_id:    task.parent_task_id || '',
      variant_type:      (task.variant_type || '') as '' | 'revision' | 'concept' | 'size',
      variant_label:     task.variant_label || '',
      billing_mode:      (task.billing_mode || 'fixed') as 'fixed' | 'percent_of_parent' | 'parameter_driven',
      billing_percent:   task.billing_percent != null ? String(task.billing_percent) : '',
      billing_override:  !!task.billing_override,
      is_billable:       task.is_billable !== false,
      manual_billing_amount: task.billing_amount_inr != null ? String(task.billing_amount_inr) : '',
      package_id:        task.package_id ?? null,
      // Derived billing is edited in TaskEditModal, not this legacy form state.
      derived_on: false,
      derived_service_ids: [],
      derived_percent: '',
      derived_min: '',
      derived_max: '',
    })
    setQuickSet(null)
  }

  // NOTE: the legacy inline edit form that used to live here has been removed.
  // Editing goes through <TaskEditModal>, which renders the shared
  // TaskBillingSection and saves via serverSaveTask. The old handler carried a
  // fifth copy of the pricing formula and wrote billing straight from the
  // browser.

  async function initiateDelete(id: string) {
    // Check if this task has any contribution scores — if so we show a stronger warning.
    const { count } = await supabase
      .from('contribution_scores')
      .select('*', { count: 'exact', head: true })
      .eq('task_id', id)
    setDeleteConfirmHasScores((count ?? 0) > 0)
    setDeleteConfirm(id)
  }

  async function handleDelete(id: string) {
    setDeleting(true)
    const task = tasks.find(t => t.id === id)
    const res  = await serverDeleteTask(id, task?.title ?? '')
    if (res.ok && res.data) {
      const deletedAt = res.data.deleted_at
      if (task) setTrash(prev => [{ ...task, deleted_at: deletedAt }, ...prev])
      setTasks(prev => prev.filter(t => t.id !== id))
      setDeleteConfirm(null)
      setDeleteConfirmHasScores(false)
      setEditTask(null)
    } else {
      toastError(res.error ?? 'Could not delete task. Please try again.')
      setDeleteConfirm(null)
      setDeleteConfirmHasScores(false)
    }
    setDeleting(false)
  }

  async function handleRestore(id: string) {
    const task = trash.find(t => t.id === id)
    const res  = await serverRestoreTask(id, task?.title ?? '')
    if (res.ok) {
      if (task) {
        const { deleted_at, ...restored } = task
        setTasks(prev => [restored as Task, ...prev])
      }
      setTrash(prev => prev.filter(t => t.id !== id))
    }
  }

  async function handlePermanentDelete(id: string) {
    setDeleting(true)
    const task = trash.find(t => t.id === id)
    const res  = await serverPermanentDeleteTask(id, task?.title ?? '')
    if (res.ok) setTrash(prev => prev.filter(t => t.id !== id))
    setDeleteConfirm(null)
    setDeleting(false)
  }

  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false)
  const [emptyingTrash, setEmptyingTrash] = useState(false)

  async function handleEmptyTrash() {
    setEmptyingTrash(true)
    const res = await serverEmptyTrash(trash.map(t => t.id))
    if (res.ok) {
      setTrash([])
      setEmptyTrashConfirm(false)
    } else {
      toastError(res.error ?? 'Could not empty trash. Please try again.')
    }
    setEmptyingTrash(false)
  }

  async function bulkUpdateStatus(status: string) {
    const ids = [...selectedTasks]
    const res = await serverBulkUpdateStatus(ids, status)
    if (res.ok) {
      setTasks(prev => prev.map(t => selectedTasks.has(t.id) ? { ...t, status } : t))
      setSelectedTasks(new Set())
      setBulkMode(false)
      success(`${ids.length} task${ids.length !== 1 ? 's' : ''} updated to ${getStatusLabel(status)}`)
    } else {
      toastError('Bulk update failed', res.error)
    }
  }

  // ── Bulk assign employees ───────────────────────────────────────────────
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false)
  const [bulkAssignSelected, setBulkAssignSelected] = useState<Set<string>>(new Set())
  const [bulkAssignSaving, setBulkAssignSaving] = useState(false)

  function openBulkAssign() {
    setBulkAssignSelected(new Set())
    setBulkAssignOpen(true)
  }

  async function saveBulkAssign() {
    setBulkAssignSaving(true)
    const ids = [...selectedTasks]
    const empIds = [...bulkAssignSelected]
    const res = await serverBulkAssignEmployees(ids, empIds)
    setBulkAssignSaving(false)
    if (res.ok) {
      setBulkAssignOpen(false)
      setSelectedTasks(new Set())
      setBulkMode(false)
      success(`${ids.length} task${ids.length !== 1 ? 's' : ''} reassigned`)
    } else {
      toastError('Bulk assign failed', res.error)
    }
  }

  // ── Bulk delete (soft) ──────────────────────────────────────────────────
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  async function confirmBulkDelete() {
    setBulkDeleting(true)
    const targets = tasks.filter(t => selectedTasks.has(t.id)).map(t => ({ id: t.id, title: t.title }))
    const res = await serverBulkDeleteTasks(targets)
    setBulkDeleting(false)
    if (res.ok) {
      setTrash(prev => [...targets.map(t => ({ ...(tasks.find(tk => tk.id === t.id) as Task), deleted_at: res.data!.deletedAt })), ...prev])
      setTasks(prev => prev.filter(t => !selectedTasks.has(t.id)))
      setSelectedTasks(new Set())
      setBulkMode(false)
      setBulkDeleteConfirm(false)
      success(`${targets.length} task${targets.length !== 1 ? 's' : ''} moved to trash`)
    } else {
      toastError('Bulk delete failed', res.error)
      setBulkDeleteConfirm(false)
    }
  }

  async function duplicateTask(task: Task) {
    if (duplicatingId) return            // guard against double-clicks (would burn two numbers)
    setDuplicatingId(task.id)
    try {
      const maxRow = await supabase.from('tasks').select('task_number').order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      const tn = nextTaskNumber(maxRow.data?.task_number)
      const duplicateRow = {
        task_number: tn,
        title: task.title,
        description: task.description,
        client_id: task.client_id,
        service_id: task.service_id,
        status: 'pending',
        billing_amount: task.billing_amount,
        billing_amount_inr: task.billing_amount_inr,
        currency: task.currency,
        task_date: todayISO(),
        quantity: task.quantity || 1,
        scope: deriveWorkScope(task.client_id),
      }
      const { data, error } = await retryWithoutScope(strip =>
        supabase.from('tasks').insert(strip ? withoutScope(duplicateRow) : duplicateRow)
          .select('*, client:clients(id,name,code), service:services(id,name)').single()
      )
      if (data) {
        setTasks(prev => [data as Task, ...prev])
        // Source had no amount (e.g. pricing was hidden or unset when it was
        // created) → backfill from client/service pricing server-side.
        if (!(data as Task).billing_amount_inr && data.service_id) {
          void serverFillTaskBilling(data.id, data.client_id || null, data.service_id, data.quantity || 1)
        }
        success(`Task duplicated as ${taskCode(data as Task)}`)
      } else if (error) {
        toastError('Failed to duplicate', error.message)
      }
    } finally {
      setDuplicatingId(null)
    }
  }

  // Recurring instances are generated just-in-time by the daily
  // /api/cron/recurring-tasks job (see src/app/api/cron/recurring-tasks/route.ts)
  // — not pre-generated here. A series' parent task only needs
  // is_recurring/recurring_interval/recurring_end_date saved on it; the cron
  // creates each occurrence the day it's actually due.

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setAddError(null)
    const qty = resolveTaskQuantity({
      pricingType, quantity: form.quantity, hours: form.hours, spend: form.spend,
    })

    // Compute next task_number (sequential, starting at 1)
    const maxRow = await supabase.from('tasks').select('task_number').order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    const tn = form.task_number ? parseInt(form.task_number, 10) : nextTaskNumber(maxRow.data?.task_number)

    // Snapshot the billing math (per-group breakdown for parameter-driven, or the
    // simple percent/fixed formula) so historical invoices stay stable even if
    // weights are tuned later. Split out from the payload so we can gracefully
    // retry WITHOUT it on databases where migration 003 (the billing_snapshot
    // column) hasn't been applied yet — otherwise every variant insert fails.
    const billingSnapshot = !form.parent_task_id ? null
      : form.billing_mode === 'parameter_driven' ? {
          formula:         'parameter_driven',
          parent_billing:  parentTask?.billing_amount_inr ?? 0,
          total_fraction:  computeTotalFraction(),
          computed_amount: computedAmount,
          computed_at:     new Date().toISOString(),
          groups:          groups.map(g => {
            const groupParams = parameters.filter(p => p.group_id === g.id && variantParamIds.has(p.id))
            if (groupParams.length === 0) return null
            const internalShare = computeGroupShare(g.id)
            return {
              group_id:               g.id,
              group_name:             g.name,
              group_weight:           g.weight || 0,
              group_weight_normalized: variantGroupPortion(g.id),
              internal_share:         internalShare,
              contribution_to_parent: variantGroupPortion(g.id) * internalShare * 100,
              selections: groupParams.map(p => ({
                parameter_id: p.id,
                name:         p.name,
                weight:       p.weight,
                value:        parseFloat(variantParamValues[p.id] || '1') || 0,
                input_type:   p.input_type || 'count',
                is_master:    !!p.is_master,
              })),
            }
          }).filter(Boolean),
        }
      : {
          formula:         form.billing_mode,
          parent_billing:  parentTask?.billing_amount_inr ?? 0,
          percent:         form.billing_percent ? parseFloat(form.billing_percent) : null,
          computed_amount: computedAmount,
          computed_at:     new Date().toISOString(),
        }

    const insertPayload: Record<string, unknown> = {
      task_number: tn,
      title: form.title,
      description: form.description || null,
      // Empty or the Internal sentinel → NULL: internal Cirqle work with no
      // client. The task→invoice trigger ignores NULL-client tasks entirely.
      client_id: form.client_id && form.client_id !== INTERNAL_CLIENT ? form.client_id : null,
      // Finance dimension — explicit, mirroring the client_id rule above.
      scope: deriveWorkScope(form.client_id && form.client_id !== INTERNAL_CLIENT ? form.client_id : null),
      service_id: form.service_id,
      status: form.status,
      billing_amount: computedAmount,
      billing_amount_inr: computedAmount,
      quantity: qty,
      currency: unitCurrency,
      // Invoicing only — the price above still came from the Pricing Matrix.
      ...(form.package_id ? { package_id: form.package_id } : {}),
      task_date: form.task_date,
      is_recurring: form.is_recurring,
      recurring_interval: form.is_recurring ? form.recurring_interval : null,
      recurring_end_date: form.is_recurring && form.recurring_end_date ? form.recurring_end_date : null,
      // ── Variant fields — only included when the user actually linked a parent task,
      //    so original-task inserts still work even if migration 002 hasn't been run yet ──
      ...(form.parent_task_id ? {
        parent_task_id:   form.parent_task_id,
        variant_type:     form.variant_type || null,
        variant_label:    form.variant_label || null,
        billing_mode:     form.billing_mode,
        billing_percent:  form.billing_percent ? parseFloat(form.billing_percent) : null,
        billing_override: form.billing_override,
        is_billable:      form.is_billable,
      } : {}),
      // ── Derived billing — amounts start at 0; serverFillTaskBilling computes
      //    the real figure from the rule right after this insert. ──
      ...(derivedRule ? {
        billing_mode: 'percent_of_services',
        billing_rule: derivedRule,
        billing_amount: 0,
        billing_amount_inr: 0,
        quantity: 1,
      } : {}),
    }

    const selectCols = `*, client:clients(id, name, code), service:services(id, name)`
    let { data, error } = await supabase
      .from('tasks')
      .insert(billingSnapshot ? { ...insertPayload, billing_snapshot: billingSnapshot } : insertPayload)
      .select(selectCols)
      .single()

    // Graceful fallback for DBs missing migration 003: the billing_snapshot
    // column doesn't exist → retry without it. The amount is already frozen in
    // billing_amount_inr, so the task saves correctly; only the audit snapshot
    // is skipped (run migration 003 to capture it for parameter-driven variants).
    if (error && /billing_snapshot/i.test(`${error.message ?? ''} ${(error as { details?: string }).details ?? ''}`)) {
      console.warn('tasks.billing_snapshot missing — saving variant without snapshot. Apply migrations/003_billing_snapshot.sql.')
      ;({ data, error } = await supabase.from('tasks').insert(insertPayload).select(selectCols).single())
    }

    // Pre-scope-migration DBs: retry without the scope column (the Phase-1
    // trigger normally derives it; here it simply isn't stored yet).
    if (error && isScopeColumnMissing(error)) {
      console.warn('tasks.scope missing — saving without scope. Apply supabase/migrations/20260714090000_finance_scope_foundation.sql.')
      ;({ data, error } = await supabase.from('tasks').insert(withoutScope(insertPayload)).select(selectCols).single())
    }

    if (!error && data) {
      setTasks(prev => [data, ...prev])

      // Log task created (fire-and-forget server action — doesn't block UI)
      void logTaskCreated(data.id, data.title, data.task_number ?? null)

      // Promotion flow: link the created task back to the external request
      // (sets request → started, logs activity, emails the requester).
      if (promotingRequestId) {
        void markRequestPromoted(promotingRequestId, data.id, data.task_number ?? null)
          .then(res => {
            if (res.ok) success('Request promoted', `Task #${data.task_number ?? ''} linked — requester notified`)
            else toastError('Task created, but linking the request failed', res.error)
          })
          .catch(() => {})
        setPromotingRequestId(null)
      }

      // If the user can't see pricing, billing_amount was inserted as 0.
      // Backfill the correct price server-side (admin client reads pricing tables).
      // Fire-and-forget — the employee's UI intentionally never sees the price.
      if (!showBilling && form.service_id) {
        void serverFillTaskBilling(
          data.id,
          form.client_id || null,
          form.service_id,
          pricingType === 'fixed_per_creative' ? (parseFloat(form.quantity) || 1) : 1,
        )
      }

      // A derived task was inserted at 0 — price it now from its rule. The
      // server re-reads the month's real sources, so this is authoritative
      // even when the page had only part of the month loaded for the preview.
      if (derivedRule) {
        void serverFillTaskBilling(data.id, form.client_id || null, form.service_id, 1)
          .then(async () => {
            // Pull the computed amount back into the row we just optimistically
            // added, so the list shows the real figure without a full reload.
            const { data: priced } = await supabase
              .from('tasks').select(selectCols).eq('id', data!.id).single()
            if (priced) setTasks(prev => prev.map(t => t.id === data!.id ? (priced as Task) : t))
          })
          .catch(() => {})
      }

      // ── Auto-create contribution slots from the selected billable parameters ──
      // One-way sync: billing parameters → contribution rows. Each row inherits the value
      // entered at billing time. Employees fill in who did each part later; editing
      // contributions does NOT flow back to billing (snapshot is frozen).
      if (form.parent_task_id && form.billing_mode === 'parameter_driven' && variantParamIds.size > 0) {
        // Phase 3.0 — guarded server action instead of a direct browser insert.
        const slotRes = await createContributionSlots(
          data.id,
          [...variantParamIds].map(parameterId => ({
            parameterId,
            value: parseFloat(variantParamValues[parameterId] || '1') || 0,
          })),
        )
        if (!slotRes.ok) {
          console.warn('Auto-creating contribution slots failed:', slotRes.error)
          toastError(`Task saved, but contribution slots couldn't be pre-filled: ${slotRes.error}`)
        }
      }

      // Recurring instances are NOT pre-generated here — the daily
      // /api/cron/recurring-tasks job creates each occurrence only once its
      // own scheduled date arrives (just-in-time), so Tasks never fills up
      // with months of not-yet-actionable future work. The parent row saved
      // above (is_recurring/recurring_interval/recurring_end_date) is all
      // that cron needs.

      setShowForm(false)
      setForm({ ...EMPTY_FORM, task_date: todayISO() })
      success(`Task #${tn} added`)
    } else if (error) {
      // Surface the DB error to the user (e.g. missing variant columns if migration 002 wasn't run yet).
      // Supabase PostgrestError has non-enumerable props — pull them out explicitly so we don't log {}.
      const err = error as { message?: string; details?: string; hint?: string; code?: string }
      const parts = [err.message, err.details, err.hint, err.code && `(${err.code})`].filter(Boolean)
      const detail = parts.join(' · ') || 'Unknown database error'
      console.warn('Add task failed:', { message: err.message, details: err.details, hint: err.hint, code: err.code })
      setAddError(detail)
      toastError(`Add task failed: ${detail}`)
    }
    setSaving(false)
  }

  async function updateStatus(id: string, status: string) {
    if (status === 'cancelled') {
      // Open the cancellation wizard instead of saving directly
      const task = tasks.find(t => t.id === id)
      if (task) {
        setCancelForm({
          cancelled_by:        'client',
          completion_pct:      task.status === 'done' ? 100 : task.status === 'delivered' ? 90 : task.status === 'in_progress' ? 70 : 10,
          honor_contributions: task.status === 'in_progress' || task.status === 'done' || task.status === 'delivered',
          loss_amount:         task.billing_amount_inr ? String(Math.round(task.billing_amount_inr * 0.7)) : '',
          notes:               '',
          record_cashbook:     true,
        })
        setCancelModal(task)
      }
      return
    }
    const task = tasks.find(t => t.id === id)
    const prevStatus = task?.status ?? ''
    // Optimistic update — show new status immediately, revert on failure
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status } : t))
    const res = await serverUpdateTaskStatus(id, task?.title ?? '', prevStatus, status)
    if (!res.ok) {
      // Revert optimistic update and show error
      setTasks(prev => prev.map(t => t.id === id ? { ...t, status: prevStatus } : t))
      toastError('Status update failed', res.error)
    }
  }

  function openAssignModal(task: { id: string; task_number?: number | null; title: string; service_id?: string }) {
    const current = localAssignments.filter(a => a.task_id === task.id).map(a => a.employee_id)
    setAssignSelected(new Set(current))

    // Pre-load saved groups for this task OR default to service-linked groups
    const savedGroupIds = localTaskGroups.filter(tg => tg.task_id === task.id).map(tg => tg.group_id)
    if (savedGroupIds.length > 0) {
      setSelectedGroups(new Set(savedGroupIds))
    } else if (task.service_id) {
      const defaultGroupIds = groupServices.filter(gs => gs.service_id === task.service_id).map(gs => gs.group_id)
      setSelectedGroups(new Set(defaultGroupIds))
    } else {
      setSelectedGroups(new Set())
    }

    // Build empGroups and empParams from existing assignments (employee-centric)
    const newEmpGroups: Record<string, Set<string>> = {}
    localGroupAssignments.filter(a => a.task_id === task.id).forEach(a => {
      if (!newEmpGroups[a.employee_id]) newEmpGroups[a.employee_id] = new Set()
      newEmpGroups[a.employee_id].add(a.group_id)
    })
    setEmpGroups(newEmpGroups)

    const newEmpParams: Record<string, Set<string>> = {}
    localParamAssignments.filter(a => a.task_id === task.id).forEach(a => {
      if (!newEmpParams[a.employee_id]) newEmpParams[a.employee_id] = new Set()
      newEmpParams[a.employee_id].add(a.parameter_id)
    })
    setEmpParams(newEmpParams)

    // Expand cards that have any assignment
    setExpandedEmpCards(new Set([
      ...Object.keys(newEmpGroups),
      ...Object.keys(newEmpParams),
    ]))

    setAssignModal({ taskId: task.id, taskNumber: task.task_number, taskTitle: task.title, serviceId: task.service_id })
  }

  async function saveAssignments() {
    if (!assignModal) return
    setAssignSaving(true)
    const tid = assignModal.taskId

    // 1. Save task-level employee assignments.
    // Delete-then-insert: supabase-js returns errors rather than throwing, so
    // check the insert. If it fails after the delete, every assignee would be
    // silently wiped while the UI reports success — surface it and abort.
    const delAssign = await supabase.from('task_assignments').delete().eq('task_id', tid)
    if (delAssign.error) {
      setAssignSaving(false)
      toastError('Failed to save assignments', delAssign.error.message)
      return
    }
    if (assignSelected.size > 0) {
      const insAssign = await supabase.from('task_assignments').insert(
        [...assignSelected].map(empId => ({ task_id: tid, employee_id: empId }))
      )
      if (insAssign.error) {
        setAssignSaving(false)
        toastError('Failed to save assignments', insAssign.error.message)
        return
      }
    }
    setLocalAssignments(prev => [
      ...prev.filter(a => a.task_id !== tid),
      ...[...assignSelected].map(empId => ({ task_id: tid, employee_id: empId }))
    ])

    // 2. Active groups = union of all groups assigned to anyone
    const activeGroupIds = new Set<string>()
    Object.values(empGroups).forEach(set => set.forEach(gId => activeGroupIds.add(gId)))
    setSelectedGroups(activeGroupIds)

    // Save group selections (graceful — table may not exist)
    try {
      await supabase.from('task_groups').delete().eq('task_id', tid)
      if (activeGroupIds.size > 0) {
        await supabase.from('task_groups').insert(
          [...activeGroupIds].map(gId => ({ task_id: tid, group_id: gId }))
        )
      }
      setLocalTaskGroups(prev => [
        ...prev.filter(tg => tg.task_id !== tid),
        ...[...activeGroupIds].map(gId => ({ task_id: tid, group_id: gId }))
      ])
    } catch { /* task_groups table may not exist yet */ }

    // 3. Save task_group_assignments rows (many per group allowed)
    try {
      await supabase.from('task_group_assignments').delete().eq('task_id', tid)
      const groupRows: { task_id: string; group_id: string; employee_id: string }[] = []
      Object.entries(empGroups).forEach(([empId, gSet]) => {
        gSet.forEach(gId => groupRows.push({ task_id: tid, group_id: gId, employee_id: empId }))
      })
      if (groupRows.length > 0) {
        await supabase.from('task_group_assignments').insert(groupRows)
      }
      setLocalGroupAssignments(prev => [
        ...prev.filter(a => a.task_id !== tid),
        ...groupRows
      ])
    } catch { /* task_group_assignments table may not exist yet */ }

    // 4. Save task_parameter_assignments rows (many per param allowed)
    try {
      await supabase.from('task_parameter_assignments').delete().eq('task_id', tid)
      const paramRows: { task_id: string; parameter_id: string; employee_id: string }[] = []
      Object.entries(empParams).forEach(([empId, pSet]) => {
        pSet.forEach(pId => paramRows.push({ task_id: tid, parameter_id: pId, employee_id: empId }))
      })
      if (paramRows.length > 0) {
        await supabase.from('task_parameter_assignments').insert(paramRows)
      }
      setLocalParamAssignments(prev => [
        ...prev.filter(a => a.task_id !== tid),
        ...paramRows
      ])
    } catch { /* task_parameter_assignments table may not exist yet */ }

    // Record the assignment on the task's activity timeline (fire-and-forget).
    logTaskAssignment(tid, {
      employees: [...assignSelected]
        .map(id => { const e = employees.find(x => x.id === id); return e ? dn(e) : null })
        .filter((s): s is string => !!s),
    }).catch(() => { /* logging is best-effort */ })

    setAssignSaving(false)
    setAssignModal(null)
  }

  async function handleCancellation() {
    if (!cancelModal) return
    setCancelSaving(true)
    const lossAmt = parseFloat(cancelForm.loss_amount) || 0

    // Delegate to server action (DB + log + cashbook entry in one place)
    const res = await serverCancelTask({
      taskId:             cancelModal.id,
      taskTitle:          cancelModal.title,
      cancelledBy:        cancelForm.cancelled_by,
      notes:              cancelForm.notes || null,
      honorContributions: cancelForm.honor_contributions,
      lossAmount:         lossAmt,
      completionPct:      cancelForm.completion_pct,
      recordCashbook:     cancelForm.record_cashbook,
      taskDate:           cancelModal.task_date,
      clientName:         cancelModal.client?.name ?? null,
    })
    if (!res.ok) {
      toastError('Cancel failed', res.error)
      setCancelSaving(false)
      return
    }

    // Update local state
    setTasks(prev => prev.map(t => t.id === cancelModal.id ? {
      ...t,
      status:               'cancelled',
      cancelled_by:         cancelForm.cancelled_by,
      cancellation_notes:   cancelForm.notes || null,
      honor_contributions:  cancelForm.honor_contributions,
      loss_amount:          lossAmt,
      completion_pct:       cancelForm.completion_pct,
    } : t))

    setCancelModal(null)
    setCancelSaving(false)
  }

  // Pre-compute the task-id Set the assignee filter resolves to.
  // - null → no filter active
  // - Set  → filter by membership
  // For the "My Tasks" path (employee filtering by their own id), we use the
  // server-provided `myTaskIds` which includes ALL contribution history
  // (assignments + group/param assignments + scores + contributions); without
  // this we'd miss tasks the employee has scored on but isn't an assignee of.
  const myTaskIdSet = useMemo(
    () => new Set(myTaskIds ?? []),
    [myTaskIds],
  )
  const assigneeTaskIdSet = useMemo(() => {
    if (!filterAssignee) return null
    const isOwnFilter = role === 'employee' && currentEmployee && filterAssignee === currentEmployee.id
    if (isOwnFilter) return myTaskIdSet
    const s = new Set<string>()
    for (const a of localAssignments)      if (a.employee_id === filterAssignee) s.add(a.task_id)
    for (const a of localGroupAssignments) if (a.employee_id === filterAssignee) s.add(a.task_id)
    for (const a of localParamAssignments) if (a.employee_id === filterAssignee) s.add(a.task_id)
    return s
  }, [filterAssignee, localAssignments, localGroupAssignments, localParamAssignments, role, currentEmployee, myTaskIdSet])

  // Tokenized search field map — Amount only when pricing is visible.
  const TASK_FIELDS: Record<string, FacetFieldDef> = useMemo(() => ({
    title:   { type: 'text',   get: (x: Task) => x.title },
    client:  { type: 'text',   get: (x: Task) => x.client?.name },
    service: { type: 'text',   get: (x: Task) => x.service?.name },
    task:    { type: 'number', get: (x: Task) => x.task_number },
    ...(showBilling ? { amount: { type: 'number' as const, get: (x: Task) => x.billing_amount_inr } } : {}),
  }), [showBilling])

  const filteredTasks = useMemo(() => {
    let t = tasks
    if (filterStatus)  t = t.filter(x => x.status === filterStatus)
    if (filterClient)  t = filterClient === INTERNAL_CLIENT ? t.filter(x => !x.client_id) : t.filter(x => x.client?.id === filterClient)
    if (filterService) t = t.filter(x => x.service?.id === filterService)
    // Named search facets (Title / Client / Service / Task # / Amount) with
    // operators — OR within a field, AND across. Generic text is handled by the
    // searchQ block below (preserves #number exact + float-to-top).
    if (namedFacets.length) t = t.filter(x => recordMatchesFacets(namedFacets, x, TASK_FIELDS, () => ''))
    if (searchQ) {
      const trimmed = searchQ.trim()
      if (trimmed.startsWith('#')) {
        // Exact task-number search: #1 → only task #1, not #10, #11, #100
        const num = parseInt(trimmed.slice(1), 10)
        t = isNaN(num) ? [] : t.filter(x => x.task_number === num)
      } else {
        const q = trimmed.toLowerCase()
        // General search — title, client, service, or partial number match
        // Exact number matches float to the top
        const exact: typeof t = []
        const rest:  typeof t = []
        t.forEach(x => {
          const matches =
            x.title?.toLowerCase().includes(q) ||
            x.client?.name?.toLowerCase().includes(q) ||
            (!x.client_id && 'internal'.includes(q)) ||   // "internal" finds client-less tasks
            x.service?.name?.toLowerCase().includes(q) ||
            taskCodeMatches(x, trimmed)
          if (!matches) return
          // put exact task-number match first (e.g. query "1" → #1 before #10)
          if (x.task_number != null && String(x.task_number) === q) exact.push(x)
          else rest.push(x)
        })
        t = [...exact, ...rest]
      }
    }
    if (filterDate) {
      t = t.filter(task => matchesDateFilter(task.task_date, filterDate))
    }
    if (assigneeTaskIdSet) {
      const ids = assigneeTaskIdSet
      t = t.filter(task => ids.has(task.id))
    }
    if (myScope === 'mine')     t = t.filter(task => myTaskIdSet.has(task.id))
    if (myScope === 'not_mine') t = t.filter(task => !myTaskIdSet.has(task.id))
    if (sortBy === 'today_first') {
      // Today at top → upcoming ascending (soonest next) → past descending (most recent first)
      const today = todayISO()
      t = [...t].sort((a, b) => {
        const aDate = a.task_date || ''
        const bDate = b.task_date || ''
        const aIsToday = aDate === today
        const bIsToday = bDate === today
        if (aIsToday !== bIsToday) return aIsToday ? -1 : 1
        const aFuture = aDate > today
        const bFuture = bDate > today
        if (aFuture !== bFuture) return aFuture ? -1 : 1
        return aFuture
          ? aDate.localeCompare(bDate)   // upcoming: soonest first
          : bDate.localeCompare(aDate)   // past: most recent first
      })
    }
    if (sortBy === 'date_asc')    t = [...t].sort((a, b) => (a.task_date || '').localeCompare(b.task_date || ''))
    if (sortBy === 'date_desc')   t = [...t].sort((a, b) => (b.task_date || '').localeCompare(a.task_date || ''))
    if (sortBy === 'amount_desc') t = [...t].sort((a, b) => ((b.billing_amount_inr ?? 0)) - ((a.billing_amount_inr ?? 0)))
    if (sortBy === 'client')      t = [...t].sort((a, b) => (a.client?.name || '').localeCompare(b.client?.name || ''))
    return t
  }, [tasks, filterStatus, filterClient, filterService, searchQ, namedFacets, sortBy, filterDate, assigneeTaskIdSet, myScope, myTaskIdSet])

  // visibleTasks is a passthrough — filtering is fully handled by filteredTasks above.
  // (The comment "only show their assigned tasks" was stale — server already scopes the array.)
  const visibleTasks = useMemo(() => {
    return filteredTasks
  }, [filteredTasks])

  // Reset to page 0 and clear DB search results when filters/search/sort change
  useEffect(() => { setTablePage(0); setDbSearchResults(null); exitDbMode() }, [filterStatus, filterClient, filterService, searchQ, sortBy, filterAssignee, filterDate, myScope])

  // ── Auto-fallback to database search ──────────────────────────────────────
  // When the user types a query (especially #number) and finds nothing in the
  // loaded set, automatically search the database after a short debounce.
  // Skipped entirely when all tasks are already loaded — then the local
  // result is definitive and a DB round-trip would just be wasted latency.
  useEffect(() => {
    if (dbMode) return                    // already in DB mode, don't re-trigger
    if (!canDbSearch) return              // employees: runDbSearch is a no-op for them
    if (!searchQ.trim() && !filterClient) return  // need at least a search or client filter
    if (filteredTasks.length > 0) return  // local results exist — no need to hit DB
    // Skip if loaded set is complete (DB has nothing extra)
    if (dbTaskTotal != null && dbTaskTotal <= tasks.length) return

    const handle = setTimeout(() => {
      // Only auto-search if we still have nothing locally
      if (filteredTasks.length === 0) runDbSearch(0)
    }, 350)                                // 350ms debounce — feels instant but cheap

    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ, filterClient, filterService, filterStatus, filteredTasks.length])

  // Paginated slice for the table view (board/calendar use full visibleTasks)
  // When DB mode is active, we use dbModeResults instead of the in-memory visibleTasks
  const totalPages = dbMode
    ? Math.ceil((dbModeTotal ?? dbModeResults.length) / DB_PAGE_SIZE)
    : Math.ceil(visibleTasks.length / tablePageSize)
  const pagedTasks = dbMode
    ? dbModeResults
    : searchQ
      ? visibleTasks              // when searching locally, show all matches on one page
      : visibleTasks.slice(tablePage * tablePageSize, (tablePage + 1) * tablePageSize)
  
  const mobileTasks = dbMode
    ? dbModeResults.slice(0, mobileLimit)
    : visibleTasks.slice(0, mobileLimit)

  const hasActiveFilters = !!(filterStatus || filterClient || filterService || searchQ || sortBy !== 'today_first' || !!filterAssignee || !!filterDate || !!myScope)
  const activeFilterCount = [filterClient, filterService, filterAssignee, sortBy !== 'today_first' ? 'sort' : '', myScope || ''].filter(Boolean).length

  // Status counts — computed from tasks before status filter is applied so all
  // tabs show real numbers. Reuses the same assigneeTaskIdSet so the inner
  // loop is O(1) per task instead of O(assignments × 3 tables) per task.
  const statusCounts = useMemo(() => {
    const base = tasks.filter(t => {
      if (filterClient === INTERNAL_CLIENT ? !!t.client_id : (filterClient && t.client?.id !== filterClient)) return false
      if (filterService && t.service?.id !== filterService) return false
      if (assigneeTaskIdSet && !assigneeTaskIdSet.has(t.id)) return false
      if (filterDate && !matchesDateFilter(t.task_date, filterDate)) return false
      return true
    })
    const counts: Record<string, number> = { all: base.length }
    // Single pass over `base` to fill all status counts instead of N filter() calls.
    for (const s of STATUSES) counts[s] = 0
    for (const t of base) {
      if (counts[t.status] !== undefined) counts[t.status]++
    }
    return counts
  }, [tasks, filterClient, filterService, filterDate, assigneeTaskIdSet])

  // Settled statuses (done / invoiced / cancelled) are only loaded inside the
  // TASKS_HISTORY_MONTHS window, so their counts are a FLOOR, not a total. Live
  // statuses are always loaded in full at any age, so those stay exact.
  // Presenting a windowed number as if it were authoritative is what made
  // "Done 830" read as fact when the database holds 1,750 — mark it instead.
  const countsArePartial = !fullHistory && dbTaskTotal != null && dbTaskTotal > tasks.length
  const EXACT_COUNT_STATUSES = ['pending', 'in_progress', 'delivered']
  const isPartialCount = (key: string) => countsArePartial && !EXACT_COUNT_STATUSES.includes(key)
  const fmtStatusCount = (key: string, n: number) => isPartialCount(key) ? `${n}+` : `${n}`
  const partialCountTitle = (key: string, label: string, n: number) =>
    isPartialCount(key)
      ? `${n} ${label.toLowerCase()} tasks loaded. Older ones sit outside the default history window — use "Load full history" (or "Search DB") for the true total.`
      : undefined

  // Client filter options: merge active clients (from props) with any unique clients
  // found in loaded tasks — this ensures inactive clients like old imported ones still appear
  const clientFilterOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: { value: string; label: string }[] = []
    clients.forEach(c => { seen.add(c.id); result.push({ value: c.id, label: c.name }) })
    tasks.forEach(t => {
      if (t.client && !seen.has(t.client.id)) {
        seen.add(t.client.id)
        result.push({ value: t.client.id, label: t.client.name })
      }
    })
    result.sort((a, b) => a.label.localeCompare(b.label))
    // "Internal" pinned first — filters to tasks with NO client (Cirqle's own work).
    return [{ value: INTERNAL_CLIENT, label: 'Internal — Cirqle' }, ...result]
  }, [clients, tasks])

  // ── Smart Mode: with a date filter active, dropdowns only offer values that
  // actually occur in tasks within the selected period (current selection is
  // always kept so it can be cleared). FilterDropdown handles recency/frequency
  // ordering via sortKey.
  const dateScopedTasks = useMemo(
    () => (filterDate ? tasks.filter(t => matchesDateFilter(t.task_date, filterDate)) : null),
    [tasks, filterDate],
  )
  const scopedClientOptions = useMemo(() => {
    if (!dateScopedTasks) return clientFilterOptions
    const ids = new Set(dateScopedTasks.map(t => t.client?.id).filter(Boolean))
    const hasInternal = dateScopedTasks.some(t => !t.client_id)
    return clientFilterOptions.filter(o =>
      ids.has(o.value) || o.value === filterClient || (o.value === INTERNAL_CLIENT && hasInternal))
  }, [dateScopedTasks, clientFilterOptions, filterClient])
  const scopedServiceOptions = useMemo(() => {
    const all = services.map(s => ({ value: s.id, label: s.name }))
    if (!dateScopedTasks) return all
    const ids = new Set(dateScopedTasks.map(t => t.service?.id).filter(Boolean))
    return all.filter(o => ids.has(o.value) || o.value === filterService)
  }, [dateScopedTasks, services, filterService])
  const scopedAssigneeOptions = useMemo(() => {
    const all = employees.map(emp => ({ value: emp.id, label: dn(emp) }))
    if (!dateScopedTasks) return all
    const taskIds = new Set(dateScopedTasks.map(t => t.id))
    const ids = new Set<string>()
    for (const a of localAssignments)      if (taskIds.has(a.task_id)) ids.add(a.employee_id)
    for (const a of localGroupAssignments) if (taskIds.has(a.task_id)) ids.add(a.employee_id)
    for (const a of localParamAssignments) if (taskIds.has(a.task_id)) ids.add(a.employee_id)
    return all.filter(o => ids.has(o.value) || o.value === filterAssignee)
  }, [dateScopedTasks, employees, dn, localAssignments, localGroupAssignments, localParamAssignments, filterAssignee])

  // py-2.5 on mobile = 40px touch target; py-2 keeps desktop density unchanged.
  const inputCls = 'w-full bg-background border border-input rounded-lg px-3 py-2.5 sm:py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50'

  // Renders the correct <td> for a given column key + task. Used by the table body
  // to honour the user's chosen column order.
  function renderCell(key: ColKey, task: Task) {
    const stopInline = (e: React.MouseEvent) => { if (inlineEditMode) e.stopPropagation() }
    switch (key) {
      case 'client': return (
        <td key={key} className="px-5 py-3.5 text-muted-foreground" onClick={stopInline}>
          {inlineEditMode ? (
            <select value={task.client_id ?? ''} onChange={async e => {
              const newId = e.target.value || null   // '' = internal (no client)
              await serverInlineTaskUpdate(task.id, { client_id: newId })
              const c = newId ? clients.find(x => x.id === newId) : undefined
              setTasks(prev => prev.map(t => t.id === task.id ? { ...t, client_id: newId, client: c ? { id: c.id, name: c.name, code: c.code } : undefined } : t))
            }} className="bg-secondary border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500/50 w-full">
              <option value="">Internal — Cirqle</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.code ? `${c.name} · ${c.code}` : c.name}</option>)}
            </select>
          ) : task.client ? (
            <span>
              {task.client.name}
              {task.client.code && <span className="ml-1.5 text-[10px] font-mono text-muted-foreground/50">{task.client.code}</span>}
            </span>
          ) : (
            <InternalBadge />
          )}
        </td>
      )
      case 'service': return (
        <td key={key} className="px-5 py-3.5 text-muted-foreground" onClick={stopInline}>
          {inlineEditMode ? (
            <select value={task.service_id} onChange={async e => {
              const newId = e.target.value
              await serverInlineTaskUpdate(task.id, { service_id: newId })
              const s = sortedServices.find(x => x.id === newId)
              setTasks(prev => prev.map(t => t.id === task.id ? { ...t, service_id: newId, service: s ? { id: s.id, name: s.name } : undefined } : t))
            }} className="bg-secondary border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500/50 w-full">
              {sortedServices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : (task.service?.name || '—')}
        </td>
      )
      case 'date': return (
        <td key={key} className="px-5 py-3.5 text-muted-foreground whitespace-nowrap" onClick={stopInline}>
          {inlineEditMode ? (
            <input type="date" defaultValue={task.task_date} onBlur={async e => {
              const val = e.target.value
              if (val && val !== task.task_date) {
                await serverInlineTaskUpdate(task.id, { task_date: val })
                setTasks(prev => prev.map(t => t.id === task.id ? { ...t, task_date: val } : t))
              }
            }} className="bg-secondary border border-border rounded px-2 py-1 text-xs focus:outline-none focus:border-violet-500/50" />
          ) : <span title={fullTaskDate(task.task_date)}>{formatTaskDate(task.task_date)}</span>}
        </td>
      )
      case 'billing': return (
        <td key={key} className="px-5 py-3.5 text-right font-medium" onClick={stopInline}>
          {role !== 'team_lead' && inlineEditMode ? (
            <input type="number" defaultValue={task.billing_amount ?? 0} onBlur={async e => {
              const val = parseFloat(e.target.value) || 0
              if (val !== task.billing_amount) {
                await serverInlineTaskUpdate(task.id, { billing_amount: val }, task.currency || undefined)
                setTasks(prev => prev.map(t => t.id === task.id ? { ...t, billing_amount: val } : t))
              }
            }} className="w-24 bg-secondary border border-border rounded px-2 py-1 text-sm text-right focus:outline-none focus:border-violet-500/50" />
          ) : formatCurrency((task.billing_amount ?? 0) / (task.quantity ?? 1), task.currency as Currency)}
        </td>
      )
      case 'qty': return (
        <td key={key} className="px-4 py-3.5 text-center text-sm font-medium text-foreground" onClick={stopInline}>
          {task.quantity ?? 1}
        </td>
      )
      case 'total': return (
        <td key={key} className="px-5 py-3.5 text-right font-medium" onClick={stopInline}>
          {formatCurrency(task.billing_amount ?? 0, task.currency as Currency)}
        </td>
      )
      case 'status': return (
        <td key={key} className="px-5 py-3.5" onClick={e => e.stopPropagation()}>
          <select value={task.status} onChange={e => updateStatus(task.id, e.target.value)}
            className={`text-xs px-2 py-1 rounded-md border-0 cursor-pointer ${getStatusColor(task.status)}`}
            style={{ background: 'transparent' }}>
            {manualStatusOptions(task.status).map(s => <option key={s} value={s} className="bg-card text-foreground">{getStatusLabel(s)}</option>)}
            {task.status === 'invoiced' && <option value="invoiced" className="bg-card text-foreground" disabled>🔒 Invoiced (system)</option>}
          </select>
          {task.status === 'cancelled' && task.cancelled_by && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                {task.cancelled_by === 'client' ? '👤 Client' : task.cancelled_by === 'no_show' ? '🚫 No-show' : '🏢 Company'}
              </span>
              {(task.completion_pct || 0) > 0 && <span className="text-[9px] text-muted-foreground">{task.completion_pct}% done</span>}
              {showBilling && (task.loss_amount || 0) > 0 && (
                <span className="text-[9px] text-red-400 font-medium">Loss {formatCurrency(task.loss_amount!, task.currency as Currency)}</span>
              )}
              {task.honor_contributions && (
                <span title="Employee contributions honored" className="text-[9px] text-green-400">
                  <Users className="inline w-2.5 h-2.5" /> Paid
                </span>
              )}
            </div>
          )}
        </td>
      )
    }
  }

  return (
    <div>
      <Header
        ref={headerRef}
        title="Tasks"
        subtitle={
          showTrash
            ? `${trashDbCount ?? trash.length} item${(trashDbCount ?? trash.length) !== 1 ? 's' : ''} in Trash`
            : dbMode
              ? `Database search · ${dbModeTotal != null ? `${dbModeTotal} match${dbModeTotal !== 1 ? 'es' : ''}` : '…'}`
              : dbTaskTotal != null && dbTaskTotal > tasks.length
                ? `${tasks.length} loaded · ${dbTaskTotal} total in DB`
                : `${tasks.length} total tasks`
        }
        actions={
          <div className="flex items-center gap-2">
            {showTrash ? (
              <button onClick={() => setShowTrash(false)} className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 py-2 bg-secondary hover:bg-secondary/80 transition-colors">
                <ChevronLeft className="w-4 h-4" /> Back to Tasks
              </button>
            ) : (
              <>
                {/* Secondary destinations live behind "…" so the page title
                    stops truncating to make room for them. Each keeps its own
                    permission gate; nothing became harder to reach than one
                    extra click. */}
                <OverflowMenu
                  items={[
                    ...(can('requests.view') ? [{
                      label: 'Client requests',
                      icon: Inbox,
                      badge: pendingRequestCount > 0 ? pendingRequestCount : undefined,
                      onClick: () => { window.location.href = '/dashboard/requests' },
                    }] : []),
                    ...(can('tasks.workload') ? [{
                      label: 'Workload report',
                      icon: Users,
                      onClick: () => setShowWorkload(true),
                    }] : []),
                    ...(can('tasks.trash') ? [{
                      label: 'Trash',
                      icon: Trash2,
                      badge: trashDbCount === null ? '…' : (trashDbCount ?? trash.length),
                      separatorBefore: true,
                      onClick: () => setShowTrash(true),
                    }] : []),
                  ]}
                />
                {/* Add Task — requires tasks.create permission */}
                {can('tasks.create') && (
                  <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity">
                    <Plus className="w-4 h-4" /> Add Task
                  </button>
                )}
              </>
            )}
          </div>
        }
      />

      {/* ── Trash View ── */}
      {showTrash && (
        <div className="p-4 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-sm text-muted-foreground bg-red-500/5 border border-red-500/15 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <span>Items in Trash are automatically deleted after <strong className="text-foreground mx-1">45 days</strong>. Restore within this window to recover.</span>
            </div>
            {trash.length > 0 && (
              <div className="shrink-0 flex justify-end">
                {emptyTrashConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-400 font-medium">Delete all forever?</span>
                    <button onClick={handleEmptyTrash} disabled={emptyingTrash} className="text-xs px-3 py-1.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors disabled:opacity-50">
                      {emptyingTrash ? '...' : 'Yes, Empty'}
                    </button>
                    <button onClick={() => setEmptyTrashConfirm(false)} disabled={emptyingTrash} className="text-xs px-3 py-1.5 rounded-lg bg-secondary text-foreground font-medium hover:bg-secondary/80 transition-colors">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setEmptyTrashConfirm(true)} className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 font-medium transition-colors">
                    Empty Trash
                  </button>
                )}
              </div>
            )}
          </div>
          {trash.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Trash2 className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p className="text-sm">Trash is empty</p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              {/* Phones: card list — the 6-column table (incl. two action
                  buttons) has no room to breathe below sm, and Restore/Delete
                  Forever are exactly the kind of destructive actions that need
                  full-width thumb targets, not a cramped trailing cell. */}
              <div className="sm:hidden divide-y divide-border">
                {trash.map(task => {
                  const deletedDate = new Date(task.deleted_at)
                  const expiresDate = new Date(deletedDate.getTime() + 45 * 24 * 60 * 60 * 1000)
                  const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                  return (
                    <div key={task.id} className="p-4 opacity-70">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <p className="font-medium text-foreground line-through decoration-muted-foreground text-sm">{task.title}</p>
                        <span className={`shrink-0 text-xs font-medium ${daysLeft <= 7 ? 'text-red-400' : daysLeft <= 14 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                          {daysLeft}d left
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">
                        {task.client ? (
                          <>
                            {task.client.name}
                            {task.client.code && <span className="ml-1 font-mono text-muted-foreground/50">{task.client.code}</span>}
                          </>
                        ) : 'Internal'}
                        {task.service?.name && ` · ${task.service.name}`}
                        {` · deleted ${deletedDate.toLocaleDateString('en-GB')}`}
                      </p>
                      <div className="flex items-center gap-2">
                        <button onClick={() => handleRestore(task.id)}
                          className="flex-1 text-xs px-3 py-2 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 font-medium transition-colors">
                          Restore
                        </button>
                        <button onClick={() => initiateDelete(task.id)}
                          className="flex-1 text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 font-medium transition-colors">
                          Delete Forever
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <table className="hidden sm:table w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Task</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Client</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Service</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Deleted</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Expires</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {trash.map(task => {
                    const deletedDate = new Date(task.deleted_at)
                    const expiresDate = new Date(deletedDate.getTime() + 45 * 24 * 60 * 60 * 1000)
                    const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                    return (
                      <tr key={task.id} className="hover:bg-secondary/20 transition-colors opacity-70 hover:opacity-100">
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground line-through decoration-muted-foreground">{task.title}</p>
                          {task.description && <p className="text-xs text-muted-foreground truncate max-w-[180px]">{task.description}</p>}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {task.client ? (
                            <>
                              {task.client.name}
                              {task.client.code && <span className="ml-1.5 text-[10px] font-mono text-muted-foreground/50">{task.client.code}</span>}
                            </>
                          ) : <InternalBadge />}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{task.service?.name || '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground">{deletedDate.toLocaleDateString('en-GB')}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium ${daysLeft <= 7 ? 'text-red-400' : daysLeft <= 14 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                            {daysLeft}d left
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 justify-end">
                            <button onClick={() => handleRestore(task.id)}
                              className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 font-medium transition-colors">
                              Restore
                            </button>
                            <button onClick={() => initiateDelete(task.id)}
                              className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 font-medium transition-colors">
                              Delete Forever
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Main Task List ──
          No vertical `space-y` here: the gap between the sticky toolbar and
          the sticky thead must be ZERO, otherwise rows scroll through a
          transparent strip when the page is scrolled. The toolbar's own
          py-3 provides the top/bottom breathing-room. */}
      {!showTrash && <div className="px-6 pb-6">
        {/* Sticky toolbar — sits below the sticky Header.
            Symmetric pt/pb so the gap above (between page-Header and toolbar)
            matches the visual breathing-room. Bottom padding is also what the
            thead measures against, so there's no transparent strip below. */}
        <div ref={toolbarRef} className="sticky z-20 bg-background py-2 sm:py-3 space-y-1.5 sm:space-y-2 w-full" style={{ top: headerHeight }}>

          {/* Row 1: [Select | Edit] · [Search flex-1] · [View segment] · [⚙ board]
              On mobile (<sm) the row wraps; Search jumps to the top via order-first
              and takes full width so it's actually usable. Select/Edit and the View
              toggle drop below on the second wrap-line. Tighter gap on mobile. */}
          <div className="flex flex-col lg:flex-row lg:items-center gap-1.5 lg:gap-2 w-full">
            {/* Left group: Select + Inline Edit — solid action-mode toggles */}
            {(role !== 'employee' || bulkMode) && (
              <div className="flex items-center gap-1.5 shrink-0 order-2 sm:order-none hidden sm:flex">
                <button
                  onClick={() => { setBulkMode(m => !m); setSelectedTasks(new Set()) }}
                  className={`h-[34px] px-3 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 shadow-sm cursor-pointer ${
                    bulkMode
                      ? 'bg-violet-500 text-white shadow-violet-500/30'
                      : 'bg-secondary border border-border text-foreground hover:bg-secondary/60'
                  }`}>
                  {bulkMode ? <><X size={12} /> Exit Select</> : <>Select</>}
                </button>
                {viewMode === 'table' && (
                  <button
                    onClick={() => setInlineEditMode(m => !m)}
                    title="Toggle inline edit"
                    className={`hidden sm:flex items-center gap-1.5 h-[34px] px-3 rounded-xl text-xs font-semibold transition-all shadow-sm cursor-pointer ${
                      inlineEditMode
                        ? 'bg-blue-500 text-white shadow-blue-500/30'
                        : 'bg-secondary border border-border text-foreground hover:bg-secondary/60'
                    }`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    {inlineEditMode ? 'Editing' : 'Edit'}
                  </button>
                )}
              </div>
            )}

            <div className="w-full lg:w-auto lg:flex-1 shrink-0">
              <TokenizedSearch
                className="w-full"
                facets={searchFacets}
                onFacetsChange={setSearchFacets}
                draft={searchDraft}
                onDraftChange={setSearchDraft}
                placeholder="Search title, client, service, #number…"
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
                  showMobileFilters || hasActiveFilters
                    ? 'bg-foreground/10 border-foreground/20 text-foreground'
                    : 'bg-secondary border-foreground/15 text-muted-foreground hover:text-foreground'
                }`}
              >
                <MoreVertical size={14} /> Filters
              </button>
            </div>

            {/* View segment (Hidden on mobile for employees) */}
            <div ref={viewRef} className={`relative shrink-0 order-3 sm:order-none flex items-center gap-1.5 ${role === 'employee' ? 'hidden sm:flex' : ''}`}>
              {/* Desktop View Buttons */}
              <div className="hidden sm:flex items-center bg-secondary border border-foreground/15 rounded-xl p-1 gap-0.5">
                {([
                  { key: 'table',    Icon: List,         label: 'Table' },
                  { key: 'board',    Icon: LayoutGrid,   label: 'Board' },
                  { key: 'calendar', Icon: CalendarDays, label: 'Calendar' },
                ] as const).map(({ key, Icon, label }) => (
                  <span key={key} className="flex items-center">
                    <button
                      onClick={() => setViewMode(key)}
                      className={`cursor-pointer px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                        viewMode === key
                          ? 'bg-foreground/10 text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                    </button>
                    {/* Board settings ⚙ — sits immediately after the Board button, only visible when Board is active */}
                    {key === 'board' && viewMode === 'board' && (
                      <button
                        onClick={() => setViewOpen(v => !v)}
                        title="Board settings"
                        className={`ml-0.5 px-2 py-1.5 rounded-lg flex items-center justify-center transition-colors ${
                          viewOpen
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

              {/* Columns button — inline with Table/Board/Calendar, table view only */}
              {viewMode === 'table' && (
                <div ref={colPanelRef} className="relative">
                  <button
                    onClick={() => setShowColPanel(v => !v)}
                    title="Reorder columns"
                    className={`h-[34px] px-2.5 rounded-xl text-xs font-medium flex items-center gap-1.5 border transition-colors cursor-pointer ${
                      showColPanel
                        ? 'bg-foreground/10 border-foreground/20 text-foreground'
                        : 'bg-secondary border-foreground/15 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    Columns
                  </button>
                  {showColPanel && (
                    <div className="absolute right-0 top-full mt-1.5 z-50 bg-card border border-border rounded-xl shadow-2xl p-3 min-w-[180px]">
                      <div className="flex items-center justify-between mb-2 px-1">
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Column order</span>
                        <button onClick={() => setColOrder([...DEFAULT_COL_ORDER])} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">Reset</button>
                      </div>
                      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleColPanelDragEnd}>
                        <SortableContext items={visibleCols} strategy={verticalListSortingStrategy}>
                          {visibleCols.map((key, i) => (
                            <SortablePanelRow key={key} id={key} label={COL_LABELS[key]}
                              isFirst={i === 0} isLast={i === visibleCols.length - 1}
                              onUp={() => setColOrder(prev => arrayMove(prev, prev.indexOf(key), prev.indexOf(key) - 1))}
                              onDown={() => setColOrder(prev => arrayMove(prev, prev.indexOf(key), prev.indexOf(key) + 1))}
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    </div>
                  )}
                </div>
              )}

              {/* Group By popover */}
              {viewMode === 'board' && viewOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-50 bg-secondary border border-foreground/15 rounded-xl shadow-2xl p-3 min-w-[220px] space-y-3">
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">Group by</label>
                    <AppSelect value={boardGroupBy} onChange={e => setBoardGroupBy(e.target.value as typeof boardGroupBy)}>
                      <option value="employee">Employee</option>
                      <option value="client">Client</option>
                      <option value="service">Service</option>
                      <option value="status">Status</option>
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
            {/* Row 2: Filters + Status chips + Pagination (compact, no wrap) */}
            <div className="flex items-center gap-1 flex-wrap">
              <DateFilter compact value={filterDate} onChange={setFilterDate} />
              <FilterDropdown compact options={scopedClientOptions} value={filterClient} onChange={setFilterClient} placeholder="Client" sortKey="clients" maxLabelWidth="max-w-[90px]" />
              <FilterDropdown compact options={scopedServiceOptions} value={filterService} onChange={setFilterService} placeholder="Service" sortKey="services" maxLabelWidth="max-w-[90px]" />
              <FilterDropdown compact options={scopedAssigneeOptions} value={filterAssignee} onChange={setFilterAssignee} placeholder="Assignee" sortKey="employees" maxLabelWidth="max-w-[90px]" />
              <FilterDropdown compact
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
                maxLabelWidth="max-w-[72px]"
              />

              {/* thin separator */}
              <span className="hidden sm:block w-px h-4 bg-foreground/10 shrink-0 mx-0.5" />

              {/* Status chips — compact */}
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                className="sm:hidden h-[30px] px-2 rounded-xl text-xs font-medium bg-secondary border border-border text-foreground focus:outline-none cursor-pointer w-full">
                <option value="">All ({fmtStatusCount('', statusCounts.all)})</option>
                {STATUSES.filter(s => CORE_STATUSES.includes(s) || (statusCounts[s] ?? 0) > 0).map(s => <option key={s} value={s}>{getStatusLabel(s)} ({fmtStatusCount(s, statusCounts[s] ?? 0)})</option>)}
              </select>
              {([
                { key: '', label: 'All' },
                ...STATUSES.filter(s => CORE_STATUSES.includes(s) || (statusCounts[s] ?? 0) > 0)
                  .map(s => ({ key: s, label: getStatusLabel(s) })),
              ]).map(({ key, label }) => {
                const count = key === '' ? statusCounts.all : (statusCounts[key] ?? 0)
                const active = filterStatus === key
                return (
                  <button key={key} onClick={() => setFilterStatus(key)}
                    title={partialCountTitle(key, label, count)}
                    className={`hidden sm:flex h-[30px] px-2.5 rounded-xl text-xs font-medium transition-colors cursor-pointer items-center gap-1 shrink-0 ${
                      active ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                    <span className={`text-[10px] font-semibold px-1 py-0.5 rounded ${
                      active ? 'bg-foreground/20 text-white' : 'bg-border/50 opacity-60'
                    }`}>{fmtStatusCount(key, count)}</span>
                  </button>
                )
              })}
              {hasActiveFilters && (
                <button onClick={() => { setFilterStatus(''); setFilterClient(''); setFilterService(''); clearSearch(); setSortBy('today_first'); setFilterAssignee(''); setFilterDate(null); setMyScope(null) }}
                  className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-1 rounded-md hover:bg-foreground/[0.04] transition-colors flex items-center gap-0.5 shrink-0">
                  <X size={11} /> Clear
                </button>
              )}

              {/* Compact pagination — ml-auto pushes to the right */}
              {viewMode === 'table' && totalPages > 1 && (
                <div className="hidden sm:flex items-center gap-0.5 shrink-0 ml-auto">
                  <span className="w-px h-4 bg-foreground/10 mx-1" />
                  <button onClick={() => dbMode ? runDbSearch(Math.max(0, dbModePage - 1)) : setTablePage(p => Math.max(0, p - 1))} disabled={dbMode ? dbModePage === 0 : tablePage === 0} title="Previous page"
                    className="h-[28px] w-[28px] flex items-center justify-center rounded-lg border border-border/50 text-muted-foreground disabled:opacity-30 hover:bg-foreground/5 hover:text-foreground transition-colors text-sm font-mono">‹</button>
                  <div className="flex items-center gap-0.5 px-2 h-[28px] rounded-lg border border-border/50 bg-background text-xs text-muted-foreground">
                    <input type="number" min={1} max={totalPages} key={dbMode ? dbModePage : tablePage} defaultValue={(dbMode ? dbModePage : tablePage) + 1}
                      onKeyDown={e => { if (e.key === 'Enter') { const n = parseInt((e.target as HTMLInputElement).value, 10); if (!isNaN(n)) { const p = Math.max(0, Math.min(totalPages - 1, n - 1)); dbMode ? runDbSearch(p) : setTablePage(p) } } }}
                      className="w-6 text-center bg-transparent focus:outline-none text-foreground font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                    <span className="opacity-40">/ {totalPages}</span>
                  </div>
                  <button onClick={() => dbMode ? runDbSearch(Math.min(totalPages - 1, dbModePage + 1)) : setTablePage(p => Math.min(totalPages - 1, p + 1))} disabled={dbMode ? dbModePage >= totalPages - 1 : tablePage === totalPages - 1} title="Next page"
                    className="h-[28px] w-[28px] flex items-center justify-center rounded-lg border border-border/50 text-muted-foreground disabled:opacity-30 hover:bg-foreground/5 hover:text-foreground transition-colors text-sm font-mono">›</button>
                  {!dbMode && (
                    <select value={tablePageSize} onChange={e => { setTablePageSize(Number(e.target.value)); setTablePage(0) }} title="Rows per page"
                      className="h-[28px] px-1 rounded-lg border border-border/50 bg-background text-xs text-muted-foreground focus:outline-none focus:border-violet-500/50 ml-0.5">
                      {[50, 100, 200, 500].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  )}
                </div>
              )}

              {/* ── Search Database / Load full history ──
                  Shown when the in-memory set is smaller than the DB (either the
                  12-month task window, or visibility scoping trimming the list).
                  Admins get the browser DB search; employees get the server-side
                  full-history reload, because DB search cannot honour their
                  scoping. Hidden entirely once everything is loaded. */}
              {(() => {
                const allLoaded = dbTaskTotal != null && dbTaskTotal <= tasks.length
                if (!canDbSearch) {
                  if (fullHistory || allLoaded) return null
                  return (
                    <Link
                      href="/dashboard/tasks?history=all"
                      title="Load every task, including settled ones older than the default window"
                      className="flex items-center gap-1.5 h-[34px] px-3 rounded-xl text-xs font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-colors shrink-0"
                    >
                      <Clock size={12} /> Load full history
                    </Link>
                  )
                }
                if (allLoaded && !dbMode) return null
                return !dbMode ? (
                  <button
                    onClick={() => runDbSearch(0)}
                    disabled={dbModeLoading}
                    title="Search all tasks directly in the database — bypasses the in-memory loaded set"
                    className="flex items-center gap-1.5 h-[34px] px-3 rounded-xl text-xs font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {dbModeLoading
                      ? <><RefreshCw size={12} className="animate-spin" /> Searching…</>
                      : <><Search size={12} /> Search DB</>}
                  </button>
                ) : (
                  <button
                    onClick={exitDbMode}
                    title="Exit database search mode — go back to in-memory loaded tasks"
                    className="flex items-center gap-1.5 h-[34px] px-3 rounded-xl text-xs font-medium border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors shrink-0"
                  >
                    <X size={12} /> Exit DB mode
                  </button>
                )
              })()}

            </div>

          </div>

          {/* ── Active filter chips (tokenized filters, ERPNext-style) ── */}
          <ActiveFilterChips
            chips={[
              ...(filterStatus ? [{ key: 'status', label: 'Status', value: getStatusLabel(filterStatus), onRemove: () => setFilterStatus('') }] : []),
              ...(filterClient ? [{ key: 'client', label: 'Client', value: filterClient === INTERNAL_CLIENT ? 'Internal' : clientList.find(c => c.id === filterClient)?.name || 'Selected', onRemove: () => setFilterClient('') }] : []),
              ...(filterService ? [{ key: 'service', label: 'Service', value: services.find(s => s.id === filterService)?.name || 'Selected', onRemove: () => setFilterService('') }] : []),
              ...(filterAssignee ? [{ key: 'assignee', label: 'Assignee', value: (() => { const e = employees.find(e => e.id === filterAssignee); return e ? dn(e) : 'Selected' })(), onRemove: () => setFilterAssignee('') }] : []),
              ...(filterDate ? [{ key: 'date', label: 'Date', value: getDateFilterLabel(filterDate), onRemove: () => setFilterDate(null) }] : []),
            ]}
            onClearAll={() => { clearSearch(); setFilterStatus(''); setFilterClient(''); setFilterService(''); setFilterAssignee(''); setFilterDate(null) }}
          />

          {/* ── DB mode banner ── */}
          {dbMode && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-500/10 border border-violet-500/20 text-xs text-violet-700 dark:text-violet-300">
              <Search size={12} className="shrink-0" />
              <span>
                <strong>Database search active</strong> — showing results directly from Supabase.
                {dbModeTotal != null && ` Found ${dbModeTotal} task${dbModeTotal !== 1 ? 's' : ''} matching your filters.`}
                {dbModeTotal != null && dbModeTotal > DB_PAGE_SIZE && ` Showing ${DB_PAGE_SIZE} per page.`}
              </span>
              <button onClick={exitDbMode} className="ml-auto flex items-center gap-1 text-violet-400 hover:text-violet-700 dark:text-violet-200 transition-colors shrink-0">
                <X size={11} /> Back to loaded
              </button>
            </div>
          )}
        </div>

        {/* Table */}
        {viewMode === 'table' && (
        <>
        {/* Desktop: full table — hidden below sm.
            overflow-auto + max-height makes this the scroll container so the
            sticky thead pins to its top AND wide tables scroll horizontally
            (so the actions column is always reachable, never clipped). */}
        <div className="hidden sm:block bg-card border border-border rounded-xl overflow-auto max-h-[calc(100dvh-230px)]">
          <table className="w-full text-sm">
            {/* Sticky table header — sits flush below the toolbar.
                top is measured dynamically by a ResizeObserver on the toolbar,
                so it always matches the toolbar bottom regardless of how it
                wraps or which optional buttons are visible. */}
            <thead className="sticky z-10 bg-card" style={{ top: 0 }}>
              <tr className="border-b border-border bg-secondary/50">
                {bulkMode && (
                  <th className="w-10 pl-5 pr-2 py-3.5 bg-secondary/95 backdrop-blur-sm">
                    <input
                      type="checkbox"
                      checked={visibleTasks.length > 0 && visibleTasks.every(t => selectedTasks.has(t.id))}
                      onChange={e => {
                        if (e.target.checked) setSelectedTasks(new Set(visibleTasks.map(t => t.id)))
                        else setSelectedTasks(new Set())
                      }}
                      className="w-4 h-4 rounded accent-violet-500 cursor-pointer"
                    />
                  </th>
                )}
                <th className="text-left px-5 py-3.5 text-xs font-medium text-muted-foreground w-20 bg-secondary/95 backdrop-blur-sm">Task No.</th>
                <th className="text-left px-5 py-3.5 text-xs font-medium text-muted-foreground w-full bg-secondary/95 backdrop-blur-sm">Task Title</th>
                {/* Reorderable columns — drag handle on hover (desktop), panel for mobile */}
                {/* accessibility.container portals dnd-kit's hidden live-region <div>s to
                    <body> — rendered inline they'd sit inside this <tr>, which is invalid
                    HTML and triggers React's hydration-error warning on every load. */}
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleColHeaderDragEnd}
                  accessibility={{ container: typeof document !== 'undefined' ? document.body : undefined }}>
                  <SortableContext items={visibleCols} strategy={horizontalListSortingStrategy}>
                    {visibleCols.map(key => {
                      const base = 'text-xs font-medium text-muted-foreground bg-secondary/95 backdrop-blur-sm pl-6'
                      if (key === 'client') return (
                        <SortableColHeader key="client" id="client" className={`text-left px-5 py-3.5 ${base}`}>
                          <button onClick={() => setSortBy(s => s === 'client' ? 'date_desc' : 'client')}
                            className={`flex items-center gap-1 hover:text-foreground transition-colors ${sortBy === 'client' ? 'text-violet-400' : ''}`}>
                            Client <span className={`text-[10px] ${sortBy === 'client' ? 'opacity-100' : 'opacity-30'}`}>↕</span>
                          </button>
                        </SortableColHeader>
                      )
                      if (key === 'service') return (
                        <SortableColHeader key="service" id="service" className={`text-left px-5 py-3.5 ${base}`}>
                          Service
                        </SortableColHeader>
                      )
                      if (key === 'date') return (
                        <SortableColHeader key="date" id="date" className={`text-left px-5 py-3.5 ${base}`}>
                          <button onClick={() => setSortBy(s => s === 'date_desc' ? 'date_asc' : 'date_desc')}
                            className={`flex items-center gap-1 hover:text-foreground transition-colors ${sortBy === 'date_desc' || sortBy === 'date_asc' ? 'text-violet-400' : ''}`}>
                            Date
                            <span className="text-[10px]">
                              {sortBy === 'date_asc' ? '↑' : sortBy === 'date_desc' ? '↓' : <span className="opacity-30">↕</span>}
                            </span>
                          </button>
                        </SortableColHeader>
                      )
                      if (key === 'billing') return (
                        <SortableColHeader key="billing" id="billing" className={`text-right px-5 py-3.5 ${base}`}>
                          <button onClick={() => setSortBy(s => s === 'amount_desc' ? 'date_desc' : 'amount_desc')}
                            className={`flex items-center gap-1 ml-auto hover:text-foreground transition-colors ${sortBy === 'amount_desc' ? 'text-violet-400' : ''}`}>
                            Billing <span className={`text-[10px] ${sortBy === 'amount_desc' ? 'opacity-100' : 'opacity-30'}`}>↓</span>
                          </button>
                        </SortableColHeader>
                      )
                      if (key === 'qty') return (
                        <SortableColHeader key="qty" id="qty" className={`text-center px-4 py-3.5 w-14 ${base}`}>
                          Qty
                        </SortableColHeader>
                      )
                      if (key === 'total') return (
                        <SortableColHeader key="total" id="total" className={`text-right px-5 py-3.5 ${base}`}>
                          Total
                        </SortableColHeader>
                      )
                      if (key === 'status') return (
                        <SortableColHeader key="status" id="status" className={`text-left px-5 py-3.5 ${base}`}>
                          Status
                        </SortableColHeader>
                      )
                      return null
                    })}
                  </SortableContext>
                </DndContext>
                <th className="w-px px-2 py-3 bg-secondary/95 backdrop-blur-sm"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pagedTasks.length === 0 && !dbModeLoading && (
                <tr><td colSpan={3 + (bulkMode ? 1 : 0) + visibleCols.length} className="px-4 py-10 text-center">
                  <p className="text-sm text-muted-foreground mb-3">
                    {dbMode ? 'No tasks found in database matching your filters.' : 'No tasks found.'}
                  </p>
                  {!dbMode && canDbSearch && dbTaskTotal != null && dbTaskTotal > tasks.length && (
                    <button
                      onClick={() => runDbSearch(0)}
                      disabled={dbModeLoading}
                      className="inline-flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-700 dark:text-violet-300 border border-violet-500/30 hover:border-violet-500/50 rounded-lg px-3 py-1.5 transition-colors bg-violet-500/5 hover:bg-violet-500/10 disabled:opacity-50"
                    >
                      <Search size={12} />
                      {dbModeLoading ? 'Searching database…' : 'Search entire database with these filters'}
                    </button>
                  )}
                  {!dbMode && !canDbSearch && !fullHistory && dbTaskTotal != null && dbTaskTotal > tasks.length && (
                    <Link
                      href="/dashboard/tasks?history=all"
                      className="inline-flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-700 dark:text-violet-300 border border-violet-500/30 hover:border-violet-500/50 rounded-lg px-3 py-1.5 transition-colors bg-violet-500/5 hover:bg-violet-500/10"
                    >
                      <Clock size={12} />
                      Load full history
                    </Link>
                  )}
                </td></tr>
              )}
              {dbModeLoading && (
                <tr><td colSpan={3 + (bulkMode ? 1 : 0) + visibleCols.length} className="px-4 py-10 text-center">
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw size={14} className="animate-spin" /> Searching database…
                  </div>
                </td></tr>
              )}
              {(() => {
                // Group pagedTasks by task_date, preserving sort order
                const dateGroups: [string, typeof pagedTasks][] = []
                const seenDates = new Map<string, typeof pagedTasks>()
                for (const task of pagedTasks) {
                  const d = task.task_date || ''
                  if (!seenDates.has(d)) { seenDates.set(d, []); dateGroups.push([d, seenDates.get(d)!]) }
                  seenDates.get(d)!.push(task)
                }
                const colSpan = 3 + (bulkMode ? 1 : 0) + visibleCols.length

                return dateGroups.map(([date, dateTasks]) => (
                  <Fragment key={date}>
                    {/* Date group header */}
                    <tr className="bg-secondary/55 border-y border-border/70 border-l-4 border-l-primary/50">
                      <td colSpan={colSpan} className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-bold text-foreground uppercase tracking-wider">
                            {date
                              ? new Date(date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
                              : 'No date'}
                          </span>
                          <div className="flex-1 h-px bg-border/60" />
                          {showBilling && (() => {
                            const dayTotal = dateTasks.reduce((s, t) => s + (t.billing_amount_inr ?? 0), 0)
                            return dayTotal > 0 ? (
                              <span className="text-[11px] font-semibold text-foreground tabular-nums">₹{dayTotal.toLocaleString('en-IN')}</span>
                            ) : null
                          })()}
                          <span className="text-[11px] font-medium text-muted-foreground">{dateTasks.length} task{dateTasks.length !== 1 ? 's' : ''}</span>
                        </div>
                      </td>
                    </tr>
                    {dateTasks.map(task => (
                <tr key={task.id}
                  data-taskid={task.id}
                  className={`group transition-colors hover:bg-muted/50 ${inlineEditMode ? '' : 'cursor-pointer'} ${bulkMode && selectedTasks.has(task.id) ? 'bg-violet-500/[0.07]' : ''} ${highlightedTaskId === task.id ? 'ring-1 ring-violet-400 bg-violet-500/10' : ''}`}
                  onClick={
                    bulkMode
                      ? () => setSelectedTasks(prev => {
                          const next = new Set(prev)
                          if (next.has(task.id)) next.delete(task.id)
                          else next.add(task.id)
                          return next
                        })
                      : inlineEditMode
                        ? undefined
                        : () => openEdit(task)
                  }
                >
                  {bulkMode && (
                    <td className="w-10 pl-5 pr-2 py-3.5" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedTasks.has(task.id)}
                        onChange={() => setSelectedTasks(prev => {
                          const next = new Set(prev)
                          if (next.has(task.id)) next.delete(task.id)
                          else next.add(task.id)
                          return next
                        })}
                        className="w-4 h-4 rounded accent-violet-500 cursor-pointer"
                      />
                    </td>
                  )}
                  {/* Task No. column */}
                  <td className="px-5 py-3.5" onClick={e => e.stopPropagation()}>
                    <span
                      title={`Task code · click to copy ${taskCode(task)}`}
                      onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(taskCode(task)) }}
                      className="text-[10px] font-mono font-semibold text-muted-foreground/60 bg-foreground/[0.04] border border-foreground/15 px-1.5 py-0.5 rounded shrink-0 cursor-pointer hover:text-foreground hover:border-foreground/25 transition-colors"
                    >
                      {taskCode(task)}
                    </span>
                  </td>
                  {/* Task Title column */}
                  <td className="px-5 py-3.5" onClick={e => inlineEditMode && e.stopPropagation()}>
                    {inlineEditMode ? (
                      <input
                        type="text"
                        defaultValue={task.title}
                        onBlur={async e => {
                          const val = e.target.value.trim()
                          if (val && val !== task.title) {
                            await serverInlineTaskUpdate(task.id, { title: val })
                            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, title: val } : t))
                          }
                        }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                        className="w-full bg-secondary border border-border rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500/50"
                      />
                    ) : (
                      <div className="flex flex-col items-start gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-foreground">{task.title}</p>
                          {task.is_recurring && (
                            <span title="Recurring task">
                              <RefreshCw className="w-3 h-3 text-primary/60 flex-shrink-0" />
                            </span>
                          )}
                          {task.recurring_parent_id && (
                            <span title="Recurring instance">
                              <RefreshCw className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
                            </span>
                          )}
                          {requestRefByTaskId[task.id] && (
                            <button
                              title="From a client request — click for the brief (design plan, links)"
                              onClick={e => { e.stopPropagation(); openRequestBrief(task.id) }}
                              className="text-[9px] font-mono font-semibold text-violet-400 bg-violet-500/10 border border-violet-500/25 px-1.5 py-0.5 rounded hover:bg-violet-500/20 transition-colors shrink-0"
                            >
                              REQ-{String(requestRefByTaskId[task.id].ref_no).padStart(4, '0')}
                            </button>
                          )}
                        </div>
                        {task.description && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{task.description}</p>}
                      </div>
                    )}
                    {/* Assignment indicators */}
                    {(() => {
                      const taskEmps = localAssignments
                        .filter(a => a.task_id === task.id)
                        .map(a => employees.find(e => e.id === a.employee_id))
                        .filter(Boolean)
                      const taskGroupIds = localGroupAssignments
                        .filter(a => a.task_id === task.id)
                        .map(a => a.group_id)
                      const taskParamIds = localParamAssignments
                        .filter(a => a.task_id === task.id)
                        .map(a => a.parameter_id)
                      if (!taskEmps.length && !taskGroupIds.length && !taskParamIds.length && !inlineEditMode) return null
                      return (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {taskEmps.map(emp => (
                            <span key={emp!.id} className="inline-flex items-center gap-1 text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded-full">
                              {emp!.cqid}
                            </span>
                          ))}
                          {taskGroupIds.map(gId => {
                            const g = groups.find(x => x.id === gId)
                            const assignedEmp = employees.find(e => e.id === localGroupAssignments.find(a => a.task_id === task.id && a.group_id === gId)?.employee_id)
                            if (!g) return null
                            return (
                              <span key={gId} className="inline-flex items-center gap-1 text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded-full">
                                <Layers className="w-2.5 h-2.5" />{g.name}{assignedEmp ? ` · ${assignedEmp.cqid}` : ''}
                              </span>
                            )
                          })}
                          {taskParamIds.length > 0 && (
                            <span className="inline-flex items-center gap-1 text-[10px] bg-purple-500/[0.07] text-purple-700 dark:text-purple-300/60 border border-purple-500/10 px-1.5 py-0.5 rounded-full">
                              {taskParamIds.length} param{taskParamIds.length !== 1 ? 's' : ''}
                            </span>
                          )}
                          {inlineEditMode && (
                            <button
                              onClick={e => { e.stopPropagation(); openAssignModal(task) }}
                              className="text-[10px] inline-flex items-center gap-0.5 bg-blue-500/10 text-blue-400 border border-dashed border-blue-500/30 px-1.5 py-0.5 rounded-full hover:bg-blue-500/15 transition-colors"
                            >
                              <Users className="w-2.5 h-2.5" />+ assign
                            </button>
                          )}
                        </div>
                      )
                    })()}
                  </td>
                  {/* Reorderable column cells — rendered in user's chosen order */}
                  {visibleCols.map(key => renderCell(key, task))}
                  <td className="w-px px-2 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-0.5 justify-end">
                      {can('tasks.assign') && (
                        <button
                          onClick={e => { e.stopPropagation(); openAssignModal(task) }}
                          title="Assign team"
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-blue-400 transition-colors px-1.5 py-1 rounded-lg hover:bg-blue-500/10">
                          <Users className="w-3.5 h-3.5" />
                          {(() => {
                            const count = localAssignments.filter(a => a.task_id === task.id).length
                            return count > 0 ? <span className="font-semibold text-blue-400">{count}</span> : null
                          })()}
                        </button>
                      )}
                      <DiscussButton entityType="task" entityId={task.id} variant="icon"
                        label="Discuss this task" panelTitle={task.title} />
                      <button onClick={e => { e.stopPropagation(); openEdit(task) }} title="Edit task"
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {can('tasks.create') && (
                        <button onClick={e => { e.stopPropagation(); duplicateTask(task) }} disabled={duplicatingId === task.id} title="Duplicate task"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {task.client_id && role === 'super_admin' && (
                        <button
                          type="button"
                          title={`Edit client: ${task.client?.name}`}
                          onClick={e => { e.stopPropagation(); setEditClientId(task.client_id); setEditClientServiceId(task.service_id ?? null) }}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-violet-400 hover:bg-violet-500/10 transition-colors"
                        >
                          <Building2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {permissionFlags?.contribView ? (
                        <button
                          type="button"
                          title="View contributions"
                          onClick={e => { e.stopPropagation(); setEditTask(task); setOpenOnContribTab(task.id) }}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-green-400 hover:bg-green-500/10 transition-colors"
                        >
                          <BarChart2 className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <a
                          href={`/dashboard/contributions?highlight=${task.id}`}
                          title="View contribution"
                          onClick={e => e.stopPropagation()}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-green-400 hover:bg-green-500/10 transition-colors"
                        >
                          <BarChart2 className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <button onClick={e => { e.stopPropagation(); initiateDelete(task.id) }} title="Delete task"
                        className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
                    ))}
                  </Fragment>
                ))
              })()}
            </tbody>
          </table>
        </div>


        {/* Mobile: stacked card list — visible below sm. Same data, denser tap-friendly layout. */}
        <div className="sm:hidden space-y-2">
          {mobileTasks.length === 0 && (
            <div className="bg-card border border-border rounded-xl px-4 py-10 text-center text-sm text-muted-foreground">No tasks found</div>
          )}
          {(() => {
            // Group mobile cards by task_date (same as the desktop table).
            const groups: [string, typeof mobileTasks][] = []
            const seen = new Map<string, typeof mobileTasks>()
            for (const task of mobileTasks) {
              const d = task.task_date || ''
              if (!seen.has(d)) { seen.set(d, []); groups.push([d, seen.get(d)!]) }
              seen.get(d)!.push(task)
            }
            return groups.map(([date, dateTasks]) => (
              <Fragment key={date || 'no-date'}>
                {/* Date group header */}
                <div className="flex items-center gap-2 px-1 pt-3 pb-0.5 first:pt-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
                    {date ? new Date(date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'No date'}
                  </span>
                  <div className="flex-1 h-px bg-border/60" />
                  <span className="text-[10px] font-medium text-muted-foreground">{dateTasks.length} task{dateTasks.length !== 1 ? 's' : ''}</span>
                </div>
                {dateTasks.map(task => {
            const isSelected = bulkMode && selectedTasks.has(task.id)
            return (
              <div
                key={task.id}
                data-taskid={task.id}
                onClick={
                  bulkMode
                    ? () => setSelectedTasks(prev => {
                        const next = new Set(prev)
                        if (next.has(task.id)) next.delete(task.id)
                        else next.add(task.id)
                        return next
                      })
                    : () => openEdit(task)
                }
                className={`hover-gradient-card bg-card border rounded-xl px-3.5 py-3 ${
                  isSelected ? 'border-violet-500/60 bg-violet-500/[0.06]' : 'border-border'
                } ${highlightedTaskId === task.id ? 'ring-1 ring-violet-400' : ''}`}
              >
                {/* Top row — code · title · status */}
                <div className="flex items-start gap-2.5">
                  {bulkMode && (
                    <input
                      type="checkbox"
                      checked={selectedTasks.has(task.id)}
                      onChange={() => {}}
                      onClick={e => e.stopPropagation()}
                      className="mt-0.5 w-4 h-4 rounded accent-violet-500 shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        title={`Task code · ${taskCode(task)}`}
                        onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(taskCode(task)) }}
                        className="text-[10px] font-mono font-semibold text-muted-foreground/70 bg-foreground/[0.04] border border-foreground/15 px-1.5 py-0.5 rounded shrink-0"
                      >
                        {taskCode(task)}
                      </span>
                      {task.is_recurring && <RefreshCw className="w-3 h-3 text-primary/60 shrink-0" />}
                      {task.recurring_parent_id && <RefreshCw className="w-3 h-3 text-muted-foreground/50 shrink-0" />}
                      <p className="font-medium text-sm text-foreground truncate">{task.title}</p>
                    </div>
                    {/* Meta line — client · service */}
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {task.client ? (
                        <>
                          {task.client.name}
                          {task.client.code && <span className="ml-1 text-[10px] font-mono text-muted-foreground/50">{task.client.code}</span>}
                        </>
                      ) : <InternalBadge />}
                      {' '}<span className="text-muted-foreground/40">·</span> {task.service?.name || '—'}
                    </p>
                  </div>
                  <div className="relative shrink-0">
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${getStatusColor(task.status)}`}>
                      {getStatusLabel(task.status)}
                    </span>
                    <select
                      value={task.status}
                      onChange={e => { e.stopPropagation(); updateStatus(task.id, e.target.value) }}
                      onClick={e => e.stopPropagation()}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    >
                      {manualStatusOptions(task.status).map(s => <option key={s} value={s}>{getStatusLabel(s)}</option>)}
                      {task.status === 'invoiced' && <option value="invoiced" disabled>Invoiced (system)</option>}
                    </select>
                  </div>
                </div>

                {/* Bottom row — date · billing · actions */}
                <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-border/50">
                  <span className="text-[11px] text-muted-foreground" title={fullTaskDate(task.task_date)}>
                    {formatTaskDate(task.task_date)}
                  </span>
                  <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                    {showBilling ? (
                      <span className="text-[11px] font-semibold text-foreground tabular-nums mr-2">
                        {(task.quantity ?? 1) > 1
                          ? <>{formatCurrency((task.billing_amount ?? 0) / (task.quantity ?? 1), task.currency as Currency)}<span className="text-muted-foreground/60 font-normal ml-1">×{task.quantity}</span></>
                          : formatCurrency(task.billing_amount ?? 0, task.currency as Currency)
                        }
                      </span>
                    ) : (
                      // Qty is not price data — stays visible even when Billing/Total are hidden.
                      <span className="text-[11px] font-medium text-muted-foreground tabular-nums mr-2">
                        Qty {task.quantity ?? 1}
                      </span>
                    )}
                    {can('tasks.assign') && (
                      <button
                        onClick={e => { e.stopPropagation(); openAssignModal(task) }}
                        title="Assign team"
                        className="p-1.5 rounded-md text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                        <Users className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {task.client_id && role === 'super_admin' && (
                      <button
                        type="button"
                        title={`Edit client: ${task.client?.name}`}
                        onClick={e => { e.stopPropagation(); setEditClientId(task.client_id); setEditClientServiceId(task.service_id ?? null) }}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-violet-400 hover:bg-violet-500/10 transition-colors">
                        <Building2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {permissionFlags?.contribView ? (
                      <button
                        type="button"
                        title="View contributions"
                        onClick={e => { e.stopPropagation(); setEditTask(task); setOpenOnContribTab(task.id) }}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-green-400 hover:bg-green-500/10 transition-colors">
                        <BarChart2 className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <a
                        href={`/dashboard/contributions?highlight=${task.id}`}
                        title="View contribution"
                        onClick={e => e.stopPropagation()}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-green-400 hover:bg-green-500/10 transition-colors">
                        <BarChart2 className="w-3.5 h-3.5" />
                      </a>
                    )}
                    {can('tasks.create') && (
                      <button
                        onClick={e => { e.stopPropagation(); duplicateTask(task) }}
                        disabled={duplicatingId === task.id}
                        title="Duplicate task"
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40">
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); initiateDelete(task.id) }}
                      title="Delete task"
                      className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
                })}
              </Fragment>
            ))
          })()}

          {/* Mobile Load More Button */}
          {mobileTasks.length < (dbMode ? dbModeResults.length : visibleTasks.length) && (
            <button
              onClick={() => setMobileLimit(l => l + 50)}
              className="w-full mt-4 h-[44px] bg-secondary border border-border text-foreground hover:bg-secondary/60 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
            >
              Load More
            </button>
          )}
        </div>
        </>
        )}

        {/* Board View */}
        {viewMode === 'board' && (() => {
          type BoardSection = { label: string; tasks: typeof visibleTasks; paramName?: string }
          type BoardColumn = {
            key: string
            badge: string       // small badge text (CQID, status icon, etc.)
            title: string       // column title
            subtitle?: string   // optional subtitle (date range, etc.)
            color: string       // badge bg color class
            sections: BoardSection[]
            totalCount: number
          }

          // ── Compute columns based on grouping ──
          let boardColumns: BoardColumn[] = []

          if (boardGroupBy === 'employee') {
            const visibleTaskIds = new Set(visibleTasks.map(t => t.id))
            const boardEmpIds = new Set([
              ...localAssignments.filter(a => visibleTaskIds.has(a.task_id)).map(a => a.employee_id),
              ...localGroupAssignments.filter(a => visibleTaskIds.has(a.task_id)).map(a => a.employee_id),
              ...localParamAssignments.filter(a => visibleTaskIds.has(a.task_id)).map(a => a.employee_id),
            ])
            boardColumns = employees.filter(e => boardEmpIds.has(e.id)).map(emp => {
              const taskAssigned = visibleTasks.filter(t => localAssignments.some(a => a.task_id === t.id && a.employee_id === emp.id))
              const groupSections = groups
                .map(g => ({
                  label: g.name,
                  tasks: visibleTasks.filter(t => localGroupAssignments.some(a => a.task_id === t.id && a.group_id === g.id && a.employee_id === emp.id)),
                }))
                .filter(s => s.tasks.length > 0)
              const myParamRows = localParamAssignments.filter(a => a.employee_id === emp.id && visibleTaskIds.has(a.task_id))
              const paramSections = parameters
                .filter(p => myParamRows.some(r => r.parameter_id === p.id))
                .map(p => ({
                  label: 'Parameters',
                  tasks: visibleTasks.filter(t => myParamRows.some(r => r.task_id === t.id && r.parameter_id === p.id)),
                  paramName: p.name,
                }))
              const sections: BoardSection[] = [
                { label: 'Tasks', tasks: taskAssigned },
                ...groupSections,
                ...paramSections,
              ]
              return {
                key: emp.id,
                badge: emp.cqid.replace('CQID', ''),
                title: dn(emp),
                subtitle: emp.cqid,
                color: 'bg-blue-500/15 border-blue-500/20 text-blue-400',
                sections,
                totalCount: sections.reduce((s, sec) => s + sec.tasks.length, 0),
              }
            })
            // Unassigned column
            const assignedTaskIds = new Set([
              ...localAssignments.map(a => a.task_id),
              ...localGroupAssignments.map(a => a.task_id),
              ...localParamAssignments.map(a => a.task_id),
            ])
            const unassigned = visibleTasks.filter(t => !assignedTaskIds.has(t.id))
            if (unassigned.length > 0) {
              boardColumns.push({
                key: 'unassigned',
                badge: '—',
                title: 'Unassigned',
                color: 'bg-foreground/[0.06] border-foreground/15 text-muted-foreground',
                sections: [{ label: 'Tasks', tasks: unassigned }],
                totalCount: unassigned.length,
              })
            }
          }
          else if (boardGroupBy === 'client') {
            const byClient = new Map<string, typeof visibleTasks>()
            visibleTasks.forEach(t => {
              const k = t.client_id || INTERNAL_CLIENT
              if (!byClient.has(k)) byClient.set(k, [])
              byClient.get(k)!.push(t)
            })
            boardColumns = [...byClient.entries()].map(([cId, tasks]) => {
              if (cId === INTERNAL_CLIENT) return {
                key: cId,
                badge: 'INT',
                title: 'Internal — Cirqle',
                color: 'bg-cyan-500/15 border-cyan-500/20 text-cyan-400',
                sections: [{ label: 'Tasks', tasks }],
                totalCount: tasks.length,
              }
              const c = clients.find(x => x.id === cId)
              return {
                key: cId,
                badge: c?.code || '?',
                title: c?.name || 'Unknown client',
                color: 'bg-violet-500/15 border-violet-500/20 text-violet-400',
                sections: [{ label: 'Tasks', tasks }],
                totalCount: tasks.length,
              }
            }).sort((a, b) => b.totalCount - a.totalCount)
          }
          else if (boardGroupBy === 'service') {
            const byService = new Map<string, typeof visibleTasks>()
            visibleTasks.forEach(t => {
              const k = t.service_id || 'unknown'
              if (!byService.has(k)) byService.set(k, [])
              byService.get(k)!.push(t)
            })
            boardColumns = [...byService.entries()].map(([sId, tasks]) => {
              const s = sortedServices.find(x => x.id === sId)
              return {
                key: sId,
                badge: (s?.name || '?').slice(0, 2).toUpperCase(),
                title: s?.name || 'Unknown service',
                color: 'bg-cyan-500/15 border-cyan-500/20 text-cyan-400',
                sections: [{ label: 'Tasks', tasks }],
                totalCount: tasks.length,
              }
            }).sort((a, b) => b.totalCount - a.totalCount)
          }
          else if (boardGroupBy === 'status') {
            const statusOrder: { key: string; label: string; color: string; badge: string }[] = [
              { key: 'pending',     label: 'New',         color: 'bg-amber-500/15 border-amber-500/20 text-amber-400',  badge: '⋯' },
              { key: 'in_progress', label: 'In Progress', color: 'bg-blue-500/15 border-blue-500/20 text-blue-400',     badge: '▶' },
              { key: 'delivered',   label: 'Delivered',   color: 'bg-violet-500/15 border-violet-500/20 text-violet-700 dark:text-violet-300', badge: '↗' },
              { key: 'done',        label: 'Done',        color: 'bg-green-500/15 border-green-500/20 text-green-400',  badge: '✓' },
              { key: 'invoiced',    label: 'Invoiced',    color: 'bg-purple-500/15 border-purple-500/20 text-purple-400', badge: '$' },
              { key: 'cancelled',   label: 'Cancelled',   color: 'bg-red-500/15 border-red-500/20 text-red-400',         badge: '✗' },
            ]
            boardColumns = statusOrder.map(s => {
              const tasks = visibleTasks.filter(t => t.status === s.key)
              return {
                key: s.key,
                badge: s.badge,
                title: s.label,
                color: s.color,
                sections: [{ label: 'Tasks', tasks }],
                totalCount: tasks.length,
              }
            }).filter(c => c.totalCount > 0)
          }
          else if (boardGroupBy === 'date') {
            const fmtMonth = (d: Date) => d.toLocaleString('en-US', { month: 'short', year: 'numeric' })
            const fmtDay = (d: Date) => d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
            const startOfWeek = (d: Date) => {
              const r = new Date(d); r.setHours(0, 0, 0, 0)
              const day = r.getDay()
              const diff = (day === 0 ? -6 : 1 - day) // Monday start
              r.setDate(r.getDate() + diff)
              return r
            }
            const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

            if (boardDateGranularity === 'preset') {
              const now = new Date(); now.setHours(0, 0, 0, 0)
              const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
              const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7)
              const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 30)
              const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
              const buckets = [
                { key: 'upcoming', title: 'Upcoming',   check: (d: Date) => d.getTime() >= tomorrow.getTime(),                                              color: 'bg-orange-500/15 border-orange-500/20 text-orange-400',  badge: '↑' },
                { key: 'today',    title: 'Today',      check: (_d: Date, s: string) => s === todayStr,                                                     color: 'bg-green-500/15 border-green-500/20 text-green-400',     badge: '!' },
                { key: 'week',     title: 'This Week',  check: (d: Date, s: string) => s !== todayStr && d.getTime() >= weekAgo.getTime() && d.getTime() < now.getTime(),  color: 'bg-blue-500/15 border-blue-500/20 text-blue-400',       badge: '7' },
                { key: 'month',    title: 'This Month', check: (d: Date, s: string) => s !== todayStr && d.getTime() >= monthAgo.getTime() && d.getTime() < weekAgo.getTime(), color: 'bg-violet-500/15 border-violet-500/20 text-violet-400', badge: '30' },
                { key: 'older',    title: 'Older',      check: (d: Date) => d.getTime() < monthAgo.getTime(),                                               color: 'bg-foreground/[0.06] border-foreground/15 text-muted-foreground', badge: '∞' },
              ]
              boardColumns = buckets.map(b => {
                const tasks = visibleTasks.filter(t => {
                  const d = new Date(t.task_date)
                  return !isNaN(d.getTime()) && b.check(d, t.task_date)
                })
                return {
                  key: b.key,
                  badge: b.badge,
                  title: b.title,
                  color: b.color,
                  sections: [{ label: 'Tasks', tasks }],
                  totalCount: tasks.length,
                }
              }).filter(c => c.totalCount > 0)
            } else {
              const byKey = new Map<string, { tasks: typeof visibleTasks; date: Date; title: string }>()
              visibleTasks.forEach(t => {
                const d = new Date(t.task_date)
                if (isNaN(d.getTime())) return
                let key: string, title: string, anchorDate: Date
                if (boardDateGranularity === 'daily') {
                  anchorDate = d
                  key = ymd(d)
                  title = fmtDay(d)
                } else if (boardDateGranularity === 'weekly') {
                  anchorDate = startOfWeek(d)
                  key = ymd(anchorDate)
                  title = `Week of ${fmtDay(anchorDate)}`
                } else { // monthly
                  anchorDate = new Date(d.getFullYear(), d.getMonth(), 1)
                  key = `${anchorDate.getFullYear()}-${String(anchorDate.getMonth() + 1).padStart(2, '0')}`
                  title = fmtMonth(anchorDate)
                }
                if (!byKey.has(key)) byKey.set(key, { tasks: [], date: anchorDate, title })
                byKey.get(key)!.tasks.push(t)
              })
              boardColumns = [...byKey.entries()]
                .sort((a, b) => b[1].date.getTime() - a[1].date.getTime())
                .map(([key, v]) => ({
                  key,
                  badge: boardDateGranularity === 'monthly' ? v.date.toLocaleString('en-US', { month: 'short' }).slice(0, 3) :
                         boardDateGranularity === 'weekly' ? 'W' : String(v.date.getDate()),
                  title: v.title,
                  color: 'bg-violet-500/15 border-violet-500/20 text-violet-400',
                  sections: [{ label: 'Tasks', tasks: v.tasks }],
                  totalCount: v.tasks.length,
                }))
            }
          }

          // Helper: render assignment chips for a task
          const renderTaskChips = (task: typeof visibleTasks[number]) => {
            const taskEmpIds = localAssignments.filter(a => a.task_id === task.id).map(a => a.employee_id)
            const groupCount = localGroupAssignments.filter(a => a.task_id === task.id).length
            const paramCount = localParamAssignments.filter(a => a.task_id === task.id).length
            if (taskEmpIds.length === 0 && groupCount === 0 && paramCount === 0) return null
            return (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {taskEmpIds.map(eId => {
                  const e = employees.find(x => x.id === eId)
                  if (!e) return null
                  return (
                    <span key={eId} className="text-[9px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded-full">
                      {e.cqid}
                    </span>
                  )
                })}
                {groupCount > 0 && (
                  <span className="text-[9px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded-full inline-flex items-center gap-0.5">
                    <Layers className="w-2.5 h-2.5" />{groupCount}g
                  </span>
                )}
                {paramCount > 0 && (
                  <span className="text-[9px] bg-purple-500/[0.07] text-purple-700 dark:text-purple-300/60 border border-purple-500/10 px-1.5 py-0.5 rounded-full">
                    {paramCount}p
                  </span>
                )}
              </div>
            )
          }

          return (
            // Board scroll container — owns BOTH x and y scroll. Sticky column headers
            // (top-0 inside) work because this is the nearest scroll ancestor.
            // Height = viewport - sticky page header (92px) - sticky toolbar (~120px) - some padding.
            <div className="overflow-auto pb-4 h-[calc(100dvh-220px)]">
              <div className="flex gap-4 min-w-max">
                {boardColumns.length === 0 && (
                  <p className="text-sm text-muted-foreground italic px-2 py-10">
                    No tasks match the current filters.
                  </p>
                )}
                {boardColumns.map(col => (
                  <div key={col.key} className="w-72 flex flex-col gap-3 shrink-0">
                    {/* Column header — sticky to top of board scroll container so it stays visible while scrolling cards */}
                    <div className="sticky top-0 z-10 flex items-center gap-2 px-1 py-2 bg-background/95 backdrop-blur-sm rounded-lg">
                      <div className={`w-7 h-7 rounded-full border flex items-center justify-center shrink-0 ${col.color}`}>
                        <span className="text-[10px] font-bold">{col.badge}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{col.title}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {col.subtitle && <span className="mr-1">{col.subtitle} ·</span>}
                          {col.totalCount} item{col.totalCount !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>

                    {/* Sections */}
                    {col.sections.map(section => section.tasks.length > 0 && (
                      <div key={section.label}>
                        {/* Only show section label when grouping by employee (where multiple sections matter) */}
                        {boardGroupBy === 'employee' && col.sections.filter(s => s.tasks.length > 0).length > 1 && (
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-1.5">{section.label}</p>
                        )}
                        <div className="space-y-2">
                          {section.tasks.map(task => (
                            <div
                              key={task.id + section.label + (section.paramName || '')}
                              onClick={() => openEdit(task)}
                              className="bg-card border border-border/60 rounded-xl p-3 hover:border-violet-500/30 hover:shadow-sm transition-all group cursor-pointer"
                            >
                              <div className="flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 mb-0.5">
                                    <span
                                      title={`Task code · click to copy ${taskCode(task)}`}
                                      onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(taskCode(task)) }}
                                      className="text-[9px] font-mono font-semibold text-muted-foreground/60 bg-foreground/[0.04] border border-foreground/15 px-1 py-0.5 rounded shrink-0 cursor-pointer hover:text-foreground hover:border-foreground/25 transition-colors"
                                    >
                                      {taskCode(task)}
                                    </span>
                                    {requestRefByTaskId[task.id] && (
                                      <span
                                        title="From a client request — click for the brief"
                                        onClick={e => { e.stopPropagation(); openRequestBrief(task.id) }}
                                        className="text-[9px] font-mono font-semibold text-violet-400 bg-violet-500/10 border border-violet-500/25 px-1 py-0.5 rounded shrink-0 cursor-pointer hover:bg-violet-500/20 transition-colors"
                                      >
                                        REQ-{String(requestRefByTaskId[task.id].ref_no).padStart(4, '0')}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-sm font-medium text-foreground leading-tight truncate">{task.title}</p>
                                  {section.paramName && <p className="text-[10px] text-purple-400 mt-0.5">{section.paramName}</p>}
                                </div>
                                {can('tasks.assign') && (
                                  <button
                                    onClick={e => { e.stopPropagation(); openAssignModal(task) }}
                                    title="Assign team"
                                    className="lg:opacity-0 opacity-100 group-hover:opacity-100 text-muted-foreground hover:text-blue-400 transition-all p-1 rounded hover:bg-blue-500/10 shrink-0"
                                  >
                                    <Users className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {can('tasks.create') && (
                                  <button
                                    onClick={e => { e.stopPropagation(); duplicateTask(task) }}
                                    disabled={duplicatingId === task.id}
                                    title="Duplicate task"
                                    className="lg:opacity-0 opacity-100 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-all p-1 rounded hover:bg-secondary shrink-0 disabled:opacity-40"
                                  >
                                    <Copy className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                {boardGroupBy !== 'client' && (
                                  task.client
                                    ? <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">{task.client.name}{task.client.code ? ` · ${task.client.code}` : ''}</span>
                                    : <InternalBadge />
                                )}
                                {boardGroupBy !== 'service' && task.service?.name && (
                                  <span className="text-[10px] text-cyan-400/60">{task.service.name}</span>
                                )}
                                {boardGroupBy !== 'status' && (
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${getStatusColor(task.status)}`}>{getStatusLabel(task.status)}</span>
                                )}
                                {boardGroupBy !== 'date' && (
                                  <span className="text-[10px] text-muted-foreground/50" title={fullTaskDate(task.task_date)}>{formatTaskDate(task.task_date)}</span>
                                )}
                              </div>
                              {renderTaskChips(task)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* Calendar View */}
        {viewMode === 'calendar' && (() => {
          const calYear = calViewYear
          const calMonth = calViewMonth
          const firstDay = new Date(calYear, calMonth, 1)
          const lastDay = new Date(calYear, calMonth + 1, 0)
          const firstWeekday = firstDay.getDay() // 0 = Sunday
          // Build a 6x7 grid of dates (some leading/trailing days from adjacent months)
          const grid: { date: Date; inMonth: boolean }[] = []
          const start = new Date(calYear, calMonth, 1 - firstWeekday)
          for (let i = 0; i < 42; i++) {
            const d = new Date(start)
            d.setDate(start.getDate() + i)
            grid.push({ date: d, inMonth: d.getMonth() === calMonth })
          }
          // suppress unused-var warning for lastDay (used implicitly via month math)
          void lastDay
          // Group visibleTasks by YYYY-MM-DD
          const tasksByDate = new Map<string, typeof visibleTasks>()
          visibleTasks.forEach(t => {
            const k = t.task_date
            if (!k) return
            if (!tasksByDate.has(k)) tasksByDate.set(k, [])
            tasksByDate.get(k)!.push(t)
          })
          const monthLabel = firstDay.toLocaleString('en-US', { month: 'long', year: 'numeric' })
          const today = new Date(); today.setHours(0, 0, 0, 0)
          const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

          return (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              {/* Month nav header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      let y = calYear, m = calMonth - 1
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
                      let y = calYear, m = calMonth + 1
                      if (m > 11) { m = 0; y += 1 }
                      setCalViewYear(y); setCalViewMonth(m)
                    }}
                    className="p-1.5 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
                <h3 className="text-sm font-semibold">{monthLabel}</h3>
                <span className="text-[10px] text-muted-foreground">{visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''} this view</span>
                {tasks.length > visibleTasks.length && <span className="text-[10px] text-muted-foreground/50 ml-1">({tasks.length} total loaded)</span>}
              </div>

              {/* Weekday headers */}
              <div className="grid grid-cols-7 border-b border-border bg-secondary/30">
                {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                  <div key={d} className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-center">
                    {d}
                  </div>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7">
                {grid.map((cell, i) => {
                  const key = ymd(cell.date)
                  const dayTasks = tasksByDate.get(key) || []
                  const isToday = cell.date.getTime() === today.getTime()
                  return (
                    <div
                      key={i}
                      className={`min-h-[100px] border-r border-b border-border/40 p-1.5 ${!cell.inMonth ? 'bg-secondary/60 opacity-40' : ''} ${(i+1) % 7 === 0 ? 'border-r-0' : ''} ${i >= 35 ? 'border-b-0' : ''} ${isToday ? 'bg-primary/[0.06] ring-1 ring-inset ring-primary/30' : ''}`}
                    >
                      <div className={`flex items-center justify-between mb-1`}>
                        <span className={`text-[11px] font-medium ${isToday ? 'bg-primary text-white rounded-full w-5 h-5 flex items-center justify-center' : 'text-muted-foreground'}`}>
                          {cell.date.getDate()}
                        </span>
                        {dayTasks.length > 0 && (
                          <span className="text-[9px] bg-violet-500/15 text-violet-400 border border-violet-500/20 px-1 rounded-full">
                            {dayTasks.length}
                          </span>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        {dayTasks.slice(0, 3).map(task => (
                          <button
                            key={task.id}
                            onClick={() => openEdit(task)}
                            className={`w-full text-left text-[10px] truncate px-1.5 py-0.5 rounded ${getStatusColor(task.status)} hover:opacity-80 transition-opacity`}
                            title={`${taskCode(task)} · ${task.title} — ${task.client?.name || 'Internal'}`}
                          >
                            <span className="opacity-60 mr-1 font-mono">{taskCode(task)}</span>{task.title}
                          </button>
                        ))}
                        {dayTasks.length > 3 && (
                          <p className="text-[9px] text-muted-foreground px-1.5">+{dayTasks.length - 3} more</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}
      </div>}

      {/* ── Cancellation Wizard Modal ── */}
      {cancelModal && (
        <ModalOverlay onClose={() => setCancelModal(null)} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl max-h-[90dvh] overflow-y-auto">
            {/* Header */}
            <div className="px-6 py-4 border-b border-border flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center shrink-0">
                <Ban className="w-5 h-5 text-red-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold">Cancel Job</h2>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {cancelModal.title}
                  {cancelModal.client?.name && ` — ${cancelModal.client.name}`}
                </p>
              </div>
              <button onClick={() => setCancelModal(null)} className="text-muted-foreground hover:text-foreground p-1">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* Task summary */}
              <div className="flex gap-3 text-xs bg-secondary/50 rounded-xl px-4 py-3">
                <div className="flex-1">
                  <span className="text-muted-foreground">Service</span>
                  <div className="font-medium mt-0.5">{cancelModal.service?.name || '—'}</div>
                </div>
                <div className="flex-1">
                  <span className="text-muted-foreground">Billed Value</span>
                  <div className="font-medium mt-0.5">{formatCurrency(cancelModal.billing_amount ?? 0, cancelModal.currency as Currency)}</div>
                </div>
                <div className="flex-1">
                  <span className="text-muted-foreground">Current Status</span>
                  <div className={`inline-block px-1.5 py-0.5 rounded mt-0.5 text-[10px] font-semibold ${getStatusColor(cancelModal.status)}`}>
                    {getStatusLabel(cancelModal.status)}
                  </div>
                </div>
              </div>

              {/* Who cancelled */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-2 block">Who cancelled this job?</label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['client',  '👤', 'Client Request', 'Client asked to stop the job'],
                    ['company', '🏢', 'Company Decision', 'Internal decision to cancel'],
                    ['no_show', '🚫', 'Client No-show', 'Client became unresponsive'],
                  ] as const).map(([val, emoji, label, desc]) => (
                    <button key={val}
                      onClick={() => setCancelForm(p => ({ ...p, cancelled_by: val }))}
                      className={`flex flex-col items-center text-center gap-1 p-3 rounded-xl border text-xs transition-colors ${cancelForm.cancelled_by === val ? 'bg-red-500/15 border-red-500/40 text-red-700 dark:text-red-300' : 'border-border/50 text-muted-foreground hover:border-border'}`}>
                      <span className="text-lg">{emoji}</span>
                      <span className="font-semibold">{label}</span>
                      <span className="text-[9px] opacity-70">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Work completion slider */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-muted-foreground">Work Completed</label>
                  <span className="text-sm font-bold text-foreground">{cancelForm.completion_pct}%</span>
                </div>
                <input
                  type="range" min={0} max={100} step={5}
                  value={cancelForm.completion_pct}
                  onChange={e => {
                    const pct = parseInt(e.target.value)
                    setCancelForm(p => ({
                      ...p,
                      completion_pct: pct,
                      // Auto-suggest loss = billing × completion%
                      loss_amount: (cancelModal.billing_amount_inr ?? 0) > 0
                        ? String(Math.round((cancelModal.billing_amount_inr ?? 0) * pct / 100))
                        : p.loss_amount,
                    }))
                  }}
                  className="w-full accent-red-500"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                  <span>0% — Not started</span>
                  <span>50% — Half done</span>
                  <span>100% — Fully done</span>
                </div>
              </div>

              {/* Honor contributions + Loss amount */}
              <div className="space-y-3">
                {/* Toggle: honor contributions */}
                <div
                  onClick={() => setCancelForm(p => ({ ...p, honor_contributions: !p.honor_contributions }))}
                  className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${cancelForm.honor_contributions ? 'bg-green-500/10 border-green-500/30' : 'bg-foreground/[0.02] border-border/40 hover:border-border'}`}>
                  <div className={`mt-0.5 w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors ${cancelForm.honor_contributions ? 'bg-green-500 border-green-500' : 'border-border/60'}`}>
                    {cancelForm.honor_contributions && <span className="text-[11px] text-white font-bold">✓</span>}
                  </div>
                  <div>
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-green-400" />Pay Employees for Work Done
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      Keep employee contribution records — they receive their earnings despite client cancellation.
                      The cost becomes a company loss.
                    </div>
                  </div>
                </div>

                {/* Loss amount input */}
                {cancelForm.honor_contributions && (
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground mb-1.5 block flex items-center gap-1.5">
                      <TrendingDown className="w-3 h-3 text-red-400" />
                      Loss Amount (INR) — Employee cost to absorb
                    </label>
                    <input
                      type="number" min="0"
                      value={cancelForm.loss_amount}
                      onChange={e => setCancelForm(p => ({ ...p, loss_amount: e.target.value }))}
                      placeholder="e.g. 3500"
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/30"
                    />
                    <div className="text-[10px] text-muted-foreground mt-1">
                      Auto-suggested: {formatCurrency((cancelModal.billing_amount_inr ?? 0) * cancelForm.completion_pct / 100, cancelModal.currency as Currency)} ({cancelForm.completion_pct}% of billing value)
                    </div>
                  </div>
                )}

                {/* Toggle: record in cashbook */}
                {cancelForm.honor_contributions && parseFloat(cancelForm.loss_amount) > 0 && (
                  <div
                    onClick={() => setCancelForm(p => ({ ...p, record_cashbook: !p.record_cashbook }))}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer text-xs transition-colors ${cancelForm.record_cashbook ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}>
                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${cancelForm.record_cashbook ? 'bg-amber-500 border-amber-500' : 'border-border/60'}`}>
                      {cancelForm.record_cashbook && <span className="text-[10px] text-white font-bold">✓</span>}
                    </div>
                    Record {formatCurrency(parseFloat(cancelForm.loss_amount) || 0, cancelModal.currency as Currency)} as outflow in Cash Book
                    <span className="text-muted-foreground text-[10px]">(affects bank balance)</span>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Cancellation Notes (optional)</label>
                <textarea
                  value={cancelForm.notes}
                  onChange={e => setCancelForm(p => ({ ...p, notes: e.target.value }))}
                  rows={2}
                  placeholder="e.g. Client said budget cut, design started but not finalized…"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/30 resize-none"
                />
              </div>

              {/* Summary box */}
              <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3 text-xs space-y-1">
                <div className="font-semibold text-red-400 mb-1.5">Cancellation Summary</div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Cancelled by</span>
                  <span className="text-foreground capitalize">{cancelForm.cancelled_by.replace('_', ' ')}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Work done</span>
                  <span className="text-foreground">{cancelForm.completion_pct}%</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Employee pay</span>
                  <span className={cancelForm.honor_contributions ? 'text-green-400' : 'text-red-400'}>
                    {cancelForm.honor_contributions ? 'Honored ✓' : 'Not paid ✗'}
                  </span>
                </div>
                {cancelForm.honor_contributions && parseFloat(cancelForm.loss_amount) > 0 && (
                  <div className="flex justify-between text-muted-foreground border-t border-red-500/20 pt-1 mt-1">
                    <span>Company loss</span>
                    <span className="text-red-400 font-semibold">
                      − {formatCurrency(parseFloat(cancelForm.loss_amount), cancelModal.currency as Currency)}
                      {cancelForm.record_cashbook ? ' (cashbook)' : ''}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setCancelModal(null)}
                className="flex-1 py-2.5 bg-secondary text-sm font-medium rounded-xl hover:bg-secondary/80 transition-colors">
                Keep Job Active
              </button>
              <button onClick={handleCancellation} disabled={cancelSaving}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors">
                <Ban className="w-4 h-4" />
                {cancelSaving ? 'Saving…' : 'Confirm Cancellation'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Bulk action toolbar ── */}
      {bulkMode && (
        <BatchActionBar
          count={selectedTasks.size}
          onClear={() => { setSelectedTasks(new Set()); setBulkMode(false) }}
          actions={[
            { key: 'done', label: 'Done', icon: <CheckCircle className="w-3.5 h-3.5" />, tint: 'emerald', onClick: () => bulkUpdateStatus('done') },
            { key: 'pending', label: 'Pending', icon: <Hash className="w-3.5 h-3.5" />, tint: 'yellow', onClick: () => bulkUpdateStatus('pending') },
            { key: 'assign', label: 'Assign', icon: <Users className="w-3.5 h-3.5" />, tint: 'cyan', onClick: openBulkAssign },
            { key: 'delete', label: 'Delete', icon: <Trash2 className="w-3.5 h-3.5" />, tint: 'red', onClick: () => setBulkDeleteConfirm(true) },
          ] as BatchAction[]}
        />
      )}

      {/* ── Bulk Assign modal ── */}
      {bulkAssignOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Reassign {selectedTasks.size} task{selectedTasks.size !== 1 ? 's' : ''}</h3>
              <button onClick={() => setBulkAssignOpen(false)} className="p-1 rounded text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-muted-foreground">Replaces each task's current assignees with the employees selected below.</p>
            <div className="max-h-64 overflow-y-auto space-y-1 border border-border rounded-xl p-2">
              {employees.filter(e => e.is_active).map(emp => (
                <label key={emp.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bulkAssignSelected.has(emp.id)}
                    onChange={() => setBulkAssignSelected(prev => {
                      const next = new Set(prev)
                      next.has(emp.id) ? next.delete(emp.id) : next.add(emp.id)
                      return next
                    })}
                    className="accent-violet-500"
                  />
                  <span className="text-sm">{dn(emp)}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setBulkAssignOpen(false)} className="flex-1 px-4 py-2 rounded-xl border border-border text-sm font-medium hover:bg-secondary">Cancel</button>
              <button onClick={saveBulkAssign} disabled={bulkAssignSaving}
                className="flex-1 px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-500 disabled:opacity-50">
                {bulkAssignSaving ? 'Saving…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Delete confirm ── */}
      {bulkDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">Delete {selectedTasks.size} task{selectedTasks.size !== 1 ? 's' : ''}?</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Moved to Trash — recoverable for a limited time.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setBulkDeleteConfirm(false)} className="flex-1 px-4 py-2 rounded-xl border border-border text-sm font-medium hover:bg-secondary">Cancel</button>
              <button onClick={confirmBulkDelete} disabled={bulkDeleting}
                className="flex-1 px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 disabled:opacity-50">
                {bulkDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                {showTrash ? (
                  <>
                    <p className="font-semibold">Delete Forever?</p>
                    <p className="text-sm text-muted-foreground">This cannot be undone — no recovery.</p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold">Move to Trash?</p>
                    <p className="text-sm text-muted-foreground">You can restore it within 45 days.</p>
                  </>
                )}
              </div>
            </div>
            {deleteConfirmHasScores && (
              <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3.5 py-3">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">This task has contribution scores</p>
                  <p className="text-xs text-amber-400/80 mt-0.5">
                    Employee earnings and payroll linked to this task will be recalculated and may decrease.
                  </p>
                </div>
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => { setDeleteConfirm(null); setDeleteConfirmHasScores(false) }} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => showTrash ? handlePermanentDelete(deleteConfirm) : handleDelete(deleteConfirm)}
                disabled={deleting}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white text-sm font-medium py-2.5 rounded-lg disabled:opacity-50 transition-colors">
                {deleting ? '…' : showTrash ? 'Delete Forever' : 'Move to Trash'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign Team Modal ── */}
      {assignModal && (() => {
        const relevantGroups = assignModal.serviceId
          ? groups.filter(g => groupServices.some(gs => gs.group_id === g.id && gs.service_id === assignModal.serviceId))
          : groups
        const allGroups = relevantGroups.length > 0 ? relevantGroups : groups

        return (
          <ModalOverlay onClose={() => setAssignModal(null)}>
            <div className="bg-secondary border border-foreground/15 rounded-2xl w-full max-w-[500px] shadow-2xl flex flex-col max-h-[90vh]">

              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-foreground/15 shrink-0">
                <div>
                  <h2 className="font-semibold text-sm flex items-center gap-2">
                    <Users className="w-4 h-4 text-blue-400" /> Assign Team
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-72">
                    <span className="font-mono text-muted-foreground/60 mr-1.5">{taskCode(assignModal.taskNumber)}</span>
                    {assignModal.taskTitle}
                  </p>
                </div>
                <button onClick={() => setAssignModal(null)} className="text-muted-foreground hover:text-foreground p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-white/[0.06]">

                {/* ── Section 1: Team ── */}
                <div className="px-5 py-4">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                    Team — who works on this task?
                  </p>
                  {employees.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">No employees found. Add in Settings first.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {employees.map(emp => {
                        const on = assignSelected.has(emp.id)
                        return (
                          <button
                            key={emp.id}
                            type="button"
                            onClick={() => setAssignSelected(prev => {
                              const next = new Set(prev)
                              if (next.has(emp.id)) next.delete(emp.id)
                              else next.add(emp.id)
                              return next
                            })}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                              on
                                ? 'bg-blue-500/15 border-blue-500/40 text-blue-700 dark:text-blue-300'
                                : 'bg-foreground/[0.04] border-foreground/15 text-muted-foreground hover:border-foreground/20 hover:text-foreground'
                            }`}
                          >
                            {on && <CheckCircle className="w-3.5 h-3.5 shrink-0" />}
                            <span>{dn(emp)}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* ── Section 2: Per-Employee Assignments ── */}
                {assignSelected.size > 0 && allGroups.length > 0 && (
                  <div className="px-5 py-4">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <Layers className="w-3.5 h-3.5 text-purple-400" />
                      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Assignments per Person
                      </p>
                      <span className="text-[10px] text-muted-foreground/50 bg-foreground/[0.04] px-1.5 py-0.5 rounded-full">optional</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
                      For each team member, add the groups they handle. Then add specific parameters from those groups.
                    </p>

                    <div className="space-y-2">
                      {[...assignSelected].map(empId => {
                        const emp = employees.find(e => e.id === empId)
                        if (!emp) return null

                        const myGroupIds = empGroups[empId] ? [...empGroups[empId]] : []
                        const myParamIds = empParams[empId] ? [...empParams[empId]] : []
                        const isExpanded = expandedEmpCards.has(empId)

                        // Available groups to ADD (not already assigned to this employee)
                        const addableGroups = allGroups.filter(g => !empGroups[empId]?.has(g.id))

                        // Available parameters to ADD: only from groups assigned to this employee, and not already assigned
                        const addableParams = parameters
                          .filter(p => empGroups[empId]?.has(p.group_id))
                          .filter(p => !empParams[empId]?.has(p.id))
                          .sort((a, b) => a.display_order - b.display_order)

                        return (
                          <div key={empId} className={`rounded-xl border overflow-hidden transition-colors ${
                            (myGroupIds.length > 0 || myParamIds.length > 0)
                              ? 'border-purple-500/25 bg-purple-500/[0.04]'
                              : 'border-foreground/[0.07] bg-foreground/[0.01]'
                          }`}>
                            {/* Employee header — clickable to expand */}
                            <button
                              type="button"
                              onClick={() => setExpandedEmpCards(prev => {
                                const next = new Set(prev)
                                if (next.has(empId)) next.delete(empId)
                                else next.add(empId)
                                return next
                              })}
                              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-foreground/[0.02] transition-colors text-left"
                            >
                              <div className="w-7 h-7 rounded-full bg-blue-500/15 border border-blue-500/20 flex items-center justify-center shrink-0">
                                <span className="text-[10px] font-bold text-blue-400">{emp.cqid.replace('CQID', '')}</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold">{dn(emp)}</p>
                                <p className="text-[10px] text-muted-foreground">
                                  {myGroupIds.length} group{myGroupIds.length !== 1 ? 's' : ''} · {myParamIds.length} param{myParamIds.length !== 1 ? 's' : ''}
                                </p>
                              </div>
                              {isExpanded
                                ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                                : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                            </button>

                            {isExpanded && (
                              <div className="border-t border-foreground/[0.07] bg-secondary/60 px-3 py-3 space-y-3">

                                {/* GROUPS */}
                                <div>
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                                    Groups ({myGroupIds.length})
                                  </p>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {myGroupIds.map(gId => {
                                      const g = groups.find(x => x.id === gId)
                                      if (!g) return null
                                      return (
                                        <span key={gId} className="inline-flex items-center gap-1 text-xs bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/25 px-2 py-1 rounded-full">
                                          <Layers className="w-3 h-3" />
                                          {g.name}
                                          <button
                                            type="button"
                                            onClick={() => setEmpGroups(prev => {
                                              const next = { ...prev }
                                              const set = new Set(next[empId])
                                              set.delete(gId)
                                              next[empId] = set
                                              // Also remove any params from this group for this employee
                                              setEmpParams(prevP => {
                                                const nextP = { ...prevP }
                                                const pSet = new Set(nextP[empId])
                                                parameters.filter(p => p.group_id === gId).forEach(p => pSet.delete(p.id))
                                                nextP[empId] = pSet
                                                return nextP
                                              })
                                              return next
                                            })}
                                            className="ml-0.5 hover:text-foreground"
                                          >
                                            <X className="w-3 h-3" />
                                          </button>
                                        </span>
                                      )
                                    })}
                                    {addableGroups.length > 0 && (
                                      <div className="w-44">
                                        <Combobox
                                          options={addableGroups.map(g => ({ id: g.id, label: g.name }))}
                                          value=""
                                          onChange={gId => {
                                            if (!gId) return
                                            setEmpGroups(prev => {
                                              const next = { ...prev }
                                              const set = new Set(next[empId])
                                              set.add(gId)
                                              next[empId] = set
                                              return next
                                            })
                                          }}
                                          placeholder="+ Add group…"
                                          sortKey="task-assign-groups"
                                        />
                                      </div>
                                    )}
                                    {myGroupIds.length === 0 && addableGroups.length === 0 && (
                                      <span className="text-[10px] text-muted-foreground/50 italic">No groups available</span>
                                    )}
                                  </div>
                                </div>

                                {/* PARAMETERS — only from groups this employee handles */}
                                <div>
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                                    Parameters ({myParamIds.length})
                                  </p>
                                  {myGroupIds.length === 0 ? (
                                    <p className="text-[10px] text-muted-foreground/50 italic">
                                      Add a group above first — then parameters from that group will be available.
                                    </p>
                                  ) : (
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      {myParamIds.map(pId => {
                                        const p = parameters.find(x => x.id === pId)
                                        if (!p) return null
                                        const g = groups.find(x => x.id === p.group_id)
                                        return (
                                          <span key={pId} className="inline-flex items-center gap-1 text-xs bg-purple-500/10 text-purple-700 dark:text-purple-300/90 border border-purple-500/20 px-2 py-1 rounded-full">
                                            {p.name}
                                            {g && <span className="text-[9px] opacity-50">·{g.name.replace(' Group', '')}</span>}
                                            <span className="text-[9px] opacity-50">×{p.weight}</span>
                                            <button
                                              type="button"
                                              onClick={() => setEmpParams(prev => {
                                                const next = { ...prev }
                                                const set = new Set(next[empId])
                                                set.delete(pId)
                                                next[empId] = set
                                                return next
                                              })}
                                              className="ml-0.5 hover:text-foreground"
                                            >
                                              <X className="w-3 h-3" />
                                            </button>
                                          </span>
                                        )
                                      })}
                                      {addableParams.length > 0 && (
                                        <div className="w-52">
                                          <Combobox
                                            options={addableParams.map(p => {
                                              const g = groups.find(x => x.id === p.group_id)
                                              return {
                                                id: p.id,
                                                label: p.name,
                                                sub: g ? `${g.name} · ×${p.weight}` : `×${p.weight}`,
                                              }
                                            })}
                                            value=""
                                            onChange={pId => {
                                              if (!pId) return
                                              setEmpParams(prev => {
                                                const next = { ...prev }
                                                const set = new Set(next[empId])
                                                set.add(pId)
                                                next[empId] = set
                                                return next
                                              })
                                            }}
                                            placeholder="+ Add parameter…"
                                            sortKey="task-assign-params"
                                          />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Hint when no team selected yet */}
                {assignSelected.size === 0 && allGroups.length > 0 && (
                  <div className="px-5 py-4">
                    <p className="text-[11px] text-muted-foreground italic text-center">
                      Select team members above to start assigning groups and parameters.
                    </p>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-2 px-4 py-3 border-t border-foreground/15 shrink-0">
                <button onClick={() => setAssignModal(null)}
                  className="flex-1 py-2.5 rounded-xl border border-foreground/15 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  Cancel
                </button>
                <button onClick={saveAssignments} disabled={assignSaving}
                  className="flex-1 min-w-0 py-2.5 rounded-xl gradient-bg text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 px-3">
                  {assignSaving ? <span className="text-sm font-semibold">Saving…</span> : (
                    <>
                      <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-sm font-semibold leading-none">Save</span>
                      {(() => {
                        const totalGroups = new Set<string>()
                        Object.values(empGroups).forEach(set => set.forEach(g => totalGroups.add(g)))
                        const totalParams = new Set<string>()
                        Object.values(empParams).forEach(set => set.forEach(p => totalParams.add(p)))
                        const parts: string[] = []
                        if (assignSelected.size > 0) parts.push(`${assignSelected.size} member${assignSelected.size !== 1 ? 's' : ''}`)
                        if (totalGroups.size > 0) parts.push(`${totalGroups.size} group${totalGroups.size !== 1 ? 's' : ''}`)
                        if (totalParams.size > 0) parts.push(`${totalParams.size} param${totalParams.size !== 1 ? 's' : ''}`)
                        if (parts.length === 0) return null
                        return (
                          <span className="text-[10px] opacity-70 truncate leading-none">
                            · {parts.join(' · ')}
                          </span>
                        )
                      })()}
                    </>
                  )}
                </button>
              </div>
            </div>
          </ModalOverlay>
        )
      })()}

      {/* ── Workload Report Modal ── */}
      {showWorkload && (() => {
        // Build per-employee stats from local state
        const report = employees.map(emp => {
          const myTaskIds = new Set([
            ...localAssignments.filter(a => a.employee_id === emp.id).map(a => a.task_id),
            ...localGroupAssignments.filter(a => a.employee_id === emp.id).map(a => a.task_id),
            ...localParamAssignments.filter(a => a.employee_id === emp.id).map(a => a.task_id)
          ])
          const myTasks = tasks.filter(t => myTaskIds.has(t.id))
          const groupCount = localGroupAssignments.filter(a => a.employee_id === emp.id).length
          const paramCount = localParamAssignments.filter(a => a.employee_id === emp.id).length
          const pending = myTasks.filter(t => t.status === 'pending').length
          const inProgress = myTasks.filter(t => t.status === 'in_progress').length
          const done = myTasks.filter(t => t.status === 'done' || t.status === 'invoiced' || t.status === 'delivered' || t.status === 'paid').length
          const total = myTasks.length
          return { emp, total, pending, inProgress, done, groupCount, paramCount }
        }).filter(r => r.total > 0 || r.groupCount > 0 || r.paramCount > 0)
          .sort((a, b) => (b.pending + b.inProgress) - (a.pending + a.inProgress))

        return (
          <ModalOverlay onClose={() => setShowWorkload(false)}>
            <div className="bg-secondary border border-foreground/15 rounded-2xl w-full max-w-xl shadow-2xl flex flex-col max-h-[88vh]">
              <div className="flex items-center justify-between px-5 py-4 border-b border-foreground/15 shrink-0">
                <h2 className="font-semibold text-sm flex items-center gap-2">
                  <Users className="w-4 h-4 text-blue-400" /> Workload Report
                </h2>
                <button onClick={() => setShowWorkload(false)} className="text-muted-foreground hover:text-foreground p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {report.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-10">
                    No tasks assigned yet. Use the Assign button on each task to assign team members.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {report.map(({ emp, total, pending, inProgress, done, groupCount, paramCount }) => {
                      const backlog = pending + inProgress
                      const pctDone = total > 0 ? Math.round((done / total) * 100) : 0
                      return (
                        <div key={emp.id} className="rounded-xl border border-foreground/15 bg-foreground/[0.02] p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 rounded-full bg-blue-500/15 border border-blue-500/20 flex items-center justify-center">
                                <span className="text-xs font-bold text-blue-400">{emp.cqid}</span>
                              </div>
                              <div>
                                <p className="text-sm font-semibold">{dn(emp)}</p>
                                <p className="text-[11px] text-muted-foreground">{total} task{total !== 1 ? 's' : ''} assigned</p>
                              </div>
                            </div>
                            {backlog > 0 && (
                              <span className="text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-1 rounded-full">
                                {backlog} backlog
                              </span>
                            )}
                            {backlog === 0 && total > 0 && (
                              <span className="text-xs font-semibold bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-1 rounded-full">
                                All clear ✓
                              </span>
                            )}
                          </div>

                          {/* Status bars */}
                          <div className="grid grid-cols-3 gap-2 mb-3">
                            <div className="text-center bg-amber-500/5 rounded-lg py-2 border border-amber-500/10">
                              <p className="text-lg font-bold text-amber-400">{pending}</p>
                              <p className="text-[10px] text-muted-foreground">Pending</p>
                            </div>
                            <div className="text-center bg-blue-500/5 rounded-lg py-2 border border-blue-500/10">
                              <p className="text-lg font-bold text-blue-400">{inProgress}</p>
                              <p className="text-[10px] text-muted-foreground">In Progress</p>
                            </div>
                            <div className="text-center bg-green-500/5 rounded-lg py-2 border border-green-500/10">
                              <p className="text-lg font-bold text-green-400">{done}</p>
                              <p className="text-[10px] text-muted-foreground">Done</p>
                            </div>
                          </div>

                          {/* Progress bar */}
                          {total > 0 && (
                            <div className="mb-2">
                              <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                                <span>Progress</span>
                                <span>{pctDone}%</span>
                              </div>
                              <div className="h-1.5 bg-foreground/[0.06] rounded-full overflow-hidden">
                                <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all" style={{ width: `${pctDone}%` }} />
                              </div>
                            </div>
                          )}

                          {/* Group / param counts */}
                          {(groupCount > 0 || paramCount > 0) && (
                            <div className="flex gap-3 mt-2">
                              {groupCount > 0 && (
                                <span className="text-[10px] text-purple-400/70 bg-purple-500/5 border border-purple-500/15 px-2 py-0.5 rounded-full">
                                  {groupCount} group{groupCount !== 1 ? 's' : ''}
                                </span>
                              )}
                              {paramCount > 0 && (
                                <span className="text-[10px] text-purple-400/70 bg-purple-500/5 border border-purple-500/15 px-2 py-0.5 rounded-full">
                                  {paramCount} param{paramCount !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t border-foreground/15 shrink-0">
                <button onClick={() => setShowWorkload(false)}
                  className="w-full py-2.5 rounded-xl border border-foreground/15 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  Close
                </button>
              </div>
            </div>
          </ModalOverlay>
        )
      })()}

      {editTask && (
        <TaskEditModal
          task={editTask}
          clients={clients}
          services={services}
          clientPricings={clientPricings}
          showFinancials={showBilling}
          canViewContributions={permissionFlags?.contribView}
          canEditContributions={permissionFlags?.contribEdit}
          showEarnings={permissionFlags?.contribEarnings}
          contribViewScope={permissionFlags?.contribViewAll ? 'all' : 'own'}
          currentEmployeeId={currentEmployee?.id}
          initialTab={openOnContribTab === editTask.id ? 'contributions' : 'details'}
          employees={employees}
          groups={groups}
          parameters={parameters}
          groupServices={groupServices}
          onSaved={(data) => setTasks(prev => prev.map(t => t.id === data.id ? data : t))}
          onDeleted={(id) => {
            const t = tasks.find(t => t.id === id)
            if (t) setTrash(prev => [{ ...t, deleted_at: new Date().toISOString() }, ...prev])
            setTasks(prev => prev.filter(t => t.id !== id))
          }}
          onClose={() => { setEditTask(null); setOpenOnContribTab(null) }}
        />
      )}

      {/* Add Task Modal — full-screen bottom-sheet on mobile, centered dialog on desktop */}
      {showForm && (
        <ModalOverlay onClose={() => setShowForm(false)} sheetOnMobile>
          <div className="bg-card border border-border w-full max-h-[90dvh] sm:h-auto sm:max-w-lg sm:max-h-[90vh] shadow-2xl rounded-t-2xl sm:rounded-2xl flex flex-col">
            {/* Mobile drag-handle hint */}
            <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
              <div className="w-10 h-1 rounded-full bg-foreground/20" />
            </div>
            <div className="flex items-center justify-between px-5 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
              <h2 className="font-semibold text-base">Add Task</h2>
              <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-foreground p-1 -m-1"><X className="w-5 h-5" /></button>
            </div>
            <form ref={addFormRef} onSubmit={handleSubmit} className="px-5 sm:px-6 pt-4 pb-4 space-y-4 overflow-y-auto flex-1 min-h-0">

              {/* Task number + Title */}
              <div className="grid grid-cols-[88px_1fr] sm:grid-cols-[110px_1fr] gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Task #</label>
                  <input
                    type="number"
                    min="1"
                    value={form.task_number}
                    onChange={e => setForm(p => ({ ...p, task_number: e.target.value }))}
                    className={inputCls}
                    placeholder="Auto"
                    title="Leave blank for auto-assigned sequential number"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Title *</label>
                  <TitleAutocomplete
                    value={form.title}
                    onChange={v => setForm(p => ({ ...p, title: v }))}
                    required
                    className={inputCls}
                    placeholder="e.g. Offer Flyer — June batch"
                    localTitles={initialTasks.map(t => t.title).filter(Boolean) as string[]}
                  />
                </div>
              </div>

              {/* Client + Service */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Client <span className="text-muted-foreground/60 font-normal">(empty = internal work)</span></label>
                  <Combobox
                    options={[
                      { id: INTERNAL_CLIENT, label: 'Internal — Cirqle', sub: 'own brand work · never invoiced' },
                      ...clientList.map(c => ({ id: c.id, label: c.name, sub: c.code })),
                    ]}
                    value={form.client_id}
                    onChange={handleClientChange}
                    placeholder="Search client…"
                    sortKey="clients"
                    onAddNew={canCreateClient ? (q => setQuickCreate({ kind: 'client', query: q })) : undefined}
                    addNewLabel="Add client"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Service *</label>
                  <Combobox
                    options={sortedServices.map(s => ({
                      id: s.id,
                      label: s.name,
                      sub: initialTasks.some(t => t.service?.id === s.id) ? 'recent' : undefined
                    }))}
                    value={form.service_id}
                    onChange={handleServiceChange}
                    placeholder="Search service…"
                    sortKey="services"
                    onAddNew={canCreateService ? (q => setQuickCreate({ kind: 'service', query: q })) : undefined}
                    addNewLabel="Add service"
                  />
                </div>
              </div>

              {dupWarning && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
                  <span className="mt-0.5">⚠</span>
                  <span>
                    {dupWarning.createdBy} created a task with this exact title for this client{' '}
                    {dupWarning.minutesAgo === 0 ? 'just now'
                      : dupWarning.minutesAgo < 60 ? `${dupWarning.minutesAgo} min ago`
                      : (() => { const h = Math.round(dupWarning.minutesAgo / 60); return `${h} hour${h === 1 ? '' : 's'} ago` })()}
                    {dupWarning.taskNumber != null && <> (Task #{dupWarning.taskNumber})</>}.
                    {' '}Check it isn&apos;t already covered before adding another.
                  </span>
                </div>
              )}

              {/* ── Derived billing: "Handling = 30% of this month's posters" ──
                  Basic is three fields (services, %, preview); everything else
                  lives in the collapsed Advanced block, so the daily flow stays
                  as short as it was before this feature existed. */}
              {showBilling && !form.parent_task_id && (
                <div className="rounded-xl border border-foreground/15 bg-foreground/[0.02]">
                  <label className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      checked={form.derived_on}
                      onChange={e => setForm(p => ({ ...p, derived_on: e.target.checked }))}
                    />
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-foreground/5 text-[10px]">%</span>
                    Bill as a % of other services
                    <span className="text-[10px] text-muted-foreground/60">(e.g. handling, supervision, agency fee)</span>
                  </label>

                  {form.derived_on && (
                    <div className="space-y-2.5 border-t border-foreground/[0.06] px-3 pb-3 pt-2.5">
                      <div>
                        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Source services <span className="text-muted-foreground/60">— this task bills a % of their total</span>
                        </label>
                        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                          {sortedServices.map(s => {
                            const on = form.derived_service_ids.includes(s.id)
                            return (
                              <button
                                key={s.id} type="button"
                                onClick={() => setForm(p => ({
                                  ...p,
                                  derived_service_ids: on
                                    ? p.derived_service_ids.filter(id => id !== s.id)
                                    : [...p.derived_service_ids, s.id],
                                }))}
                                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                                  on ? 'border-violet-500 bg-violet-500 text-white'
                                     : 'border-border bg-secondary text-muted-foreground hover:border-foreground/30'}`}
                              >
                                {on && <CheckCircle className="mr-1 -mt-0.5 inline h-3 w-3" />}{s.name}
                              </button>
                            )
                          })}
                        </div>
                      </div>

                      <div className="flex items-end gap-3">
                        <div className="w-28">
                          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Percentage</label>
                          <div className="flex items-center gap-1">
                            <input
                              type="number" min="0" max="100" step="any"
                              value={form.derived_percent}
                              onChange={e => setForm(p => ({ ...p, derived_percent: e.target.value }))}
                              placeholder="30"
                              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                            />
                            <span className="text-sm text-muted-foreground">%</span>
                          </div>
                        </div>

                        {/* Live preview / "if you save now" — same numbers the server will compute */}
                        <div className="flex-1 pb-1 text-right">
                          {derivedPreview ? (
                            <>
                              <p className="text-xs text-muted-foreground">
                                {derivedPreview.basis.count} matching task{derivedPreview.basis.count === 1 ? '' : 's'}
                                {' · '}
                                {formatCurrency(
                                  derivedPreview.basis.native ?? derivedPreview.basis.inr,
                                  (derivedPreview.basis.uniformCurrency ?? 'INR') as Currency,
                                )}
                              </p>
                              <p className="text-lg font-bold">
                                {formatCurrency(derivedPreview.amounts.billingAmount, derivedPreview.amounts.currency as Currency)}
                              </p>
                              <p className="text-[10px] text-muted-foreground/60">based on loaded tasks · recalculated on save</p>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">Pick services and a % to preview</p>
                          )}
                        </div>
                      </div>

                      {derivedPreview && derivedPreview.duplicates.length > 0 && (
                        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                          ⚠ {derivedPreview.duplicates.length === 1 ? 'Another rule' : `${derivedPreview.duplicates.length} other rules`} already
                          bill this client from the same services this month
                          {derivedPreview.duplicates[0].title ? ` (e.g. “${derivedPreview.duplicates[0].title}”)` : ''}.
                          That is fine if you meant to stack them.
                        </p>
                      )}

                      <details className="rounded-lg border border-foreground/10">
                        <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground">
                          Advanced
                        </summary>
                        <div className="grid grid-cols-2 gap-2 border-t border-foreground/[0.06] px-2.5 pb-2.5 pt-2">
                          <div>
                            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Minimum charge (₹)</label>
                            <input
                              type="number" min="0" step="any" value={form.derived_min}
                              onChange={e => setForm(p => ({ ...p, derived_min: e.target.value }))}
                              placeholder="none"
                              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Maximum charge (₹)</label>
                            <input
                              type="number" min="0" step="any" value={form.derived_max}
                              onChange={e => setForm(p => ({ ...p, derived_max: e.target.value }))}
                              placeholder="none"
                              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                            />
                          </div>
                          <p className="col-span-2 text-[10px] text-muted-foreground/70">
                            Cancelled tasks never count. Turn on “Repeat monthly” above to make this a standing rule that bills every month.
                          </p>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              )}

              {/* ── Variant linking (collapsed by default; opens when a parent is picked) ── */}
              {!form.derived_on && (
              <div className="rounded-xl border border-foreground/15 bg-foreground/[0.02]">
                <details>
                  <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-2">
                    <span className="inline-flex w-4 h-4 items-center justify-center rounded bg-foreground/5 text-[10px]">↳</span>
                    Link as variant of another task <span className="text-[10px] text-muted-foreground/60">(revision / concept / size)</span>
                  </summary>
                  <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-foreground/[0.06]">
                    <div>
                      <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Parent task</label>
                      <Combobox
                        options={tasks
                          .filter(t => !t.parent_task_id)  // only original tasks can be parents
                          .map(t => ({ id: t.id, label: t.title, sub: `${t.client?.name ?? 'Internal'} · ${t.task_date}` }))}
                        value={form.parent_task_id}
                        onChange={(parentId: string) => {
                          const parent = tasks.find(t => t.id === parentId)
                          setForm(p => ({
                            ...p,
                            parent_task_id: parentId,
                            // Inherit client + service from parent for consistency
                            client_id: parent?.client?.id || p.client_id,
                            service_id: parent?.service?.id || p.service_id,
                          }))
                        }}
                        placeholder="Search original task…"
                      />
                      {form.parent_task_id && (
                        <button
                          type="button"
                          onClick={() => setForm(p => ({
                            ...p, parent_task_id: '', variant_type: '', variant_label: '',
                            billing_mode: 'fixed', billing_percent: '', billing_override: false,
                            is_billable: true, manual_billing_amount: '',
                          }))}
                          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          ✕ Unlink (make this an original task)
                        </button>
                      )}
                    </div>

                    {form.parent_task_id && (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Variant type</label>
                            <select
                              value={form.variant_type}
                              onChange={e => setForm(p => ({ ...p, variant_type: e.target.value as typeof p.variant_type }))}
                              className={inputCls}
                            >
                              <option value="">— Select —</option>
                              <option value="revision">Revision</option>
                              <option value="concept">Concept option</option>
                              <option value="size">Size variant</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Label</label>
                            <input
                              list="past-labels"
                              value={form.variant_label}
                              onChange={e => setForm(p => ({ ...p, variant_label: e.target.value }))}
                              className={inputCls}
                              placeholder={form.variant_type === 'size' ? 'e.g. Story' : form.variant_type === 'concept' ? 'e.g. Concept 2' : 'e.g. May date update'}
                            />
                            <datalist id="past-labels">
                              {Array.from(new Set(tasks.map(t => t.variant_label).filter(l => typeof l === 'string' && l.trim().length > 0))).map(label => (
                                <option key={label as string} value={label as string} />
                              ))}
                            </datalist>
                            {form.variant_type && (() => {
                              const chips = form.variant_type === 'size' ? ['Instagram', 'Facebook', 'Story', 'Reel', 'A4', 'A5'] 
                                : form.variant_type === 'concept' ? ['Concept 1', 'Concept 2', 'Option A', 'Option B']
                                : ['Client Feedback', 'Internal Feedback', 'Minor Tweak']
                              return (
                                <div className="flex flex-wrap gap-1.5 mt-2">
                                  {chips.map(chip => (
                                    <button
                                      key={chip}
                                      type="button"
                                      onClick={() => setForm(p => ({ ...p, variant_label: chip }))}
                                      className={`px-2 py-0.5 text-[10px] font-medium rounded-full border transition-colors ${form.variant_label === chip ? 'bg-primary/10 text-primary border-primary/20' : 'bg-secondary/40 text-muted-foreground border-border hover:bg-secondary hover:text-foreground'}`}
                                    >
                                      {chip}
                                    </button>
                                  ))}
                                </div>
                              )
                            })()}
                          </div>
                        </div>

                        <div>
                          <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Billing mode</label>
                          <div className="flex gap-1 text-[11px]">
                            {([
                              { v: 'fixed',              l: 'Fixed amount' },
                              { v: 'percent_of_parent',  l: '% of parent' },
                              { v: 'parameter_driven',   l: 'Parameter-driven' },
                            ] as const).map(opt => (
                              <button
                                key={opt.v}
                                type="button"
                                onClick={() => setForm(p => ({ ...p, billing_mode: opt.v, billing_override: false }))}
                                className={`flex-1 px-2 py-1.5 rounded-md border transition-colors ${
                                  form.billing_mode === opt.v
                                    ? 'bg-violet-500/15 border-violet-500/40 text-violet-700 dark:text-violet-200'
                                    : 'border-foreground/15 text-muted-foreground hover:text-foreground hover:border-foreground/20'
                                }`}
                              >
                                {opt.l}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* percent_of_parent: simple % input (concepts / sizes) */}
                        {form.billing_mode === 'percent_of_parent' && (
                          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                            <div>
                              <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Percent of parent</label>
                              <div className="relative">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={form.billing_percent}
                                  onChange={e => setForm(p => ({ ...p, billing_percent: e.target.value, billing_override: false }))}
                                  className={inputCls}
                                  placeholder={form.variant_type === 'size' ? '50' : '100'}
                                />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                              </div>
                            </div>
                            <div className="text-[11px] text-muted-foreground pb-2">
                              of {parentTask?.billing_amount_inr ? `₹${parentTask.billing_amount_inr.toLocaleString('en-IN')}` : '—'}
                            </div>
                          </div>
                        )}

                        {/* parameter_driven: grouped checklist with master/sub exclusivity */}
                        {form.billing_mode === 'parameter_driven' && (
                          <div className="space-y-3">
                            {groups.length === 0 ? (
                              <p className="text-[11px] text-muted-foreground bg-foreground/[0.02] border border-foreground/15 rounded-lg px-3 py-2">
                                No contribution groups exist yet. Set them up in <span className="text-violet-700 dark:text-violet-300">Settings → Groups &amp; Params</span> first.
                              </p>
                            ) : (
                              <>
                                {groups.map(g => {
                                  const groupParams = parameters
                                    .filter(p => p.group_id === g.id)
                                    .sort((a, b) => {
                                      if (!!a.is_master !== !!b.is_master) return a.is_master ? -1 : 1
                                      return a.display_order - b.display_order
                                    })
                                  if (groupParams.length === 0) return null
                                  const masterParam = groupParams.find(p => p.is_master)
                                  const subParams   = groupParams.filter(p => !p.is_master)
                                  const masterSelected = masterParam ? variantParamIds.has(masterParam.id) : false
                                  const anySubSelected = subParams.some(p => variantParamIds.has(p.id))
                                  const internalShare  = computeGroupShare(g.id)
                                  const groupPct       = variantGroupPortion(g.id) * 100
                                  const groupContrib   = variantGroupPortion(g.id) * internalShare * 100

                                  // Helpers for master/sub exclusivity
                                  const checkMaster = () => {
                                    if (!masterParam) return
                                    setVariantParamIds(prev => {
                                      const next = new Set(prev)
                                      // Toggle master; if turning ON, drop all subs in this group
                                      if (next.has(masterParam.id)) {
                                        next.delete(masterParam.id)
                                      } else {
                                        subParams.forEach(p => next.delete(p.id))
                                        next.add(masterParam.id)
                                        setVariantParamValues(vals => ({
                                          ...vals,
                                          [masterParam.id]: vals[masterParam.id] ?? (masterParam.input_type === 'percentage' ? '100' : '1'),
                                        }))
                                      }
                                      return next
                                    })
                                    if (form.billing_override) setForm(f => ({ ...f, billing_override: false }))
                                  }
                                  const toggleSub = (p: typeof parameters[number]) => {
                                    setVariantParamIds(prev => {
                                      const next = new Set(prev)
                                      // Selecting a sub auto-drops the master in this group
                                      if (masterParam) next.delete(masterParam.id)
                                      if (next.has(p.id)) {
                                        next.delete(p.id)
                                      } else {
                                        next.add(p.id)
                                        setVariantParamValues(vals => ({
                                          ...vals,
                                          [p.id]: vals[p.id] ?? (p.input_type === 'percentage' ? '100' : '1'),
                                        }))
                                      }
                                      return next
                                    })
                                    if (form.billing_override) setForm(f => ({ ...f, billing_override: false }))
                                  }

                                  return (
                                    <div key={g.id} className="bg-foreground/[0.02] border border-foreground/15 rounded-lg overflow-hidden">
                                      {/* Group header */}
                                      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-foreground/[0.03] border-b border-foreground/[0.05]">
                                        <span className="text-[11px] font-semibold text-foreground">{g.name}</span>
                                        <span className="text-[9px] font-mono text-blue-700 dark:text-blue-300 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0.5">{groupPct.toFixed(2).replace(/\.?0+$/, '')}% of task</span>
                                        <span className="ml-auto text-[10px] font-mono text-violet-700 dark:text-violet-300/80">
                                          → {groupContrib.toFixed(2).replace(/\.?0+$/, '')}% of parent
                                        </span>
                                      </div>

                                      {/* Master parameter */}
                                      {masterParam && (() => {
                                        const isPercent = masterParam.input_type === 'percentage'
                                        const rawValue  = variantParamValues[masterParam.id] ?? ''
                                        const effective = masterSelected ? Math.min(1, paramRawShare(masterParam.id)) * 100 : 0
                                        return (
                                          <div className={`px-2.5 py-1.5 ${anySubSelected ? 'opacity-40' : ''}`}>
                                            <div className="flex items-center gap-2.5">
                                              <input
                                                type="checkbox"
                                                checked={masterSelected}
                                                disabled={anySubSelected}
                                                onChange={checkMaster}
                                                className="accent-violet-500 w-3.5 h-3.5"
                                              />
                                              <span className="flex-1 text-xs">
                                                {masterParam.name}
                                                <span className="ml-1.5 text-[9px] uppercase tracking-wider text-amber-700 dark:text-amber-300/80">master</span>
                                              </span>
                                              <span className="text-[10px] font-mono text-violet-700 dark:text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded px-1.5 py-0.5">
                                                {(masterParam.weight * 100).toFixed(2).replace(/\.?0+$/, '')}%{isPercent ? ' max' : '/each'}
                                              </span>
                                            </div>
                                            {masterSelected && !anySubSelected && (
                                              <div className="flex items-center gap-2 mt-1.5 ml-6">
                                                <label className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                                                  {isPercent ? '% done' : 'Count'}
                                                </label>
                                                <input
                                                  type="number"
                                                  min="0"
                                                  step="1"
                                                  value={rawValue}
                                                  onChange={e => {
                                                    setVariantParamValues(vals => ({ ...vals, [masterParam.id]: e.target.value }))
                                                    if (form.billing_override) setForm(f => ({ ...f, billing_override: false }))
                                                  }}
                                                  placeholder={isPercent ? '100' : '1'}
                                                  className="w-20 bg-secondary border border-border rounded px-2 py-0.5 text-xs focus:outline-none focus:border-violet-500/50"
                                                />
                                                <span className="text-[10px] text-muted-foreground/60">{isPercent ? '%' : 'units'}</span>
                                                <span className="text-[10px] font-mono text-violet-700 dark:text-violet-300/80 ml-auto">
                                                  → {effective.toFixed(2).replace(/\.?0+$/, '')}% of group
                                                </span>
                                              </div>
                                            )}
                                          </div>
                                        )
                                      })()}

                                      {/* Sub-parameters — collapsible "Detailed Edit" section */}
                                      {subParams.length > 0 && (
                                        <details className="border-t border-foreground/[0.04]" open={anySubSelected}>
                                          <summary className={`cursor-pointer select-none px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground flex items-center gap-1.5 ${masterSelected ? 'opacity-40' : ''}`}>
                                            <span>Show sub-parameters ({subParams.length})</span>
                                            {anySubSelected && <span className="text-[9px] text-violet-700 dark:text-violet-300/80 normal-case tracking-normal">· {subParams.filter(p => variantParamIds.has(p.id)).length} active</span>}
                                          </summary>
                                          <div className={`divide-y divide-white/[0.04] ${masterSelected ? 'opacity-40' : ''}`}>
                                            {subParams.map(p => {
                                              const checked = variantParamIds.has(p.id)
                                              const isPercent = p.input_type === 'percentage'
                                              const rawValue = variantParamValues[p.id] ?? ''
                                              const effective = checked ? paramRawShare(p.id) * 100 : 0
                                              const linked = serviceLinkedParamIds.has(p.id)
                                              return (
                                                <div key={p.id} className="px-2.5 py-1.5">
                                                  <div className="flex items-center gap-2.5">
                                                    <input
                                                      type="checkbox"
                                                      checked={checked}
                                                      disabled={masterSelected}
                                                      onChange={() => toggleSub(p)}
                                                      className="accent-violet-500 w-3.5 h-3.5"
                                                    />
                                                    <span className={`flex-1 text-xs ${linked ? '' : 'text-muted-foreground/70'}`}>{p.name}</span>
                                                    {linked && (
                                                      <span className="text-[9px] uppercase tracking-wider text-blue-700 dark:text-blue-300/80 bg-blue-500/10 border border-blue-500/20 rounded px-1 py-0.5">
                                                        for this service
                                                      </span>
                                                    )}
                                                    <span className="text-[10px] font-mono text-violet-700 dark:text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded px-1.5 py-0.5">
                                                      {(p.weight * 100).toFixed(2).replace(/\.?0+$/, '')}%{isPercent ? ' max' : '/each'}
                                                    </span>
                                                  </div>
                                                  {checked && (
                                                    <div className="flex items-center gap-2 mt-1.5 ml-6">
                                                      <label className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                                                        {isPercent ? '% done' : 'Count'}
                                                      </label>
                                                      <input
                                                        type="number"
                                                        min="0"
                                                        step="1"
                                                        value={rawValue}
                                                        onChange={e => {
                                                          setVariantParamValues(vals => ({ ...vals, [p.id]: e.target.value }))
                                                          if (form.billing_override) setForm(f => ({ ...f, billing_override: false }))
                                                        }}
                                                        placeholder={isPercent ? '100' : '1'}
                                                        className="w-20 bg-secondary border border-border rounded px-2 py-0.5 text-xs focus:outline-none focus:border-violet-500/50"
                                                      />
                                                      <span className="text-[10px] text-muted-foreground/60">{isPercent ? '%' : 'units'}</span>
                                                      <span className="text-[10px] font-mono text-violet-700 dark:text-violet-300/80 ml-auto">
                                                        → {effective.toFixed(2).replace(/\.?0+$/, '')}% of group
                                                      </span>
                                                    </div>
                                                  )}
                                                </div>
                                              )
                                            })}
                                          </div>
                                        </details>
                                      )}
                                    </div>
                                  )
                                })}

                                {/* Total readout */}
                                {variantParamIds.size > 0 && parentTask?.billing_amount_inr != null && (() => {
                                  const totalPct = parseFloat(form.billing_percent || '0')
                                  return (
                                    <div className="bg-violet-500/[0.08] border border-violet-500/30 rounded-lg px-2.5 py-2 text-violet-100">
                                      <div className="text-[11px] font-mono">
                                        ₹{parentTask.billing_amount_inr.toLocaleString('en-IN')} × {totalPct}% = <span className="font-bold">₹{Math.round(parentTask.billing_amount_inr * totalPct / 100).toLocaleString('en-IN')}</span> {pricingType === 'fixed_per_creative' ? '/ creative' : pricingType === 'hourly' ? '/ hr' : ''}
                                      </div>
                                      <div className="text-[10px] text-violet-700 dark:text-violet-200/70 mt-0.5">
                                        Group-normalized · cannot exceed 100% of parent
                                      </div>
                                    </div>
                                  )
                                })()}
                              </>
                            )}
                          </div>
                        )}

                        {form.billing_mode === 'fixed' && (
                          <div>
                            <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Fixed amount</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={form.manual_billing_amount}
                              onChange={e => setForm(p => ({ ...p, manual_billing_amount: e.target.value, billing_override: true }))}
                              className={inputCls}
                              placeholder="0"
                            />
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-1">
                          <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!form.is_billable}
                              onChange={e => setForm(p => ({ ...p, is_billable: !e.target.checked }))}
                              className="accent-violet-500"
                            />
                            Internal only — don&apos;t bill the client
                          </label>
                          <div className="text-[11px] text-muted-foreground">
                            Computed: <span className="text-foreground font-semibold">
                              {unitCurrency} {computedAmount.toLocaleString('en-IN')}
                            </span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </details>
              </div>
              )}

              {/* Task Date */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Task Date</label>
                <input type="date" value={form.task_date} onChange={e => setForm(p => ({ ...p, task_date: e.target.value }))} className={inputCls} />
                <div className="flex gap-1.5 mt-1.5">
                  {[
                    { label: 'Today',     date: todayISO() },
                    { label: 'Yesterday', date: daysFromTodayISO(-1) },
                  ].map(q => (
                    <button key={q.label} type="button" onClick={() => setForm(p => ({ ...p, task_date: q.date }))}
                      className={`px-2.5 py-1 text-[10px] rounded-lg border transition-colors ${form.task_date === q.date ? 'bg-violet-500/20 border-violet-500/40 text-violet-700 dark:text-violet-300' : 'border-foreground/15 text-muted-foreground hover:border-foreground/20'}`}>
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Financial section — ONE shared component, identical to the
                  Edit Task modal. Pricing card and quantity inputs all live
                  in task-billing-section.tsx. */}
              <TaskBillingSection
                services={services}
                clientPricings={clientPricings}
                clientId={form.client_id}
                serviceId={form.service_id}
                quantity={form.quantity}
                hours={form.hours}
                spend={form.spend}
                onChange={patch => setForm(p => ({ ...p, ...patch }))}
                taskDate={form.task_date}
                packageId={form.package_id}
                onPackageChange={pid => setForm(p => ({ ...p, package_id: pid }))}
                showFinancials={showBilling}
                amount={computedAmount}
                unitPriceDisplay={displayUnitPrice}
                      footer={unitPrice === 0 && (
                        <div className="space-y-2 pt-1 border-t border-amber-500/20">
                          <p className="text-xs text-amber-400 font-medium">⚠ No price set — set it now:</p>
                          {!quickSet ? (
                            <div className="flex gap-2">
                              <button type="button" onClick={() => setQuickSet({ mode: 'default', price: '', currency: 'INR' })}
                                className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 text-foreground border border-border transition-colors">
                                Set default price for this service
                              </button>
                              {form.client_id && form.client_id !== INTERNAL_CLIENT && (
                                <button type="button" onClick={() => setQuickSet({ mode: 'client', price: '', currency: unitCurrency })}
                                  className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 transition-colors">
                                  Set price for {clients.find(c => c.id === form.client_id)?.name?.split(' ')[0]}
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-xs text-muted-foreground">
                                {quickSet.mode === 'default' ? `Default price for "${selectedService?.name}"` : `Price for ${clients.find(c => c.id === form.client_id)?.name} — ${selectedService?.name}`}
                              </p>
                              <div className="flex gap-2 items-center">
                                <input
                                  type="number" min="0" step="0.01" autoFocus
                                  value={quickSet.price}
                                  onChange={e => setQuickSet(q => q ? { ...q, price: e.target.value } : q)}
                                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveQuickPrice() } if (e.key === 'Escape') setQuickSet(null) }}
                                  className="flex-1 bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                  placeholder="0.00"
                                />
                                <select value={quickSet.currency} onChange={e => setQuickSet(q => q ? { ...q, currency: e.target.value as Currency } : q)}
                                  className="bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none">
                                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <button type="button" onClick={saveQuickPrice} disabled={quickSaving || !quickSet.price}
                                  className="px-3 py-1.5 rounded-lg gradient-bg text-white text-xs font-medium disabled:opacity-50 whitespace-nowrap">
                                  {quickSaving ? '…' : 'Save'}
                                </button>
                                <button type="button" onClick={() => setQuickSet(null)} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">✕</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
              />

              {/* Pricing summary card. */}
              {showBilling && selectedService && (
                <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl p-3 flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{selectedService.name}</span>
                    {clientPrice && <span className="ml-1 text-violet-400">· Client rate</span>}
                  </div>
                  <div className="text-right">
                    <div className="text-base font-bold">{formatCurrency(computedAmount, unitCurrency)}</div>
                    <div className="text-[10px] text-muted-foreground">{pricingType.replace(/_/g, ' ')}</div>
                  </div>
                </div>
              )}


              {/* Description (more often filled than status — placed before it) */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
                <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={3} className={inputCls + ' resize-none'} placeholder="What needs to be done? (optional details, revision notes…)" />
              </div>

              {/* Status (defaults to pending, often unchanged on create) */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Status</label>
                <AppSelect value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                  {manualStatusOptions(form.status).map(s => <option key={s} value={s}>{getStatusLabel(s)}</option>)}
                </AppSelect>
              </div>

              {/* Recurring Task — collapsed by default, expands when checked */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={form.is_recurring}
                    onChange={e => setForm(p => ({ ...p, is_recurring: e.target.checked }))}
                    className="w-4 h-4 accent-violet-500"
                  />
                  <RefreshCw className="w-3.5 h-3.5" /> This is a recurring task
                </label>
                {form.is_recurring && (
                  <div className="mt-2 pl-6 space-y-2 border-l-2 border-violet-500/30">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Repeat every</label>
                        <AppSelect
                          value={form.recurring_interval}
                          onChange={e => setForm(p => ({ ...p, recurring_interval: e.target.value }))}
                        >
                          {RECURRING_INTERVALS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </AppSelect>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">End date <span className="text-muted-foreground/60">(optional)</span></label>
                        <input
                          type="date"
                          value={form.recurring_end_date}
                          onChange={e => setForm(p => ({ ...p, recurring_end_date: e.target.value }))}
                          min={form.task_date}
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {form.recurring_end_date
                        ? 'Instances will be created from task date up to the end date (max 52).'
                        : 'No end date — instances will be created up to 6 months out (max 52).'}
                    </p>
                  </div>
                )}
              </div>

              {/* Sticky action footer — always reachable while scrolling.
                  -mx-5/-mx-6 + px-5/px-6 lets the bar span the full width of
                  the scroll container and sit on top of a backdrop-blur surface. */}
              {addError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 -mb-1">{addError}</p>
              )}
              {/* pr-20 on mobile keeps the last button clear of the floating chat
                  launcher (fixed bottom-right, ~4.25rem corner); safe-area inset
                  lifts the buttons above the home indicator on notched phones. */}
              <div className="sticky bottom-0 -mx-5 sm:-mx-6 pl-5 pr-20 sm:px-6 -mb-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 border-t border-border flex gap-3">
                <Button type="button" variant="outline" onClick={() => { setShowForm(false); setAddError(null) }} className="flex-1" size="lg">Cancel</Button>
                <Button type="submit" disabled={!selectedService} loading={saving} className="flex-1 bg-gradient-to-r from-primary to-violet-600 hover:from-primary/90 hover:to-violet-600/90 text-primary-foreground" size="lg">
                  Add Task {previewTaskNumber != null && <span className="opacity-70 ml-1">#{previewTaskNumber}</span>}
                </Button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {editClientId && (
        <ClientEditModal
          clientId={editClientId}
          serviceId={editClientServiceId ?? undefined}
          onClose={() => { setEditClientId(null); setEditClientServiceId(null) }}
        />
      )}

      {/* Inline quick-create: Client */}
      {quickCreate?.kind === 'client' && (
        <QuickCreateClientModal
          initialName={quickCreate.query}
          canSeePricing={canSeePricing}
          onClose={() => setQuickCreate(null)}
          onCreated={(client, pricingPending) => {
            setClientList(prev => [{ id: client.id, name: client.name, code: client.code }, ...prev])
            handleClientChange(client.id)
            setQuickCreate(null)
            success(`Client "${client.name}" added`, pricingPending ? 'Flagged for pricing by an admin' : undefined)
          }}
        />
      )}

      {/* Inline quick-create: Service */}
      {quickCreate?.kind === 'service' && (
        <QuickCreateServiceModal
          initialName={quickCreate.query}
          canSeePricing={canSeePricing}
          onClose={() => setQuickCreate(null)}
          onCreated={(service, pricingPending) => {
            setServices(prev => [...prev, service])
            handleServiceChange(service.id)
            setQuickCreate(null)
            success(`Service "${service.name}" added`, pricingPending ? 'Flagged for pricing by an admin' : undefined)
          }}
        />
      )}

      {/* Request brief — the client's original request behind a promoted task */}
      {requestBrief && (
        <ModalOverlay onClose={() => setRequestBrief(null)}>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-xl shadow-2xl max-h-[88dvh] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0 gap-3">
              <div className="min-w-0">
                {requestBrief.data ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-mono text-muted-foreground">REQ-{String(requestBrief.data.ref_no ?? 0).padStart(4, '0')}</span>
                      {requestBrief.data.priority && requestBrief.data.priority !== 'normal' && (
                        <span className="text-[11px] font-medium text-amber-400">⚑ {requestBrief.data.priority}</span>
                      )}
                    </div>
                    <h2 className="font-bold text-base mt-1 leading-snug">{requestBrief.data.title}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {requestBrief.data.client?.name || requestBrief.data.agency?.name || 'Guest'}
                      {requestBrief.data.due_date ? ` · due ${new Date(requestBrief.data.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}
                    </p>
                  </>
                ) : (
                  <h2 className="font-bold text-base">Request brief</h2>
                )}
              </div>
              <button onClick={() => setRequestBrief(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground shrink-0"><X className="w-4 h-4" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-5 space-y-4 text-sm">
              {requestBrief.loading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading brief…</p>}
              {requestBrief.error && <p className="text-xs text-red-400">{requestBrief.error}</p>}
              {requestBrief.data && (
                <>
                  {requestBrief.data.description && (
                    <div><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Details</p><p className="whitespace-pre-wrap text-foreground/90">{requestBrief.data.description}</p></div>
                  )}
                  {requestBrief.data.design_plan && (
                    <div><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Design plan</p><p className="whitespace-pre-wrap text-foreground/90">{requestBrief.data.design_plan}</p></div>
                  )}
                  {requestBrief.data.remarks && (
                    <div><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Requester remarks</p><p className="whitespace-pre-wrap text-foreground/90">{requestBrief.data.remarks}</p></div>
                  )}
                  {(requestBrief.data.drive_folder_link || requestBrief.data.content_link || requestBrief.data.reference_link || requestBrief.data.deliverables_link || (requestBrief.data.extra_links || []).length > 0) && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Links</p>
                      <div className="space-y-1">
                        {requestBrief.data.drive_folder_link && <a href={requestBrief.data.drive_folder_link} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline">Drive folder</a>}
                        {requestBrief.data.content_link && <a href={requestBrief.data.content_link} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline">Content</a>}
                        {requestBrief.data.reference_link && <a href={requestBrief.data.reference_link} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline">Reference</a>}
                        {requestBrief.data.deliverables_link && <a href={requestBrief.data.deliverables_link} target="_blank" rel="noreferrer" className="block text-xs text-emerald-400 hover:underline">Deliverables</a>}
                        {(requestBrief.data.extra_links || []).map((l: any, i: number) => (
                          <a key={i} href={l.url} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline">{l.label || l.url}</a>
                        ))}
                      </div>
                    </div>
                  )}
                  {!requestBrief.data.description && !requestBrief.data.design_plan && !requestBrief.data.remarks && (
                    <p className="text-xs text-muted-foreground/60">No extra details on this request.</p>
                  )}
                  {can('requests.view') && (
                    <a href={`/dashboard/requests?focus=${requestBrief.data.id}`}
                      className="inline-flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-700 dark:text-violet-300 transition-colors">
                      Open in Requests inbox →
                    </a>
                  )}
                </>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
