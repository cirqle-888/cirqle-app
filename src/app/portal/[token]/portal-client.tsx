'use client'

import { useState, useMemo } from 'react'
import { submitContributions } from './actions'
import { CheckCircle, Clock, ChevronDown, ChevronUp, Zap, AlertCircle, IndianRupee, ClipboardList } from 'lucide-react'

interface Props {
  employee: { id: string; cqid: string; name: string; email?: string; performance_rating: number; base_salary?: number; is_active: boolean }
  tasks: any[]
  contributions: { task_id: string; parameter_id: string; value: number }[]
  scores: { task_id: string; score_percentage: number; earnings_inr: number }[]
  parameters: any[]
  groups: any[]
  parameterServices: { parameter_id: string; service_id: string }[]
  groupServices: { group_id: string; service_id: string }[]
  token: string
}

function fmtDate(d?: string) {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}
function inr(n: number) {
  return '₹' + Math.round(n).toLocaleString('en-IN')
}

export default function PortalClient({ employee, tasks, contributions, scores, parameters, groups, parameterServices, groupServices, token }: Props) {
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [localContribs, setLocalContribs] = useState<Record<string, Record<string, number>>>(() => {
    // Pre-fill from existing contributions
    const map: Record<string, Record<string, number>> = {}
    contributions.forEach(c => {
      if (!map[c.task_id]) map[c.task_id] = {}
      map[c.task_id][c.parameter_id] = c.value
    })
    return map
  })
  const [saving, setSaving] = useState<string | null>(null)
  const [savedTasks, setSavedTasks] = useState<Set<string>>(
    () => new Set(contributions.map(c => c.task_id))
  )
  const [error, setError] = useState<string | null>(null)

  // Group tasks by status
  const tasksByStatus = useMemo(() => {
    const scored: any[] = []
    const submitted: any[] = []
    const pending: any[] = []

    tasks.forEach(task => {
      const score = scores.find(s => s.task_id === task.id)
      const hasContrib = savedTasks.has(task.id) || contributions.some(c => c.task_id === task.id)
      if (score) scored.push({ ...task, score })
      else if (hasContrib) submitted.push(task)
      else pending.push(task)
    })
    return { scored, submitted, pending }
  }, [tasks, scores, savedTasks, contributions])

  // Get parameters for a task based on its service
  function getTaskParams(task: any) {
    const linkedGroupIds = groupServices
      .filter(gs => gs.service_id === task.service_id)
      .map(gs => gs.group_id)
    const relevantGroups = linkedGroupIds.length > 0
      ? groups.filter(g => linkedGroupIds.includes(g.id))
      : groups

    return relevantGroups.map(group => {
      const linkedParamIds = parameterServices
        .filter(ps => ps.service_id === task.service_id)
        .map(ps => ps.parameter_id)
      const groupParams = parameters
        .filter(p => p.group_id === group.id)
        .filter(p => linkedParamIds.length === 0 || linkedParamIds.includes(p.id))
        .sort((a, b) => a.display_order - b.display_order)
      return { group, params: groupParams }
    }).filter(g => g.params.length > 0)
  }

  function setContrib(taskId: string, paramId: string, val: number) {
    setLocalContribs(prev => ({
      ...prev,
      [taskId]: { ...(prev[taskId] || {}), [paramId]: Math.max(0, Math.min(100, val)) }
    }))
  }

  async function handleSubmit(task: any) {
    const taskContribs = localContribs[task.id] || {}
    const grouped = getTaskParams(task)
    const contribs = grouped.flatMap(g => g.params.map((p: any) => ({
      parameter_id: p.id,
      value: taskContribs[p.id] || 0,
    })))

    setSaving(task.id)
    setError(null)
    try {
      await submitContributions(token, task.id, contribs)
      setSavedTasks(prev => new Set(prev).add(task.id))
      setExpandedTask(null)
    } catch (e: any) {
      setError(e.message || 'Failed to save. Please try again.')
    } finally {
      setSaving(null)
    }
  }

  const totalEarned = scores.reduce((s, sc) => s + (sc.earnings_inr || 0), 0)

  return (
    <div className="min-h-screen bg-[#090d13]">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#111827] to-[#0d1117] border-b border-foreground/15 px-4 py-4">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
                <span className="text-white font-bold text-sm">c</span>
              </div>
              <div>
                <div className="font-bold text-sm bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">cirqle</div>
                <div className="text-[10px] text-muted-foreground">Employee Portal</div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-semibold text-sm">{employee.cqid}</div>
              {/* eslint-disable-next-line no-restricted-syntax -- self-view: the employee's own name on their own token-scoped portal */}
              {employee.name && <div className="text-xs text-muted-foreground">{employee.name}</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-5 space-y-5">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-foreground/[0.03] border border-foreground/15 rounded-xl p-3 text-center">
            <div className="text-[10px] text-muted-foreground mb-1">Pending</div>
            <div className={`text-lg font-bold ${tasksByStatus.pending.length > 0 ? 'text-orange-400' : 'text-muted-foreground'}`}>
              {tasksByStatus.pending.length}
            </div>
          </div>
          <div className="bg-foreground/[0.03] border border-foreground/15 rounded-xl p-3 text-center">
            <div className="text-[10px] text-muted-foreground mb-1">Submitted</div>
            <div className="text-lg font-bold text-blue-400">{tasksByStatus.submitted.length}</div>
          </div>
          <div className="bg-foreground/[0.03] border border-foreground/15 rounded-xl p-3 text-center">
            <div className="text-[10px] text-muted-foreground mb-1">Earned</div>
            <div className="text-lg font-bold text-green-400">{inr(totalEarned)}</div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}

        {/* Pending Tasks — need contribution input */}
        {tasksByStatus.pending.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-4 h-4 text-orange-400" />
              <h2 className="text-sm font-semibold text-orange-300">Needs Your Input ({tasksByStatus.pending.length})</h2>
            </div>
            <div className="space-y-3">
              {tasksByStatus.pending.map(task => {
                const isOpen = expandedTask === task.id
                const grouped = getTaskParams(task)
                const taskContribs = localContribs[task.id] || {}
                const hasAnyInput = Object.values(taskContribs).some(v => v > 0)

                return (
                  <div key={task.id} className="bg-secondary border border-orange-500/20 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedTask(isOpen ? null : task.id)}
                      className="w-full px-4 py-3.5 flex items-start justify-between text-left hover:bg-foreground/[0.02] transition-colors">
                      <div className="flex-1 min-w-0 pr-3">
                        <div className="font-medium text-sm truncate">{task.title}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                          {task.client?.name && <span>{task.client.name}</span>}
                          {task.client?.name && task.task_date && <span>·</span>}
                          {task.task_date && <span>{fmtDate(task.task_date)}</span>}
                          {task.service?.name && <><span>·</span><span>{task.service.name}</span></>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {hasAnyInput && <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded-full">Draft</span>}
                        {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-foreground/15 px-4 py-4 space-y-5">
                        {grouped.length === 0 ? (
                          <p className="text-xs text-muted-foreground text-center py-2">No parameters configured for this service. Contact admin.</p>
                        ) : (
                          grouped.map(({ group, params }) => (
                            <div key={group.id}>
                              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">{group.name}</div>
                              <div className="space-y-4">
                                {params.map((param: any) => {
                                  const val = taskContribs[param.id] || 0
                                  return (
                                    <div key={param.id}>
                                      <div className="flex items-center justify-between mb-1.5">
                                        <label className="text-xs font-medium">{param.name}</label>
                                        <div className="flex items-center gap-2">
                                          <input
                                            type="number" min="0" max="100"
                                            value={val || ''}
                                            onChange={e => setContrib(task.id, param.id, parseInt(e.target.value) || 0)}
                                            className="w-14 bg-background border border-border/60 rounded-lg px-2 py-1 text-xs text-right focus:outline-none focus:border-purple-500/60"
                                            placeholder="0"
                                          />
                                          <span className="text-xs text-muted-foreground">%</span>
                                        </div>
                                      </div>
                                      <input
                                        type="range" min="0" max="100" step="5"
                                        value={val}
                                        onChange={e => setContrib(task.id, param.id, parseInt(e.target.value))}
                                        className="w-full accent-purple-500"
                                      />
                                      <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                                        <span>0%</span>
                                        <span className={val >= 80 ? 'text-green-400' : val >= 50 ? 'text-blue-400' : val > 0 ? 'text-amber-400' : ''}>
                                          {val}%
                                        </span>
                                        <span>100%</span>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          ))
                        )}

                        <button
                          onClick={() => handleSubmit(task)}
                          disabled={saving === task.id || grouped.length === 0}
                          className="w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition-opacity">
                          {saving === task.id ? (
                            <><span className="w-4 h-4 border-2 border-foreground/30 border-t-white rounded-full animate-spin" />Saving…</>
                          ) : (
                            <><Zap className="w-4 h-4" />Submit Contribution</>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Submitted Tasks — waiting for admin scoring */}
        {tasksByStatus.submitted.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-blue-300">Submitted — Awaiting Review ({tasksByStatus.submitted.length})</h2>
            </div>
            <div className="space-y-2">
              {tasksByStatus.submitted.map(task => {
                const isOpen = expandedTask === task.id
                const grouped = getTaskParams(task)
                const taskContribs = localContribs[task.id] || {}

                return (
                  <div key={task.id} className="bg-secondary border border-blue-500/20 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedTask(isOpen ? null : task.id)}
                      className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-foreground/[0.02] transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{task.title}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {task.client?.name}{task.task_date && ` · ${fmtDate(task.task_date)}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-full">Submitted</span>
                        {isOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-foreground/15 px-4 py-4 space-y-4">
                        <p className="text-xs text-blue-400/80">Your submitted values — you can update before admin finalizes scores.</p>
                        {grouped.map(({ group, params }) => (
                          <div key={group.id}>
                            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{group.name}</div>
                            <div className="space-y-3">
                              {params.map((param: any) => {
                                const val = taskContribs[param.id] || 0
                                return (
                                  <div key={param.id}>
                                    <div className="flex items-center justify-between mb-1">
                                      <label className="text-xs font-medium">{param.name}</label>
                                      <div className="flex items-center gap-2">
                                        <input
                                          type="number" min="0" max="100"
                                          value={val || ''}
                                          onChange={e => setContrib(task.id, param.id, parseInt(e.target.value) || 0)}
                                          className="w-14 bg-background border border-border/60 rounded-lg px-2 py-1 text-xs text-right focus:outline-none focus:border-purple-500/60"
                                          placeholder="0"
                                        />
                                        <span className="text-xs text-muted-foreground">%</span>
                                      </div>
                                    </div>
                                    <input
                                      type="range" min="0" max="100" step="5"
                                      value={val}
                                      onChange={e => setContrib(task.id, param.id, parseInt(e.target.value))}
                                      className="w-full accent-purple-500"
                                    />
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                        <button
                          onClick={() => handleSubmit(task)}
                          disabled={saving === task.id}
                          className="w-full py-2 rounded-xl bg-blue-600/20 border border-blue-500/30 text-blue-300 text-sm font-medium hover:bg-blue-600/30 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors">
                          {saving === task.id ? 'Updating…' : 'Update Submission'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Scored Tasks — commission calculated */}
        {tasksByStatus.scored.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <h2 className="text-sm font-semibold text-green-300">Scored ({tasksByStatus.scored.length})</h2>
            </div>
            <div className="space-y-2">
              {tasksByStatus.scored.map((task: any) => (
                <div key={task.id} className="bg-secondary border border-green-500/15 rounded-xl px-4 py-3 flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">{task.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {task.client?.name}{task.task_date && ` · ${fmtDate(task.task_date)}`}
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="text-sm font-bold text-green-400">{inr(task.score.earnings_inr)}</div>
                    <div className="text-[10px] text-muted-foreground">{Math.round(task.score.score_percentage)}% score</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Total earned */}
            {totalEarned > 0 && (
              <div className="mt-3 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <IndianRupee className="w-4 h-4 text-green-400" />
                  <span className="text-sm font-semibold text-green-300">Total Earned (scored tasks)</span>
                </div>
                <span className="text-base font-bold text-green-400">{inr(totalEarned)}</span>
              </div>
            )}
          </section>
        )}

        {/* Empty state */}
        {tasks.length === 0 && (
          <div className="text-center py-16">
            <ClipboardList className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No tasks assigned to you yet.</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Ask your admin to assign tasks.</p>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-[10px] text-muted-foreground/40 py-4">
          cirqle Employee Portal · {employee.cqid}
        </div>
      </div>
    </div>
  )
}
