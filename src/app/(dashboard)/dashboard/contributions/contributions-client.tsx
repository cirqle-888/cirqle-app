'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { calculateCommission } from '@/lib/calculations/commission'
import { taskCode, taskCodeMatches } from '@/lib/utils/task-code'
import { usePrivacy } from '@/contexts/privacy-context'
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { DateFilter, matchesDateFilter } from '@/components/ui/date-filter'
import type { DateFilterValue } from '@/components/ui/date-filter'
import {
  ChevronLeft, ChevronRight, Minus, Plus, X, Check,
  Search, Filter, PlusCircle, Eye, EyeOff, Clock, CheckCircle2, AlertCircle,
  UserCheck, Users, CalendarDays, Lock, Edit2, ChevronDown, Trash2, Copy, ExternalLink,
  List, LayoutGrid, MoreVertical, CheckCircle,
} from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import AppSelect from '@/components/ui/app-select'
import { useRole } from '@/contexts/role-context'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { TaskEditModal } from '@/components/ui/task-edit-modal'
import { PageShell, PageContent, StickyToolbar, PageChrome } from '@/components/layout/page-shell'

interface Score { task_id: string; employee_id: string; earnings_inr: number; score_percentage: number }
interface Assignment { task_id: string; employee_id: string }

interface Props {
  tasks: any[]
  employees: any[]
  groups: any[]
  parameters: any[]
  tools: any[]
  parameterServices: { parameter_id: string; service_id: string }[]
  toolServices: { tool_id: string; service_id: string }[]
  groupServices: { group_id: string; service_id: string }[]
  scores: Score[]
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  taskAssignments: Assignment[]
  contributorRecords: { task_id: string; employee_id: string; value: number }[]
  taskToolRecords: { task_id: string; tool_id: string }[]
  pricingMatrix: { client_id: string; service_id: string; commission_percentage: number | null; price: number | null; currency: string | null }[]
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────
function fmt(date: string) {
  try {
    return new Date(date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return date }
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
  scores, clients, services, taskAssignments: taskAssignmentsFromDB,
  contributorRecords, taskToolRecords, pricingMatrix,
}: Props) {

  // ── Toast ───────────────────────────────────────────
  const toast = useToast()

  // ── View state ──────────────────────────────────────
  const [view, setView] = useState<'list' | 'entry'>('list')
  const [selectedTask, setSelectedTask] = useState<any>(null)

  // ── List screen view mode (list / board / calendar) ──
  const [listViewMode, setListViewMode] = useState<'list' | 'board' | 'calendar'>('list')
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
    task_date: new Date().toISOString().split('T')[0],
    billing_amount_inr: '',
    status: 'pending',
  })
  const [addingTask, setAddingTask] = useState(false)
  const [addTaskError, setAddTaskError] = useState('')
  const [titleSearch, setTitleSearch] = useState('')         // for the combobox
  const [showTitleDropdown, setShowTitleDropdown] = useState(false)
  const [duplicatingTaskId, setDuplicatingTaskId] = useState<string | null>(null)

  // ── Filters ─────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterService, setFilterService] = useState('')
  const [filterEmployee, setFilterEmployee] = useState('')
  const [filterEmployeeMode, setFilterEmployeeMode] = useState<'worked' | 'solo' | 'any'>('worked')
  const [filterDate, setFilterDate] = useState<DateFilterValue>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'done' | 'missing'>('all')

  const router = useRouter()
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
  const [showCommOverride, setShowCommOverride] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expandedEmployees, setExpandedEmployees] = useState<Set<string>>(new Set())
  const [activeGroups, setActiveGroups] = useState<Set<string>>(new Set())
  const [activeSubParams, setActiveSubParams] = useState<Set<string>>(new Set())

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

  // ── Silent auto-recalculate missing scores on mount ──────────────────────
  // Runs once when the page loads. If any tasks have raw contributions saved
  // but no contribution_scores (e.g. from old saves), it calculates and saves
  // scores automatically in the background — no button, no manual step needed.
  useEffect(() => {
    if (autoRecalcRan.current) return
    autoRecalcRan.current = true

    // Which tasks have raw contributions but no scores yet?
    const taskIdsWithContribs = new Set(contributorRecords.map(c => c.task_id))
    const scoredTaskIds = new Set(scores.map(s => s.task_id))
    const tasksNeedingScores = initialTasks.filter(
      (t: any) => taskIdsWithContribs.has(t.id) && !scoredTaskIds.has(t.id)
    )
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

        try {
          const result = calculateCommission({
            taskId: task.id,
            billingAmountINR: task.billing_amount_inr || 0,
            serviceCommissionPct: commPct,
            employees, groups: taskGroups,
            parameters: taskParams,
            toolsUsed: taskToolsForCalc,
            contributions: contribArray,
          })
          if (result.employeeEarnings.length > 0) {
            const scoreInserts = result.employeeEarnings.map((e: any) => ({
              task_id: task.id, employee_id: e.employeeId,
              score_percentage: e.scorePercentage, earnings_inr: e.earnings,
            }))
            await supabase.from('contribution_scores').delete().eq('task_id', task.id)
            await supabase.from('contribution_scores').insert(scoreInserts)
            savedCount++
          }
        } catch { /* skip tasks that fail calculation */ }
      }

      // Refresh server data so counts & payroll reflect the new scores
      if (savedCount > 0) router.refresh()
    }

    doSilentRecalc()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived data ─────────────────────────────────────
  const groupServices = useMemo<{ group_id: string; service_id: string }[]>(() => {
    if (groupServicesFromDB.length > 0) return groupServicesFromDB
    try { return JSON.parse(localStorage.getItem('cirqle_group_services') || '[]') } catch { return [] }
  }, [groupServicesFromDB])

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
      if (!m[s.task_id]) m[s.task_id] = new Set()
      m[s.task_id].add(s.employee_id)
    })
    contributorRecords.forEach(c => {
      if (!m[c.task_id]) m[c.task_id] = new Set()
      m[c.task_id].add(c.employee_id)
    })
    return m
  }, [scores, contributorRecords])

  // Tools lookup: taskId → tool_id[]
  const taskToolsMap = useMemo(() => {
    const m: Record<string, string[]> = {}
    taskToolRecords.forEach(r => {
      if (!m[r.task_id]) m[r.task_id] = []
      if (!m[r.task_id].includes(r.tool_id)) m[r.task_id].push(r.tool_id)
    })
    return m
  }, [taskToolRecords])

  // Assignment lookup: taskId → Set<employeeId>
  const taskAssignmentMap = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    assignments.forEach(a => {
      if (!m[a.task_id]) m[a.task_id] = new Set()
      m[a.task_id].add(a.employee_id)
    })
    return m
  }, [assignments])

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
      const q = search.toLowerCase()
      if (q && !t.title.toLowerCase().includes(q) &&
          !(t.client?.name || '').toLowerCase().includes(q) &&
          !(t.service?.name || '').toLowerCase().includes(q) &&
          !taskCodeMatches(t, search)) return false
      if (filterClient && t.client?.id !== filterClient) return false
      if (filterService && t.service_id !== filterService) return false
      if (!matchesDateFilter(t.task_date, filterDate)) return false
      const contributed = taskScoreMap[t.id]
      const doneCount = contributed ? contributed.size : 0
      if (filterEmployee) {
        const hasContributed = contributed?.has(filterEmployee)
        if (filterEmployeeMode === 'solo') {
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
  }, [localTasks, search, filterClient, filterService, filterDate, filterEmployee, filterEmployeeMode, statusFilter, taskScoreMap, taskAssignmentMap, employees])

  const canSeeFinancials = role === 'super_admin' || role === 'accounts'

  // For employee/view_only role, only show their assigned tasks
  const myVisibleTasks = useMemo(() => {
    if ((role === 'employee' || role === 'view_only') && currentEmployee) {
      const myIds = new Set(assignments.filter(a => a.employee_id === currentEmployee.id).map(a => a.task_id))
      return filteredTasks.filter((t: any) => myIds.has(t.id))
    }
    return filteredTasks
  }, [role, currentEmployee, filteredTasks, assignments])

  const tasksByDate = useMemo(() => {
    const map: Record<string, any[]> = {}
    myVisibleTasks.forEach(t => {
      const d = t.task_date || 'Unknown'
      if (!map[d]) map[d] = []
      map[d].push(t)
    })
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a))
  }, [myVisibleTasks])

  // ── Entry-view derived data ───────────────────────────
  const filteredGroups = useMemo(() => {
    if (!selectedTask) return groups
    const linked = groupServices.filter(gs => gs.service_id === selectedTask.service_id).map(gs => gs.group_id)
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
    try {
      return calculateCommission({
        taskId: selectedTask.id,
        billingAmountINR: selectedTask.billing_amount_inr || 0,
        serviceCommissionPct: serviceCommPct,
        employees, groups,
        parameters: filteredParams,
        toolsUsed: filteredTools.map(t => ({ tool: t, used: toolsUsed[t.id] || false })),
        contributions: contribArray,
      })
    } catch { return null }
  }, [contributions, toolsUsed, serviceCommPct, selectedTask, employees, groups, filteredParams, filteredTools])

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

  function toggleSubParam(empId: string, paramId: string, count: number) {
    const key = `${empId}:${paramId}`
    if (count > 0) {
      setContrib(paramId, empId, 0)
      setActiveSubParams(prev => { const n = new Set(prev); n.delete(key); return n })
    } else {
      setActiveSubParams(prev => { const n = new Set(prev); n.add(key); return n })
    }
  }

  async function openTask(task: any) {
    // Reset everything first, show entry view immediately
    setSelectedTask(task)
    setContributions({}); setToolsUsed({})
    setExpandedEmployees(new Set()); setActiveGroups(new Set()); setActiveSubParams(new Set())
    setCommOverrideReason(''); setShowCommOverride(false)

    // Auto-load commission rate from pricing matrix
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

    // Fetch any previously saved contributions + tools for this task
    const [contribRes, toolRes] = await Promise.all([
      supabase.from('contributions').select('parameter_id, employee_id, value').eq('task_id', task.id),
      supabase.from('task_tools').select('tool_id').eq('task_id', task.id),
    ])

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
        newExpandedEmps.add(employee_id)
      })

      setContributions(contribs)
      setActiveGroups(newActiveGroups)
      setActiveSubParams(newActiveSubParams)
      setExpandedEmployees(newExpandedEmps)
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
          if (empIds.size) setExpandedEmployees(empIds)
        }
      } catch { /* ignore */ }
    }
  }

  async function handleSave() {
    if (!selectedTask) return
    setSaving(true)
    const contribInserts = Object.entries(contributions).flatMap(([paramId, empMap]) =>
      Object.entries(empMap).filter(([, v]) => v > 0)
        .map(([empId, value]) => ({ task_id: selectedTask.id, employee_id: empId, parameter_id: paramId, value }))
    )
    const toolInserts = filteredTools.filter(t => toolsUsed[t.id]).map(t => ({ task_id: selectedTask.id, tool_id: t.id }))
    await Promise.all([
      supabase.from('contributions').delete().eq('task_id', selectedTask.id),
      supabase.from('task_tools').delete().eq('task_id', selectedTask.id),
    ])
    // Always save scores when calculatedResult is available — regardless of showFinancials display toggle
    if (calculatedResult) {
      const scoreInserts = calculatedResult.employeeEarnings.map((e: any) => ({
        task_id: selectedTask.id, employee_id: e.employeeId,
        score_percentage: e.scorePercentage, earnings_inr: e.earnings,
      }))
      await supabase.from('contribution_scores').delete().eq('task_id', selectedTask.id)
      if (scoreInserts.length) await supabase.from('contribution_scores').insert(scoreInserts)
      // Only advance status to 'done' if task is still pending/in_progress — never downgrade invoiced/paid tasks
      if (['pending', 'in_progress'].includes(selectedTask.status)) {
        await supabase.from('tasks').update({ status: 'done' }).eq('id', selectedTask.id)
      }
    }
    if (contribInserts.length) await supabase.from('contributions').insert(contribInserts)
    if (toolInserts.length) await supabase.from('task_tools').insert(toolInserts)
    setSaving(false)

    // Auto-dismiss toast showing who was paid what
    if (calculatedResult && calculatedResult.employeeEarnings.length > 0) {
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

  async function bulkDeleteTasks() {
    const ids = [...selectedTasks]
    if (ids.length === 0) return
    if (!confirm(`Move ${ids.length} task${ids.length !== 1 ? 's' : ''} to trash?`)) return
    await Promise.all(ids.map(id =>
      supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    ))
    setLocalTasks(prev => prev.filter(t => !selectedTasks.has(t.id)))
    setSelectedTasks(new Set())
    setBulkMode(false)
    toast.success(`${ids.length} task${ids.length !== 1 ? 's' : ''} moved to trash`)
    router.refresh()
  }

  // ── Title suggestions (unique titles from existing tasks) ──
  const titleSuggestions = useMemo(() => {
    const seen = new Set<string>()
    const q = titleSearch.toLowerCase()
    return localTasks
      .map(t => t.title)
      .filter((t): t is string => !!t && !seen.has(t) && !!seen.add(t))
      .filter(t => q ? t.toLowerCase().includes(q) : true)
      .slice(0, 8)
  }, [localTasks, titleSearch])

  // ── Duplicate task ──────────────────────────────────────
  async function handleDuplicateTask(task: any) {
    setDuplicatingTaskId(task.id)
    const payload: any = {
      title: task.title,
      status: 'pending',
      task_date: new Date().toISOString().split('T')[0],
    }
    if (task.client?.id) payload.client_id = task.client.id
    if (task.service_id) payload.service_id = task.service_id
    if (task.billing_amount_inr) payload.billing_amount_inr = task.billing_amount_inr

    const { data, error } = await supabase
      .from('tasks')
      .insert(payload)
      .select('id, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services(id, name)')
      .single()

    if (!error && data) {
      setLocalTasks(prev => [data, ...prev])
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
      title: addTaskForm.title.trim(),
      status: addTaskForm.status,
      task_date: addTaskForm.task_date || new Date().toISOString().split('T')[0],
    }
    if (addTaskForm.client_id) payload.client_id = addTaskForm.client_id
    if (addTaskForm.service_id) payload.service_id = addTaskForm.service_id
    if (addTaskForm.billing_amount_inr) payload.billing_amount_inr = parseFloat(addTaskForm.billing_amount_inr as string) || 0

    const { data, error } = await supabase
      .from('tasks')
      .insert(payload)
      .select('id, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services(id, name)')
      .single()

    if (error) { setAddTaskError(error.message); setAddingTask(false); return }
    if (data) {
      setLocalTasks(prev => [data, ...prev])
      setShowAddTask(false)
      setAddTaskForm({ title: '', client_id: '', service_id: '', task_date: new Date().toISOString().split('T')[0], billing_amount_inr: '', status: 'pending' })
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
      (filterClient ? 1 : 0) +
      (filterService ? 1 : 0) +
      (filterDate ? 1 : 0) +
      (filterEmployee ? 1 : 0)
    const hasAnyFilter = activeFilterCount > 0 || !!search || statusFilter !== 'all'

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
        <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
        <PageChrome>
          <Header
            title="Contributions"
            subtitle={`${localTasks.length} task${localTasks.length !== 1 ? 's' : ''}`}
            actions={headerActions}
          />

          <StickyToolbar>
          {/* Row 1: [Select] · [Search flex-1] · [List|Board|Calendar] · [⚙ board-only]
              flex-wrap + order-* so Search jumps to top on mobile and gets full width. */}
          <StickyToolbar.Row className="flex-wrap">
            {/* Left group: Select (toggles bulk mode) · All (toggles select/deselect all when active) */}
            <div className="flex items-center gap-1.5 shrink-0 order-2 sm:order-none">
              <button
                onClick={() => { setBulkMode(m => !m); setSelectedTasks(new Set()) }}
                className={`px-3 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 shadow-sm ${
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
                    className={`px-3 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 shadow-sm ${
                      allSelected
                        ? 'bg-violet-500/20 border border-violet-500/40 text-violet-200'
                        : 'bg-secondary border border-border text-foreground hover:bg-secondary/60'
                    }`}
                  >
                    {allSelected ? <Check className="w-3 h-3" /> : <span className="w-3 h-3 rounded-sm border border-current opacity-60" />}
                    All ({myVisibleTasks.length})
                  </button>
                )
              })()}
            </div>

            {/* Search — full-width on mobile (order-1), flex-1 on desktop */}
            <div className="order-1 sm:order-none w-full sm:w-auto flex items-center gap-2 bg-secondary border border-foreground/15 rounded-xl px-3 py-2 sm:flex-1 sm:basis-0 min-w-0">
              <Search size={14} className="text-muted-foreground shrink-0" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search tasks, clients, services, code…"
                className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60" />
              {search && <button onClick={() => setSearch('')} className="shrink-0 cursor-pointer"><X size={12} className="text-muted-foreground" /></button>}
            </div>

            {/* Inline view segment: List · Board · ⚙(board-only) · Calendar */}
            <div ref={boardSettingsRef} className="relative shrink-0 order-3 sm:order-none ml-auto sm:ml-0">
              <div className="flex items-center bg-secondary border border-foreground/15 rounded-xl p-1 gap-0.5">
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
                    {/* Board settings ⚙ — sits immediately after the Board button, only visible when Board is active */}
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
              {/* Group By popover */}
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
          </StickyToolbar.Row>

          {/* Row 2: Filters → divider → Status chips → Clear all */}
          <StickyToolbar.Row className="flex-wrap">
            {/* Date — leads the row, sets the time scope before other filters */}
            <DateFilter value={filterDate} onChange={setFilterDate} />
            {/* Employee */}
            <FilterDropdown
              options={employees.map(emp => ({ value: emp.id, label: dn(emp) }))}
              value={filterEmployee}
              onChange={v => { setFilterEmployee(v); setFilterEmployeeMode('worked') }}
              placeholder="Employee"
              sortKey="employees"
            />
            {/* Employee mode (Worked / Solo / +Assigned) — appears only when employee selected */}
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
              </div>
            )}
            {/* Client */}
            <FilterDropdown
              options={clients.map(c => ({ value: c.id, label: c.name }))}
              value={filterClient}
              onChange={setFilterClient}
              placeholder="Client"
              sortKey="clients"
            />
            {/* Service */}
            <FilterDropdown
              options={services.map(s => ({ value: s.id, label: s.name }))}
              value={filterService}
              onChange={setFilterService}
              placeholder="Service"
              sortKey="services"
            />
            {/* Divider */}
            <span className="w-px h-5 bg-foreground/10 shrink-0" />
            {/* Status chips */}
            {([
              { key: 'all',     label: 'All',     count: localTasks.length },
              { key: 'pending', label: 'Pending', count: pendingCount     },
              { key: 'done',    label: 'Scored',  count: doneCount        },
              { key: 'missing', label: 'Missing', count: missingCount     },
            ] as const).map(({ key, label, count }) => (
              <button key={key} onClick={() => setStatusFilter(key as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  statusFilter === key
                    ? key === 'missing'
                      ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
                      : 'gradient-bg text-white'
                    : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}>
                {label}
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                  statusFilter === key && key === 'missing' ? 'bg-orange-500/30 text-orange-300' :
                  statusFilter === key ? 'bg-foreground/20 text-white' : 'bg-border/50 opacity-60'
                }`}>{count}</span>
                {key === 'missing' && count > 0 && statusFilter !== 'missing' && (
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                )}
              </button>
            ))}
            {/* Clear all */}
            {hasAnyFilter && (
              <button
                onClick={() => {
                  setSearch('')
                  setFilterClient('')
                  setFilterService('')
                  setFilterEmployee('')
                  setFilterEmployeeMode('worked')
                  setFilterDate(null)
                  setStatusFilter('all')
                }}
                className="ml-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-foreground/[0.04] transition-colors flex items-center gap-1 shrink-0"
              >
                <X size={12} /> Clear all
              </button>
            )}
          </StickyToolbar.Row>
        </StickyToolbar>
        </PageChrome>

        <PageContent>

          {/* ── Missing-scores toast (bottom-right) — list view only ── */}
          {missingCount > 0 && listViewMode === 'list' && showMissingBanner && (
            <div className="fixed bottom-6 right-6 z-40 bg-orange-500/20 border border-orange-500/40 rounded-lg px-4 py-3 flex items-center gap-3 max-w-sm shadow-2xl">
              <AlertCircle className="w-4 h-4 text-orange-400 shrink-0" />
              <p className="text-xs text-orange-300 leading-relaxed flex-1">
                <span className="font-semibold">{missingCount} task{missingCount === 1 ? '' : 's'}</span> need scoring.{' '}
                <button onClick={() => setStatusFilter('missing')} className="underline hover:text-orange-200 font-semibold">View</button>
              </p>
              <button onClick={() => setShowMissingBanner(false)} className="shrink-0 text-orange-400 hover:text-orange-300">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── No employees warning ── */}
          {employees.length === 0 && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
              <Users className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-300">No employees found</p>
                <p className="text-xs text-amber-400/70 mt-0.5">
                  Add employees in{' '}
                  <Link href="/dashboard/payroll" className="underline hover:text-amber-300">HR &amp; Payroll</Link>
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
                          className={`bg-card border rounded-xl px-4 py-3.5 hover:border-primary/30 hover:bg-primary/[0.02] transition-all group cursor-pointer select-none ${highlightedTaskId === task.id ? 'border-violet-400 ring-1 ring-violet-400 bg-violet-500/10' : bulkMode && isSelected ? 'border-violet-400/60 bg-violet-500/[0.07]' : 'border-border'}`}>
                          <div className="flex items-start gap-3">
                            {bulkMode && (
                              <div className="pt-1 shrink-0" onClick={e => e.stopPropagation()}>
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
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span
                                  title={`Task code · click to copy ${taskCode(task)}`}
                                  onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(taskCode(task)) }}
                                  className="text-[10px] font-mono font-semibold text-muted-foreground/60 bg-foreground/[0.04] border border-foreground/15 px-1.5 py-0.5 rounded shrink-0 cursor-pointer hover:text-foreground hover:border-foreground/25 transition-colors"
                                >
                                  {taskCode(task)}
                                </span>
                                <p className="font-semibold text-sm">{task.title}</p>
                                <StatusBadge done={doneEmps.length} total={employees.length} />
                              </div>
                              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                                {task.client?.name && <span className="font-medium text-foreground/70">{task.client.name}</span>}
                                {task.client?.name && task.service?.name && <span>·</span>}
                                {task.service?.name && <span>{task.service.name}</span>}
                                {canSeeFinancials && showFinancials && task.billing_amount_inr > 0 && (
                                  <><span>·</span><span className="font-semibold text-foreground">₹{task.billing_amount_inr.toLocaleString('en-IN')}</span></>
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
                                  {employees.map(emp => {
                                    const done = contributed?.has(emp.id)
                                    const assigned = taskAssignmentMap[task.id]?.has(emp.id)
                                    const chipStyle = done
                                      ? 'bg-green-500/10 border-green-500/20 text-green-400'
                                      : assigned
                                        ? 'bg-blue-500/10 border-blue-500/25 text-blue-400'
                                        : 'bg-secondary border-transparent text-muted-foreground/40'
                                    return (
                                      <button key={emp.id} type="button"
                                        onClick={showFinancials && !done ? () => toggleAssignment(task.id, emp.id) : undefined}
                                        title={showFinancials ? (done ? `${dn(emp)} contributed` : assigned ? `Unassign ${dn(emp)}` : `Assign ${dn(emp)}`) : undefined}
                                        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border transition-all ${chipStyle} ${showFinancials && !done ? 'hover:scale-105 cursor-pointer' : 'cursor-default'}`}>
                                        {done ? <Check className="w-2.5 h-2.5" /> : assigned ? <UserCheck className="w-2.5 h-2.5" /> : null}
                                        {dn(emp)}
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

                            <div className="flex items-center gap-1 shrink-0 ml-1" onClick={e => e.stopPropagation()}>
                              {/* Super admin: jump directly to task in Tasks page */}
                              {role === 'super_admin' && (
                                <a
                                  href={`/dashboard/tasks?highlight=${task.id}`}
                                  title={`Open "${task.title}" in Tasks`}
                                  onClick={e => e.stopPropagation()}
                                  className="p-1.5 rounded-md text-muted-foreground/0 group-hover:text-violet-400/50 hover:!text-violet-400 hover:bg-violet-500/10 transition-all">
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                              <button type="button"
                                onClick={() => openEditTask(task)}
                                title="Edit task details"
                                className="p-1.5 rounded-md text-muted-foreground/0 group-hover:text-muted-foreground/40 hover:!text-foreground hover:bg-secondary transition-all">
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button type="button"
                                onClick={() => handleDuplicateTask(task)}
                                title="Duplicate task to today"
                                disabled={duplicatingTaskId === task.id}
                                className="p-1.5 rounded-md text-muted-foreground/0 group-hover:text-muted-foreground/40 hover:!text-foreground hover:bg-secondary transition-all disabled:opacity-40">
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
                    pushTo(eId, title, 'bg-violet-500/15 border-violet-500/20 text-violet-300', emp?.cqid || '•', t)
                  })
                }
              } else if (boardGroupBy === 'client') {
                const key = t.client?.id || 'unclient'
                const title = t.client?.name || 'No Client'
                pushTo(key, title, 'bg-cyan-500/15 border-cyan-500/20 text-cyan-300', '•', t)
              } else if (boardGroupBy === 'service') {
                const key = t.service_id || 'noservice'
                const title = t.service?.name || 'No Service'
                pushTo(key, title, 'bg-emerald-500/15 border-emerald-500/20 text-emerald-300', '•', t)
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
                  if (diff === 0) pushTo('today', 'Today', 'bg-violet-500/15 border-violet-500/20 text-violet-300', '★', t)
                  else if (diff > 0 && diff <= 7) pushTo('week', 'This Week', 'bg-blue-500/15 border-blue-500/20 text-blue-400', '⋯', t)
                  else if (diff > 7) pushTo('later', 'Later', 'bg-secondary border-border text-muted-foreground', '→', t)
                  else pushTo('past', 'Past', 'bg-secondary border-border text-muted-foreground', '·', t)
                } else if (boardDateGranularity === 'daily') {
                  pushTo(t.task_date, fmt(t.task_date), 'bg-cyan-500/15 border-cyan-500/20 text-cyan-300', '·', t)
                } else if (boardDateGranularity === 'weekly') {
                  const d = new Date(t.task_date + 'T00:00:00')
                  const ws = new Date(d); ws.setDate(d.getDate() - d.getDay())
                  const key = ws.toISOString().split('T')[0]
                  pushTo(key, `Week of ${fmt(key)}`, 'bg-blue-500/15 border-blue-500/20 text-blue-300', 'W', t)
                } else if (boardDateGranularity === 'monthly') {
                  const key = t.task_date.substring(0, 7)
                  const title = new Date(t.task_date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' })
                  pushTo(key, title, 'bg-emerald-500/15 border-emerald-500/20 text-emerald-300', 'M', t)
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
              <div className="overflow-auto pb-4 h-[calc(100vh-220px)]">
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
                              className="w-full text-left bg-card border border-border rounded-xl p-3 hover:border-foreground/25 transition-colors cursor-pointer"
                            >
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
                              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                <span className="text-[10px] text-muted-foreground truncate max-w-[110px]">{task.client?.name || '—'}</span>
                                {task.service?.name && <span className="text-[10px] text-cyan-400/60">{task.service.name}</span>}
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusColor(task.status)}`}>{statusLabel(task.status)}</span>
                                <span className="text-[10px] text-muted-foreground/50">{task.task_date}</span>
                              </div>
                              {/* Contributor + assignment chips */}
                              {(contributorIds.length > 0 || assignedIds.length > 0) && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {contributorIds.map(eId => {
                                    const e = employees.find(x => x.id === eId)
                                    if (!e) return null
                                    return (
                                      <span key={'c' + eId} className="text-[9px] bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded-full">
                                        ✓ {e.cqid}
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
                        className={`min-h-[100px] border-r border-b border-border/40 p-1.5 ${!cell.inMonth ? 'bg-black/20 opacity-40' : ''} ${(i+1) % 7 === 0 ? 'border-r-0' : ''} ${i >= 35 ? 'border-b-0' : ''}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-[11px] font-medium ${isToday ? 'bg-blue-500 text-white rounded-full w-5 h-5 flex items-center justify-center' : 'text-muted-foreground'}`}>
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
                {/* Title — searchable combobox */}
                <div className="relative">
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Task Title *</label>
                  <input
                    value={addTaskForm.title}
                    onChange={e => {
                      const v = e.target.value
                      setAddTaskForm(f => ({ ...f, title: v }))
                      setTitleSearch(v)
                      setShowTitleDropdown(true)
                    }}
                    onFocus={() => { setTitleSearch(addTaskForm.title); setShowTitleDropdown(true) }}
                    onBlur={() => setTimeout(() => setShowTitleDropdown(false), 150)}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="e.g. Big Mid Week Offer Flyer"
                    autoFocus
                  />
                  {/* Suggestions dropdown */}
                  {showTitleDropdown && titleSuggestions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-card border border-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
                      <div className="px-3 py-1.5 border-b border-border/60">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Recent titles — click to reuse</p>
                      </div>
                      {titleSuggestions.map((t, i) => (
                        <button key={i} type="button"
                          onMouseDown={() => {
                            setAddTaskForm(f => ({ ...f, title: t }))
                            setShowTitleDropdown(false)
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2 text-foreground">
                          <Copy className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
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

                {/* Client + Service row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Client</label>
                    <AppSelect value={addTaskForm.client_id} onChange={e => setAddTaskForm(f => ({ ...f, client_id: e.target.value }))}>
                      <option value="">Select client…</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </AppSelect>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Service</label>
                    <AppSelect value={addTaskForm.service_id} onChange={e => setAddTaskForm(f => ({ ...f, service_id: e.target.value }))}>
                      <option value="">Select service…</option>
                      {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </AppSelect>
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
                <button onClick={bulkDeleteTasks}
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
              {canSeeFinancials && showFinancials && selectedTask?.billing_amount_inr > 0 && (
                <> · ₹{(selectedTask.billing_amount_inr || 0).toLocaleString('en-IN')}</>
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

        {/* Billing amount warning — shows when billing is 0 but contributions are entered */}
        {canSeeFinancials && showFinancials && calculatedResult && (selectedTask?.billing_amount_inr || 0) === 0 && (
          <div className="px-6 py-2 bg-amber-500/10 border-t border-amber-500/25 flex items-center gap-2">
            <span className="text-[11px] text-amber-400 font-medium">⚠ No billing amount set on this task — commission will be ₹0. Edit the task to add a billing amount first.</span>
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
                      used ? 'bg-purple-500/15 border-purple-500/30 text-purple-300' : 'bg-secondary border-transparent text-muted-foreground hover:border-border'
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
        {employees.length > 0 && (
          <div className="space-y-2">
            {employees.map(emp => {
              const isExpanded = expandedEmployees.has(emp.id)
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
                <div key={emp.id} className={`bg-card border rounded-xl overflow-hidden transition-all ${isExpanded ? 'border-primary/20' : 'border-border'}`}>

                  <button type="button"
                    onClick={() => setExpandedEmployees(prev => { const n = new Set(prev); n.has(emp.id) ? n.delete(emp.id) : n.add(emp.id); return n })}
                    className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-secondary/30 transition-colors">
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
                      {!groupSummary.length && <span className="text-xs text-muted-foreground/50">tap to expand</span>}
                      {isExpanded ? <ChevronLeft className="w-4 h-4 text-muted-foreground rotate-90" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-border p-4 space-y-2">
                      {groupedParams.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-4">
                          No contribution groups linked to this service. Configure in{' '}
                          <Link href="/dashboard/settings" className="underline hover:text-foreground">Settings</Link>.
                        </p>
                      )}
                      {groupedParams.map(group => {
                        const groupKey = `${emp.id}:${group.id}`
                        const isGroupOn = activeGroups.has(groupKey)
                        const master = group.master
                        const masterVal = contributions[master?.id]?.[emp.id] || 0
                        const isPct = (master?.input_type || 'count') === 'percentage'
                        const subActiveCount = group.subs.filter((p: any) =>
                          (contributions[p.id]?.[emp.id] || 0) > 0 || activeSubParams.has(`${emp.id}:${p.id}`)
                        ).length

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
                                <p className={`text-sm font-semibold ${isGroupOn ? 'text-foreground' : 'text-muted-foreground'}`}>
                                  {group.name}
                                </p>
                                {showFinancials && <p className="text-xs text-muted-foreground/60">{group.weight}% weight</p>}
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
                                          className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center hover:bg-secondary/60 transition-colors">
                                          <Minus className="w-3.5 h-3.5" />
                                        </button>
                                        <input type="number" min="0" step="1"
                                          value={masterVal || ''}
                                          onChange={e => setContrib(master.id, emp.id, parseInt(e.target.value) || 0)}
                                          className="w-16 bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm text-center font-semibold focus:outline-none focus:ring-2 focus:ring-primary/50"
                                          placeholder="0" />
                                        <button type="button" onClick={() => setContrib(master.id, emp.id, masterVal + 1)}
                                          className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center hover:bg-secondary/60 transition-colors">
                                          <Plus className="w-3.5 h-3.5" />
                                        </button>
                                        <span className="text-xs text-muted-foreground">items</span>
                                      </div>
                                    )}
                                  </div>
                                )}

                                {group.subs.length > 0 && (
                                  <div>
                                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                                      {isPct ? 'Revisions received' : 'Items handled'}
                                      <span className="normal-case font-normal ml-1 opacity-60">— tap to add</span>
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                      {group.subs.map((param: any) => {
                                        const count = contributions[param.id]?.[emp.id] || 0
                                        const isActive = count > 0 || activeSubParams.has(`${emp.id}:${param.id}`)
                                        if (!isActive) return (
                                          <button key={param.id} type="button"
                                            onClick={() => toggleSubParam(emp.id, param.id, count)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-transparent text-xs text-muted-foreground hover:border-border hover:text-foreground transition-all">
                                            <Plus className="w-3 h-3 opacity-50" /> {param.name}
                                          </button>
                                        )
                                        return (
                                          <div key={param.id} className="flex items-center gap-0 bg-amber-500/10 border border-amber-500/25 rounded-lg overflow-hidden text-xs">
                                            <span className="px-2.5 py-1.5 text-amber-300 font-medium border-r border-amber-500/20 whitespace-nowrap">{param.name}</span>
                                            <button type="button" onClick={() => setContrib(param.id, emp.id, Math.max(0, count - 1))}
                                              className="w-7 h-7 flex items-center justify-center text-amber-400 hover:bg-amber-500/10 transition-colors">
                                              <Minus className="w-3 h-3" />
                                            </button>
                                            <span className="w-7 text-center font-bold text-amber-300">{count}</span>
                                            <button type="button" onClick={() => setContrib(param.id, emp.id, count + 1)}
                                              className="w-7 h-7 flex items-center justify-center text-amber-400 hover:bg-amber-500/10 transition-colors">
                                              <Plus className="w-3 h-3" />
                                            </button>
                                            <button type="button" onClick={() => toggleSubParam(emp.id, param.id, count > 0 ? count : 1)}
                                              className="w-7 h-7 flex items-center justify-center text-amber-500/60 hover:text-red-400 hover:bg-red-500/10 border-l border-amber-500/20 transition-colors">
                                              <X className="w-3 h-3" />
                                            </button>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}
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
                  <div key={e.employeeId} className="px-5 py-4 flex items-center gap-4 hover:bg-secondary/20 transition-colors">
                    <div className="w-10 h-10 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-sm">
                      {emp?.cqid?.replace('CQID', '') || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <p className="font-semibold text-sm">{emp ? dn(emp) : e.employeeName}</p>
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

      </div>

      {/* ── Fixed bottom action bar ──
          On mobile: spans full width (sidebar is hidden behind hamburger).
          On md+: clears the 240px desktop sidebar via left-60. */}
      <div className="fixed bottom-0 left-0 md:left-60 right-0 z-20 bg-card/95 backdrop-blur-md border-t border-border px-4 sm:px-6 py-3 sm:py-3.5 flex items-center gap-2 sm:gap-3 flex-wrap pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button onClick={handleSave} disabled={saving}
          className="flex-1 sm:flex-initial flex items-center justify-center gap-2 gradient-bg text-white text-sm font-semibold px-4 sm:px-6 py-3 sm:py-2.5 rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity shadow-md shadow-primary/20">
          {saving
            ? <><span className="w-4 h-4 border-2 border-foreground/30 border-t-white rounded-full animate-spin" /> Saving…</>
            : calculatedResult
              ? <><Check className="w-4 h-4" /> Save &amp; Mark Done</>
              : 'Save Contributions'
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
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-400 px-3 py-2 rounded-lg hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all">
            <Trash2 className="w-3.5 h-3.5" /> Discard draft
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
