'use client'

import { useState, useMemo, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { calculateCommission } from '@/lib/calculations/commission'
import { cn, ROW_INTERACTIVE_CLASS } from '@/lib/utils'
import { usePrivacy } from '@/contexts/privacy-context'
import { useToast } from '@/components/ui/toast'
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

  const draftKey = `cirqle_draft_${task.id}`

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [contribRes, toolsRes, toolSvcRes, toolRecRes, scoreRes, pricingRes] = await Promise.all([
        supabase.from('contributions').select('parameter_id, employee_id, value').eq('task_id', task.id),
        supabase.from('tools').select('*').eq('is_active', true).order('name'),
        supabase.from('tool_services').select('tool_id, service_id'),
        supabase.from('task_tools').select('tool_id').eq('task_id', task.id),
        supabase.from('contribution_scores')
          .select('employee_id, score_percentage, earnings_inr, calculated_at')
          .eq('task_id', task.id),
        task.client_id
          ? supabase.from('client_service_pricing')
              .select('commission_percentage')
              .eq('client_id', task.client_id)
              .eq('service_id', task.service_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ])

      setTools(toolsRes.data || [])
      setToolServices(toolSvcRes.data || [])
      setExistingScores(scoreRes.data || [])

      if (scoreRes.data?.length) {
        const dates = scoreRes.data
          .map((s: any) => s.calculated_at)
          .filter(Boolean)
          .sort()
        setLastUpdated(dates[dates.length - 1] || null)
      }

      const commPct = (pricingRes as any)?.data?.commission_percentage ?? 50
      setServiceCommPct(commPct)
      setPredefinedCommPct((pricingRes as any)?.data?.commission_percentage ?? null)

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
    if (!linked.length) return groups
    return groups.filter(g => linked.includes(g.id))
  }, [groups, groupServices, task.service_id])

  const filteredParams = useMemo(() => {
    const ids = filteredGroups.map(g => g.id)
    return parameters.filter(p => ids.includes(p.group_id))
  }, [filteredGroups, parameters])

  const filteredTools = useMemo(() => {
    const linked = toolServices.filter(ts => ts.service_id === task.service_id).map(ts => ts.tool_id)
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
      return calculateCommission({
        taskId: task.id,
        billingAmountINR: task.billing_amount_inr || 0,
        serviceCommissionPct: serviceCommPct,
        employees: employees.map(e => ({ ...e, performance_rating: e.performance_rating ?? 100 })) as any,
        groups: groups as any,
        parameters: filteredParams as any,
        toolsUsed: filteredTools.map((t: any) => ({ tool: t, used: toolsUsed[t.id] || false })),
        contributions: contribArray as any,
      })
    } catch { return null }
  }, [contributions, toolsUsed, serviceCommPct, task, employees, groups, filteredParams, filteredTools])

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

  async function handleSave() {
    if (!canEdit) return
    setSaving(true)

    const contribInserts = Object.entries(contributions).flatMap(([paramId, empMap]) =>
      Object.entries(empMap).filter(([, v]) => v > 0)
        .map(([empId, value]) => ({ task_id: task.id, employee_id: empId, parameter_id: paramId, value }))
    )
    const toolInserts = filteredTools.filter((t: any) => toolsUsed[t.id]).map((t: any) => ({ task_id: task.id, tool_id: t.id }))

    await Promise.all([
      supabase.from('contributions').delete().eq('task_id', task.id),
      supabase.from('task_tools').delete().eq('task_id', task.id),
    ])

    if (calculatedResult) {
      const scoreInserts = calculatedResult.employeeEarnings.map((e: any) => ({
        task_id: task.id, employee_id: e.employeeId,
        score_percentage: e.scorePercentage, earnings_inr: e.earnings,
      }))
      await supabase.from('contribution_scores').delete().eq('task_id', task.id)
      if (scoreInserts.length) {
        await supabase.from('contribution_scores').insert(scoreInserts)
        const now = new Date().toISOString()
        setExistingScores(scoreInserts.map((s: any) => ({ ...s, calculated_at: now })))
        setLastUpdated(now)
      }
      if (['pending', 'in_progress'].includes(task.status)) {
        await supabase.from('tasks').update({ status: 'done' }).eq('id', task.id)
      }
    }

    if (contribInserts.length) await supabase.from('contributions').insert(contribInserts)
    if (toolInserts.length) await supabase.from('task_tools').insert(toolInserts)

    setSaving(false)
    try { localStorage.removeItem(draftKey) } catch { /* ignore */ }

    if (calculatedResult?.employeeEarnings.length) {
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

  const commissionPool = (task.billing_amount_inr || 0) * (serviceCommPct / 100)
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
                · {new Date(lastUpdated).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
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

        {canSeeFinancials && (task.billing_amount_inr || 0) > 0 && (
          <div className="px-4 py-2 bg-foreground/[0.02] border-b border-border/50 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Pool ({serviceCommPct}% of ₹{(task.billing_amount_inr || 0).toLocaleString('en-IN')}):</span>
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
                      <p className="text-xs font-semibold">{emp ? dn(emp) : e.employeeName}</p>
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
                  className="text-[10px] text-amber-400 hover:text-amber-300 ml-auto transition-colors">
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
                        used ? 'bg-purple-500/15 border-purple-500/30 text-purple-300' : 'bg-secondary border-transparent text-muted-foreground hover:border-border'
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
                            No contribution groups linked to this service. Configure in Settings.
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

          {/* Warning: no billing amount → pool = ₹0 */}
          {calculatedResult && canSeeFinancials && (task.billing_amount_inr || 0) === 0 && (
            <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl px-4 py-3 flex items-start gap-2">
              <span className="text-amber-400 mt-0.5 shrink-0">⚠</span>
              <p className="text-[11px] text-amber-400">
                No billing amount set on this task — commission pool is ₹0 so earnings will be ₹0.
                Switch to the <strong>Details</strong> tab to set the billing amount first, then scores will calculate correctly.
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
                <span className="text-xs font-bold gradient-text">₹{calculatedResult.remainingPool.toFixed(0)} pool</span>
              </div>
              <div className="divide-y divide-border/30">
                {calculatedResult.employeeEarnings.map((e: any) => {
                  const emp = employees.find(em => em.id === e.employeeId)
                  return (
                    <div key={e.employeeId} className="px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-xs font-semibold">{emp ? dn(emp) : e.employeeName}</p>
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

          {/* Save */}
          <button type="button" onClick={handleSave} disabled={saving}
            className="w-full gradient-bg text-white text-sm font-semibold py-3 rounded-xl hover:opacity-90 disabled:opacity-50 transition-opacity">
            {saving ? 'Saving…' : 'Save Contributions'}
          </button>
        </>
      )}
    </div>
  )
}
