'use client'

import { useState, useMemo, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { calculateCommission } from '@/lib/calculations/commission'
import { taskPoolBasisInr, isCoveredWorkTask, resolveCommissionPct } from '@/lib/calculations/work-value'
import { getEffectivePerformanceRating } from '@/lib/calculations/performance-history'
import { cn, ROW_INTERACTIVE_CLASS } from '@/lib/utils'
import { usePrivacy } from '@/contexts/privacy-context'
import { useToast } from '@/components/ui/toast'
import { saveTaskContributions } from '@/app/(dashboard)/dashboard/contributions/actions'
import { closedPeriodNotice } from '@/lib/payroll/correction-notice'
import { formatDate } from '@/lib/utils/format-date'
import {
  Minus, Plus, X, Check, Eye, EyeOff, Users,
  CheckCircle2, AlertCircle, Clock, ChevronRight, ChevronLeft,
} from 'lucide-react'

interface Employee {
  id: string
  cqid: string
  name: string | null
  performance_rating?: number
}

interface Group {
  id: string
  name: string
  weight: number
}

interface Parameter {
  id: string
  name: string
  group_id: string
  weight: number
  is_master?: boolean
  input_type?: 'percentage' | 'count'
}

interface ContributionEntryPanelProps {
  task: {
    id: string
    task_number?: number | null
    title: string
    service_id: string
    task_date?: string
    billing_amount_inr?: number
    status: string
    client_id?: string
    client?: { id: string; name: string }
    service?: { id: string; name: string }
  }
  employees: Employee[]
  groups: Group[]
  parameters: Parameter[]
  groupServices: { group_id: string; service_id: string }[]
  canEdit: boolean
  showEarnings: boolean
  /** 'all' = show all employees (admin); 'own' = show only current employee */
  viewScope?: 'all' | 'own'
  /** The logged-in employee's id — required when viewScope === 'own' */
  currentEmployeeId?: string
  onSaved?: () => void
}

export function ContributionEntryPanel({
  task, employees: allEmployees, groups, parameters, groupServices,
  canEdit, showEarnings, viewScope = 'all', currentEmployeeId, onSaved,
}: ContributionEntryPanelProps) {
  // Scope employees to just the current user when they only have view_own access
  const employees = viewScope === 'own' && currentEmployeeId
    ? allEmployees.filter(e => e.id === currentEmployeeId)
    : allEmployees
  const supabase = createClient()
  const { dn } = usePrivacy()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [tools, setTools] = useState<any[]>([])
  const [toolServices, setToolServices] = useState<{ tool_id: string; service_id: string }[]>([])
  const [existingScores, setExistingScores] = useState<any[]>([])
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  const [contributions, setContributions] = useState<Record<string, Record<string, number>>>({})
  const [toolsUsed, setToolsUsed] = useState<Record<string, boolean>>({})
  const [serviceCommPct, setServiceCommPct] = useState(50)
  const [predefinedCommPct, setPredefinedCommPct] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [expandedEmployees, setExpandedEmployees] = useState<Set<string>>(new Set())
  const [activeGroups, setActiveGroups] = useState<Set<string>>(new Set())
  const [activeSubParams, setActiveSubParams] = useState<Set<string>>(new Set())
  const [showFinancials, setShowFinancials] = useState(false)
  // Per emp+group: whether the "less-used parameters" section is expanded
  const [expandedSubGroups, setExpandedSubGroups] = useState<Set<string>>(new Set())
  // empId → paramId → usage count (from history fetch on mount)
  const [paramHistory, setParamHistory] = useState<Map<string, Map<string, number>>>(new Map())
  const [performanceHistory, setPerformanceHistory] = useState<any[]>([])
  const [rates, setRates] = useState<any[]>([])
  const [pricingData, setPricingData] = useState<any>(null)
  // Retainer coverage of this task (covered work pools from the agreement's
  // work value, not billing). null = not covered / not yet loaded.
  const [workValueTask, setWorkValueTask] = useState<{
    retainer_item_id: string | null
    bill_as_extra: boolean
    work_value_inr: number | null
    work_commission_pct: number | null
  } | null>(null)

  const draftKey = `cirqle_draft_${task.id}`

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [contribRes, toolsRes, toolSvcRes, toolRecRes, scoreRes, pricingRes, histRes, ratesRes] = await Promise.all([
        supabase.from('contributions').select('parameter_id, employee_id, value').eq('task_id', task.id),
        supabase.from('tools').select('*').eq('is_active', true).order('name'),
        supabase.from('tool_services').select('tool_id, service_id'),
        supabase.from('task_tools').select('tool_id').eq('task_id', task.id),
        supabase.from('contribution_scores')
          .select('employee_id, score_percentage, earnings_inr, calculated_at')
          .eq('task_id', task.id),
        task.client_id
          ? supabase.from('client_service_pricing')
              .select('commission_percentage, price, currency')
              .eq('client_id', task.client_id)
              .eq('service_id', task.service_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        supabase.from('employee_performance_history').select('*').order('effective_from', { ascending: false }),
        supabase.from('exchange_rates').select('currency, rate_to_inr'),
      ])

      // Retainer coverage + agreement work value (defensive: pre-migration or
      // RLS-restricted viewers simply keep the billing-based path).
      let wv: {
        retainer_item_id: string | null; bill_as_extra: boolean
        work_value_inr: number | null; work_commission_pct: number | null
      } | null = null
      try {
        const { data: covRow } = await supabase
          .from('tasks')
          .select('retainer_item_id, bill_as_extra, work_value_inr, retainer_item:client_agreement_items(work_commission_pct)')
          .eq('id', task.id)
          .maybeSingle()
        if (covRow) {
          wv = {
            retainer_item_id: (covRow as any).retainer_item_id ?? null,
            bill_as_extra: !!(covRow as any).bill_as_extra,
            work_value_inr: (covRow as any).work_value_inr ?? null,
            work_commission_pct: (covRow as any).retainer_item?.work_commission_pct ?? null,
          }
        }
      } catch { /* keep billing-based path */ }
      setWorkValueTask(wv)

      setTools(toolsRes.data || [])
      setToolServices(toolSvcRes.data || [])
      setExistingScores(scoreRes.data || [])
      setPerformanceHistory((histRes as any)?.data || [])
      setRates((ratesRes as any)?.data || [])

      // Fetch param usage history to rank sub-parameters by frequency.
      // For 'own' scope we only need the current employee; for 'all' we
      // fetch everyone scoped to the same service's tasks so the query stays small.
      const histQ = supabase
        .from('contributions')
        .select('employee_id, parameter_id, task_id')
        .gt('value', 0)
        .neq('task_id', task.id) // exclude current task (its values are already loaded)
      const finalHistQ = viewScope === 'own' && currentEmployeeId
        ? histQ.eq('employee_id', currentEmployeeId)
        : histQ
      const { data: histRows } = await finalHistQ
      if (histRows?.length) {
        const hm = new Map<string, Map<string, number>>()
        for (const r of histRows as any[]) {
          if (!r.parameter_id) continue
          if (!hm.has(r.employee_id)) hm.set(r.employee_id, new Map())
          const inner = hm.get(r.employee_id)!
          inner.set(r.parameter_id, (inner.get(r.parameter_id) || 0) + 1)
        }
        setParamHistory(hm)
      }

      if (scoreRes.data?.length) {
        const dates = scoreRes.data
          .map((s: any) => s.calculated_at)
          .filter(Boolean)
          .sort()
        setLastUpdated(dates[dates.length - 1] || null)
      }

      // Agreement item override wins for retainer-linked tasks → matrix → 50.
      const matrixCommPct = (pricingRes as any)?.data?.commission_percentage ?? null
      const commPct = wv
        ? resolveCommissionPct(wv, wv.work_commission_pct, matrixCommPct)
        : (matrixCommPct ?? 50)
      setServiceCommPct(commPct)
      setPredefinedCommPct(
        wv?.retainer_item_id && wv.work_commission_pct != null
          ? wv.work_commission_pct
          : matrixCommPct,
      )
      setPricingData((pricingRes as any)?.data || null)

      if (contribRes.data?.length) {
        const linkedGroupIds = groupServices
          .filter(gs => gs.service_id === task.service_id)
          .map(gs => gs.group_id)
        const taskGroups = linkedGroupIds.length > 0
          ? groups.filter(g => linkedGroupIds.includes(g.id))
          : groups
        const taskParams = parameters.filter(p => taskGroups.some(g => g.id === p.group_id))
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
          const group = taskGroupedParams.find(g => g.params.some((p: any) => p.id === parameter_id))
          if (group) {
            newActiveGroups.add(`${employee_id}:${group.id}`)
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

      if (toolRecRes.data?.length) {
        const toolsMap: Record<string, boolean> = {}
        toolRecRes.data.forEach(({ tool_id }: any) => { toolsMap[tool_id] = true })
        setToolsUsed(toolsMap)
      }

      if (!contribRes.data?.length && !toolRecRes.data?.length) {
        try {
          const draft = localStorage.getItem(draftKey)
          if (draft) {
            const { contributions: dc, toolsUsed: dt, serviceCommPct: dsp } = JSON.parse(draft)
            if (dc) setContributions(dc)
            if (dt) setToolsUsed(dt)
            if (dsp) setServiceCommPct(dsp)
            const empIds = new Set<string>()
            Object.values(dc || {}).forEach((empMap: any) => Object.keys(empMap).forEach(id => empIds.add(id)))
            if (empIds.size) setExpandedEmployees(empIds)
          }
        } catch { /* ignore */ }
      }

      // In 'own' scope, auto-expand the current employee's card so they land
      // directly on the entry form — no extra tap needed.
      if (viewScope === 'own' && currentEmployeeId) {
        setExpandedEmployees(prev => { const n = new Set(prev); n.add(currentEmployeeId); return n })
      }

      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  useEffect(() => {
    const hasData = Object.values(contributions).some(m => Object.values(m).some(v => v > 0))
      || Object.values(toolsUsed).some(Boolean)
    if (!hasData) return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ contributions, toolsUsed, serviceCommPct }))
        setDraftSaved(true)
        setTimeout(() => setDraftSaved(false), 2000)
      } catch { /* ignore */ }
    }, 1500)
    return () => clearTimeout(timer)
  }, [contributions, toolsUsed, serviceCommPct, draftKey])

  const filteredGroups = useMemo(() => {
    const linked = groupServices.filter(gs => gs.service_id === task.service_id).map(gs => gs.group_id)
    // No linked groups = ALL groups available — same fallback as this panel's
    // own load path above, the contributions page, and every recalc path.
    if (!linked.length) return groups
    return groups.filter(g => linked.includes(g.id))
  }, [groups, groupServices, task.service_id])

  const filteredParams = useMemo(() => {
    const ids = filteredGroups.map(g => g.id)
    return parameters.filter(p => ids.includes(p.group_id))
  }, [filteredGroups, parameters])

  const filteredTools = useMemo(() => {
    const linked = toolServices.filter(ts => ts.service_id === task.service_id).map(ts => ts.tool_id)
    // No linked tools = ALL tools available — matches the recalculation paths.
    if (!linked.length) return tools
    return tools.filter((t: any) => linked.includes(t.id))
  }, [tools, toolServices, task.service_id])

  const groupedParams = useMemo(() => {
    return filteredGroups.map(g => {
      const params = filteredParams.filter(p => p.group_id === g.id)
      const master = params.find(p => p.is_master === true) || params.find(p => p.weight === 1) || params[0]
      const subs = params.filter(p => p.id !== master?.id)
      return { ...g, master, subs, params }
    }).filter(g => g.params.length > 0)
  }, [filteredGroups, filteredParams])

  const calculatedResult = useMemo(() => {
    const hasAny = Object.values(contributions).some(m => Object.values(m).some(v => v > 0))
    if (!hasAny) return null
    const contribArray = Object.entries(contributions).flatMap(([paramId, empMap]) =>
      Object.entries(empMap).map(([empId, value]) => ({
        id: '', task_id: task.id, parameter_id: paramId, employee_id: empId, value,
        locked: false, created_at: '', updated_at: '',
      }))
    )
    try {
      const effectiveEmployees = employees.map(e => ({
        ...e,
        performance_rating: getEffectivePerformanceRating(e.id, task.task_date || new Date().toISOString(), performanceHistory, e.performance_rating ?? 100)
      }))

      // Covered retainer work pools from the stamped agreement work value —
      // never the pricing matrix (that would re-couple pay to client billing).
      const covered = workValueTask ? isCoveredWorkTask(workValueTask) : false
      let internalValueInr = workValueTask
        ? taskPoolBasisInr({ ...workValueTask, billing_amount_inr: task.billing_amount_inr })
        : (task.billing_amount_inr || 0)
      if (!covered && internalValueInr === 0 && pricingData?.price) {
        const qty = 1
        const priceRate = rates.find((r: any) => r.currency === pricingData.currency)?.rate_to_inr || 1
        internalValueInr = (pricingData.price * qty) * Number(priceRate)
      }

      return calculateCommission({
        taskId: task.id,
        billingAmountINR: internalValueInr,
        serviceCommissionPct: serviceCommPct,
        employees: effectiveEmployees as any,
        groups: groups as any,
        parameters: filteredParams as any,
        toolsUsed: filteredTools.map((t: any) => ({ tool: t, used: toolsUsed[t.id] || false })),
        contributions: contribArray as any,
      })
    } catch { return null }
  }, [contributions, toolsUsed, serviceCommPct, task, employees, groups, filteredParams, filteredTools, workValueTask, pricingData, rates])

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

  // Split a group's sub-parameters into frequently-used (shown up-front as
  // ready steppers) and less-used (hidden behind an expander).
  // Ranking = historical usage count. Any param with a current value always shows.
  function rankSubParams(empId: string, subs: any[]) {
    const usage = paramHistory.get(empId)
    const N = 4
    const scored = subs.map(p => ({
      p,
      score: usage?.get(p.id) || 0,
      hasVal: (contributions[p.id]?.[empId] || 0) > 0,
    }))
    const sorted = [...scored].sort((a, b) =>
      b.score - a.score || (a.p.display_order || 0) - (b.p.display_order || 0))

    const frequentSet = new Set<string>()
    scored.forEach(s => { if (s.hasVal) frequentSet.add(s.p.id) })
    for (const s of sorted) {
      if (frequentSet.size >= N) break
      if (s.score > 0) frequentSet.add(s.p.id)
    }
    if (frequentSet.size === 0) sorted.slice(0, N).forEach(s => frequentSet.add(s.p.id))

    return {
      frequent: subs.filter(p => frequentSet.has(p.id)),
      rest:     subs.filter(p => !frequentSet.has(p.id)),
    }
  }

  // Order an employee's groups by their own usage history (frequency).
  // Groups with any value in the CURRENT task float to the top; new employees
  // keep the configured display order. Top group is tagged for the badge.
  function rankGroups(empId: string, gps: any[]) {
    const usage = paramHistory.get(empId)
    const scored = gps.map(g => {
      let count = 0
      for (const p of g.params) count += usage?.get(p.id) || 0
      const isActive = g.params.some((p: any) => (contributions[p.id]?.[empId] || 0) > 0)
      return { g, score: count, isActive }
    })
    scored.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      return b.score - a.score || (a.g.display_order || 0) - (b.g.display_order || 0)
    })
    const topId = scored.length > 1 && scored[0]?.score > 0 ? scored[0].g.id : null
    return scored.map(s => ({ ...s, isMostUsed: s.g.id === topId }))
  }

  /**
   * Saves through the SAME guarded server action as the Contributions page.
   *
   * This used to delete-then-insert `contributions`, `task_tools` and
   * `contribution_scores` straight from the browser. RLS only checks
   * `contributions.edit`, so that path silently skipped both protections the
   * Contributions page enforces: the closed-month guard and manual-override
   * preservation. The same person, on the same task, was refused in one place
   * and succeeded in the other — editing closed books and wiping curated
   * earnings with no warning. Phase 3.0 moved the other call site server-side;
   * this shared panel was left behind.
   *
   * Do NOT reintroduce direct writes to these three tables from here.
   */
  async function handleSave() {
    if (!canEdit) return
    setSaving(true)

    const toolIds = filteredTools.filter((t: any) => toolsUsed[t.id]).map((t: any) => t.id)

    const res = await saveTaskContributions({
      taskId: task.id,
      contributions,
      scores: calculatedResult
        ? calculatedResult.employeeEarnings.map((e: any) => ({
            employeeId: e.employeeId,
            scorePercentage: e.scorePercentage,
            earnings: e.earnings,
          }))
        : undefined,
      toolIds,
      markDone: true,   // server only advances pending/in_progress → done
    })

    if (!res.ok) {
      setSaving(false)
      // Keep the draft: a refused save (closed month, missing permission) must
      // not cost the user the values they just typed.
      toast.error('Failed to save contributions', res.error || 'Unknown error', 6000)
      return
    }

    // Re-read what actually landed rather than echoing what we sent — a
    // manually-overridden row keeps its old figure, so trusting the local
    // computation here would show a number the database does not hold.
    const { data: saved } = await supabase
      .from('contribution_scores')
      .select('employee_id, score_percentage, earnings_inr, calculated_at')
      .eq('task_id', task.id)
    if (saved) {
      setExistingScores(saved)
      setLastUpdated(
        saved.map((s: any) => s.calculated_at).filter(Boolean).sort().pop() ?? new Date().toISOString(),
      )
    }

    setSaving(false)
    try { localStorage.removeItem(draftKey) } catch { /* ignore */ }

    if ((res.preservedOverrides ?? 0) > 0) {
      const n = res.preservedOverrides!
      toast.info(
        `${n} ${n === 1 ? 'score kept its manual override' : 'scores kept their manual overrides'}`,
        'Their parameters were saved, but the score % and ₹ stay as manually set — recalculation cannot overwrite an override.',
        8000,
      )
    }

    if (res.closedPeriod) {
      const notice = closedPeriodNotice(res.correctedMonth, res.adjustmentsRecorded)
      toast.info(notice.title, notice.body, 10000)
    } else if (calculatedResult?.employeeEarnings.length) {
      const lines = calculatedResult.employeeEarnings
        .map((e: any) => `${employees.find(em => em.id === e.employeeId)?.cqid ?? '?'} ₹${Math.round(e.earnings).toLocaleString('en-IN')}`)
        .join(' · ')
      toast.success('Contributions saved', lines, 3500)
    } else {
      toast.success('Contributions saved')
    }

    onSaved?.()
  }

  const scoringStatus = useMemo(() => {
    if (existingScores.length === 0) return 'pending'
    if (existingScores.every((s: any) => (s.score_percentage || 0) > 0)) return 'scored'
    return 'partial'
  }, [existingScores])

  // Pool basis: agreement work value for covered retainer tasks, else billing.
  const poolBasisInr = workValueTask
    ? taskPoolBasisInr({ ...workValueTask, billing_amount_inr: task.billing_amount_inr })
    : (task.billing_amount_inr || 0)
  const coveredWork = workValueTask ? isCoveredWorkTask(workValueTask) : false
  const commissionPool = poolBasisInr * (serviceCommPct / 100)
  const canSeeFinancials = showEarnings && showFinancials

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-12 bg-foreground/5 rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4 pb-6">

      {/* ── Summary card ── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between border-b border-border/50">
          <div className="flex items-center gap-2 flex-wrap">
            {scoringStatus === 'scored' ? (
              <span className="flex items-center gap-1.5 text-[11px] text-green-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Scored
              </span>
            ) : scoringStatus === 'partial' ? (
              <span className="flex items-center gap-1.5 text-[11px] text-blue-400 font-medium">
                <Clock className="w-3.5 h-3.5" /> Partial
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-amber-400 font-medium">
                <AlertCircle className="w-3.5 h-3.5" /> Pending
              </span>
            )}
            {lastUpdated && (
              <span className="text-[10px] text-muted-foreground/60">
                · {formatDate(lastUpdated)}
              </span>
            )}
          </div>
          {showEarnings && (
            <button onClick={() => setShowFinancials(f => !f)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border hover:border-foreground/20">
              {showFinancials ? <><EyeOff className="w-3 h-3" /> Hide ₹</> : <><Eye className="w-3 h-3" /> Show ₹</>}
            </button>
          )}
        </div>

        {canSeeFinancials && poolBasisInr > 0 && (
          <div className="px-4 py-2 bg-foreground/[0.02] border-b border-border/50 flex items-center gap-2">
            <span
              className="text-[11px] text-muted-foreground"
              title={`Commission pool = ${serviceCommPct}% of the task's ${coveredWork ? 'retainer work value' : 'billed amount'}`}
            >
              Team share ({serviceCommPct}% of ₹{poolBasisInr.toLocaleString('en-IN')}
              {coveredWork ? ' retainer work value' : ''}):
            </span>
            <span className="text-xs font-bold gradient-text">₹{commissionPool.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
          </div>
        )}

        {/* When a live calculation is running, show those values (what will be saved).
            Fall back to DB-saved scores only when no live data is available. */}
        {calculatedResult && calculatedResult.employeeEarnings.length > 0 ? (
          <div className="divide-y divide-border/30">
            {calculatedResult.employeeEarnings.map((e: any) => {
              const emp = employees.find(em => em.id === e.employeeId)
              return (
                <div key={e.employeeId} className="px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full gradient-bg flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                      {emp?.cqid?.replace('CQID', '') || '?'}
                    </div>
                    <div>
                      <p className="text-xs font-semibold">{dn(emp ?? { name: e.employeeName })}</p>
                      <p className="text-[10px] text-muted-foreground">{emp?.cqid}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold gradient-text">{e.scorePercentage.toFixed(1)}%</span>
                    {canSeeFinancials && e.earnings > 0 && (
                      <span className="text-sm font-bold text-green-400">₹{Math.round(e.earnings).toLocaleString('en-IN')}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : existingScores.length > 0 ? (
          <div className="divide-y divide-border/30">
            {existingScores.map((s: any) => {
              const emp = employees.find(e => e.id === s.employee_id)
              return (
                <div key={s.employee_id} className="px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full gradient-bg flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                      {emp?.cqid?.replace('CQID', '') || '?'}
                    </div>
                    <div>
                      <p className="text-xs font-semibold">{emp ? dn(emp) : 'Unknown'}</p>
                      <p className="text-[10px] text-muted-foreground">{emp?.cqid}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold gradient-text">{(s.score_percentage || 0).toFixed(1)}%</span>
                    {canSeeFinancials && (s.earnings_inr || 0) > 0 && (
                      <span className="text-sm font-bold text-green-400">₹{Math.round(s.earnings_inr).toLocaleString('en-IN')}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="px-4 py-3 text-[11px] text-muted-foreground/60">No scores recorded yet.</p>
        )}
      </div>

      {/* ── Entry form (canEdit only) ── */}
      {canEdit && (
        <>
          {draftSaved && (
            <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400/60" /> Draft saved
            </p>
          )}

          {/* Commission rate */}
          {canSeeFinancials && (
            <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3">
              <span className="text-xs text-muted-foreground shrink-0">Commission rate:</span>
              <input type="number" min="0" max="100" step="1"
                value={serviceCommPct}
                onChange={e => setServiceCommPct(parseFloat(e.target.value) || 0)}
                className="w-16 text-xs bg-secondary border border-border rounded px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-primary/50" />
              <span className="text-xs text-muted-foreground">%</span>
              {predefinedCommPct !== null && serviceCommPct !== predefinedCommPct && (
                <button onClick={() => setServiceCommPct(predefinedCommPct!)}
                  className="text-[10px] text-amber-400 hover:text-amber-700 dark:text-amber-300 ml-auto transition-colors">
                  Reset to {predefinedCommPct}%
                </button>
              )}
            </div>
          )}

          {/* Tools */}
          {filteredTools.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Tools Used</p>
              <div className="flex flex-wrap gap-2">
                {filteredTools.map((tool: any) => {
                  const used = toolsUsed[tool.id] || false
                  return (
                    <button key={tool.id} type="button"
                      onClick={() => setToolsUsed(prev => ({ ...prev, [tool.id]: !prev[tool.id] }))}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                        used ? 'bg-purple-500/15 border-purple-500/30 text-purple-700 dark:text-purple-300' : 'bg-secondary border-transparent text-muted-foreground hover:border-border'
                      }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${used ? 'bg-purple-400' : 'bg-muted-foreground/40'}`} />
                      {tool.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* No employees state */}
          {employees.length === 0 && (
            <div className="bg-card border border-border rounded-xl p-6 text-center">
              <Users className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-sm font-semibold mb-1">No employees set up</p>
              <p className="text-xs text-muted-foreground">Add employees in HR &amp; Payroll first.</p>
            </div>
          )}

          {/* Employee cards */}
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

                const liveEarning = calculatedResult?.employeeEarnings.find(e => e.employeeId === emp.id)

                // In 'own' scope there's exactly one card — always expanded, no toggle
                const isOwnScope = viewScope === 'own'

                return (
                  <div key={emp.id} className={`bg-card border rounded-xl overflow-hidden transition-all ${isExpanded ? 'border-primary/20' : 'border-border'}`}>
                    {/* Card header: clickable to expand/collapse in 'all' scope;
                        static name banner in 'own' scope (already expanded) */}
                    {isOwnScope ? (
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
                        <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0">
                          {emp.cqid?.replace('CQID', '') || '?'}
                        </div>
                        <div>
                          <p className="font-semibold text-sm">{dn(emp)}</p>
                          <p className="text-xs text-muted-foreground">{emp.cqid}</p>
                        </div>
                        {canSeeFinancials && liveEarning && (
                          <span className="text-xs font-bold text-green-400 ml-auto">₹{liveEarning.earnings.toFixed(0)}</span>
                        )}
                      </div>
                    ) : (
                      <button type="button"
                        onClick={() => setExpandedEmployees(prev => { const n = new Set(prev); n.has(emp.id) ? n.delete(emp.id) : n.add(emp.id); return n })}
                        className={cn('w-full flex items-center justify-between px-4 py-3.5', ROW_INTERACTIVE_CLASS)}>
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
                          {canSeeFinancials && liveEarning && (
                            <span className="text-xs font-bold text-green-400">₹{liveEarning.earnings.toFixed(0)}</span>
                          )}
                          {!groupSummary.length && <span className="text-xs text-muted-foreground/50">expand</span>}
                          {isExpanded
                            ? <ChevronLeft className="w-4 h-4 text-muted-foreground rotate-90" />
                            : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                        </div>
                      </button>
                    )}

                    {(isExpanded || isOwnScope) && (
                      <div className="border-t border-border p-4 space-y-2">
                        {groupedParams.length === 0 && (
                          <p className="text-xs text-muted-foreground text-center py-4">
                            No contribution groups with parameters are available for this service. Configure in Settings.
                          </p>
                        )}
                        {/* Per-employee summary — instant feedback without scrolling */}
                        {groupedParams.length > 0 && (() => {
                          const used = groupedParams.reduce((acc, g) =>
                            acc + g.params.filter((p: any) => (contributions[p.id]?.[emp.id] || 0) > 0).length, 0)
                          const liveEmp = calculatedResult?.employeeEarnings.find(e => e.employeeId === emp.id)
                          return (
                            <div className="flex items-center gap-x-4 gap-y-1 flex-wrap rounded-xl border border-border bg-secondary/30 px-3 py-2 text-xs">
                              <span className="text-muted-foreground">Used <span className="font-semibold text-foreground">{used}</span></span>
                              {liveEmp && <span className="text-muted-foreground">Score <span className="font-semibold text-primary">{liveEmp.scorePercentage.toFixed(1)}%</span></span>}
                              {canSeeFinancials && liveEmp && (
                                <span className="text-muted-foreground">Earns <span className="font-semibold text-green-600 dark:text-green-400">₹{Math.round(liveEmp.earnings).toLocaleString('en-IN')}</span></span>
                              )}
                              {lastUpdated && (
                                <span className="text-muted-foreground/70 ml-auto">
                                  Saved {formatDate(lastUpdated)}
                                </span>
                              )}
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
                                              className="w-9 h-9 rounded-lg bg-background/60 border border-border flex items-center justify-center hover:bg-secondary active:scale-90 disabled:opacity-30 disabled:active:scale-100 transition-all">
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
                                              className="w-9 h-9 rounded-lg bg-background/60 border border-border flex items-center justify-center hover:bg-secondary active:scale-90 transition-all">
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
                                              const n = new Set(prev)
                                              n.has(expandKey) ? n.delete(expandKey) : n.add(expandKey)
                                              return n
                                            })}
                                            className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                                            <ChevronLeft className={`w-3.5 h-3.5 transition-transform ${showAll ? '-rotate-90' : 'rotate-90'}`} />
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

          {/* Warning: pool basis missing → pool = ₹0 */}
          {calculatedResult && canSeeFinancials && poolBasisInr === 0 && (
            <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl px-4 py-3 flex items-start gap-2">
              <span className="text-amber-400 mt-0.5 shrink-0">⚠</span>
              <p className="text-[11px] text-amber-400">
                {coveredWork ? (
                  <>This task is covered by a retainer, but its agreement item has no <strong>work value</strong> —
                  so there is nothing for the team to share and everyone earns ₹0. Set the work value on the agreement page.</>
                ) : (
                  <>No price set on this task — so there is nothing for the team to share and everyone earns ₹0.
                  Switch to the <strong>Details</strong> tab to set the billing amount first, then scores will calculate correctly.</>
                )}
              </p>
            </div>
          )}

          {/* Live commission breakdown */}
          {calculatedResult && canSeeFinancials && (
            <div className="rounded-xl overflow-hidden border border-green-500/20">
              <div className="px-4 py-3 bg-green-500/5 border-b border-green-500/15 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-xs font-bold">Live Calculation</span>
                </div>
                <span className="text-xs font-bold gradient-text">₹{calculatedResult.remainingPool.toFixed(0)} to share</span>
              </div>
              <div className="divide-y divide-border/30">
                {calculatedResult.employeeEarnings.map((e: any) => {
                  const emp = employees.find(em => em.id === e.employeeId)
                  return (
                    <div key={e.employeeId} className="px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-xs font-semibold">{dn(emp ?? { name: e.employeeName })}</p>
                          <span className="text-[10px] text-muted-foreground">{e.scorePercentage.toFixed(1)}%</span>
                        </div>
                        <div className="flex-1 bg-secondary rounded-full h-1.5">
                          <div className="h-1.5 rounded-full gradient-bg" style={{ width: `${Math.min(e.scorePercentage, 100)}%` }} />
                        </div>
                      </div>
                      <p className="font-bold text-green-400 shrink-0">₹{e.earnings.toFixed(0)}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Save — sticky to the bottom of the scroll area so it's always
              reachable no matter how many parameters are being scored. The
              negative margins let the bar span the full panel width. */}
          <div className="sticky bottom-0 -mx-4 -mb-6 px-4 pt-3 pb-4 bg-card/95 backdrop-blur border-t border-border">
            <button type="button" onClick={handleSave} disabled={saving}
              className="w-full gradient-bg text-white text-sm font-semibold py-3 rounded-xl hover:opacity-90 disabled:opacity-50 transition-opacity">
              {saving ? 'Saving…' : 'Save Contributions'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
