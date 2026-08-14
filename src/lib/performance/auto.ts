import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Auto Performance Metrics — computed from data the app already records.
 * Read-only: nothing here writes anywhere. Sources:
 *   • employees.joined_date                     → tenure
 *   • contribution_scores + tasks               → completion %, output %, rework, productivity
 *   • task_requests (+ request_revisions)       → on-time %, client revision requests
 *
 * Window: the last 12 months of tasks/requests, so the score reflects recent
 * work, not ancient history. A metric with no data stays null and is simply
 * left out of the composite (weights re-normalize) — no fake zeros.
 */

import type { AutoMetric, AutoResult } from './types'
import { toISODate } from '@/lib/utils/local-date'

/** Relative weights of each metric inside the composite (re-normalized over available ones). */
const WEIGHTS: Record<string, number> = {
  tenure: 10,
  completion: 20,
  on_time: 20,
  rework: 15,
  output: 25,
  productivity: 10,
}

const WINDOW_MONTHS = 12
const TENURE_FULL_YEARS = 5           // 5+ years at Cirqle = full tenure marks
const DONE_STATUSES = new Set(['done', 'invoiced', 'paid'])
const REQUEST_DONE_STATUSES = new Set(['completed', 'delivered'])

const clamp = (n: number) => Math.max(0, Math.min(100, n))
const round1 = (n: number) => Math.round(n * 10) / 10

interface EmployeeIn { id: string; joined_date?: string | null }

interface TaskRow { id: string; status: string | null; variant_type: string | null; deleted_at: string | null }
interface ScoreRow { employee_id: string | null; task_id: string; score_percentage: number | null }
interface RequestRow { assigned_employee_id: string | null; due_date: string | null; status: string; status_updated_at: string }

/**
 * Compute auto metrics for a set of employees in one pass (4 queries total).
 * Defensive: if a table from a not-yet-applied migration is missing, its
 * metric is simply null.
 */
export async function computeAutoForEmployees(
  admin: SupabaseClient,
  employees: EmployeeIn[],
  now: Date = new Date(),
): Promise<Record<string, AutoResult>> {
  const since = new Date(now)
  since.setMonth(since.getMonth() - WINDOW_MONTHS)
  const sinceDate =toISODate( since)

  const [tasksRes, scoresRes, requestsRes, revisionsRes] = await Promise.all([
    admin.from('tasks')
      .select('id, status, variant_type, deleted_at')
      .gte('task_date', sinceDate)
      .is('deleted_at', null)
      .then(r => r, () => ({ data: null })),
    admin.from('contribution_scores')
      .select('employee_id, task_id, score_percentage')
      .then(r => r, () => ({ data: null })),
    admin.from('task_requests')
      .select('assigned_employee_id, due_date, status, status_updated_at')
      .not('assigned_employee_id', 'is', null)
      .gte('created_at', since.toISOString())
      .then(r => r, () => ({ data: null })),
    admin.from('request_revisions')
      .select('id, task_requests!inner(assigned_employee_id, created_at)')
      .gte('task_requests.created_at', since.toISOString())
      .then(r => r, () => ({ data: null })),
  ])

  const tasks = new Map<string, TaskRow>(((tasksRes.data ?? []) as TaskRow[]).map(t => [t.id, t]))
  const scores = ((scoresRes.data ?? []) as ScoreRow[]).filter(s => s.employee_id && tasks.has(s.task_id))
  const requests = (requestsRes.data ?? []) as RequestRow[]
  // Supabase's generated types infer the FK embed as to-many; at runtime it is
  // a single object. Accept both shapes.
  type EmbeddedReq = { assigned_employee_id: string | null }
  const revisionRows = (revisionsRes.data ?? []) as unknown as Array<{ task_requests: EmbeddedReq | EmbeddedReq[] | null }>

  // Per-employee task sets (a task counts once even with several score rows)
  const empTasks = new Map<string, Set<string>>()
  const empOutput = new Map<string, { sum: number; n: number }>()
  for (const s of scores) {
    const eid = s.employee_id as string
    let set = empTasks.get(eid)
    if (!set) { set = new Set(); empTasks.set(eid, set) }
    set.add(s.task_id)
    if (s.score_percentage != null) {
      const cur = empOutput.get(eid) ?? { sum: 0, n: 0 }
      empOutput.set(eid, { sum: cur.sum + Number(s.score_percentage), n: cur.n + 1 })
    }
  }

  const empRevisionRequests = new Map<string, number>()
  for (const r of revisionRows) {
    const tr = Array.isArray(r.task_requests) ? r.task_requests[0] : r.task_requests
    const eid = tr?.assigned_employee_id
    if (eid) empRevisionRequests.set(eid, (empRevisionRequests.get(eid) ?? 0) + 1)
  }

  // Team average tasks/month over employees with at least one task (for productivity)
  const perMonthAll: number[] = []
  empTasks.forEach(set => { if (set.size > 0) perMonthAll.push(set.size / WINDOW_MONTHS) })
  const teamAvgPerMonth = perMonthAll.length > 0 ? perMonthAll.reduce((a, b) => a + b, 0) / perMonthAll.length : 0

  const out: Record<string, AutoResult> = {}

  for (const emp of employees) {
    const taskIds = [...(empTasks.get(emp.id) ?? [])]
    const myTasks = taskIds.map(id => tasks.get(id)!).filter(Boolean)
    const total = myTasks.length
    const metrics: AutoMetric[] = []

    // 1 · Tenure
    let tenureScore: number | null = null
    let tenureDisplay = 'No joined date'
    if (emp.joined_date) {
      const years = (now.getTime() - new Date(emp.joined_date).getTime()) / (365.25 * 24 * 3600 * 1000)
      if (years >= 0) {
        tenureScore = clamp((years / TENURE_FULL_YEARS) * 100)
        tenureDisplay = `${round1(years)} yrs`
      }
    }
    metrics.push({ key: 'tenure', label: 'Tenure at Cirqle', display: tenureDisplay, score: tenureScore == null ? null : round1(tenureScore) })

    // 2 · Task completion %
    const doneCount = myTasks.filter(t => t.status && DONE_STATUSES.has(t.status)).length
    const completion = total > 0 ? (doneCount / total) * 100 : null
    metrics.push({
      key: 'completion', label: 'Task completion',
      display: total > 0 ? `${doneCount}/${total} tasks` : 'No tasks in window',
      score: completion == null ? null : round1(completion),
    })

    // 3 · On-time completion % (requests with a due date, assigned to them)
    const myReqs = requests.filter(r => r.assigned_employee_id === emp.id && r.due_date && REQUEST_DONE_STATUSES.has(r.status))
    const onTimeCount = myReqs.filter(r => r.status_updated_at.slice(0, 10) <= (r.due_date as string)).length
    const onTime = myReqs.length > 0 ? (onTimeCount / myReqs.length) * 100 : null
    metrics.push({
      key: 'on_time', label: 'On-time delivery',
      display: myReqs.length > 0 ? `${onTimeCount}/${myReqs.length} requests` : 'No dated requests',
      score: onTime == null ? null : round1(onTime),
    })

    // 4 · Rework / revision rate (revision-variant tasks + client revision requests)
    const revisionTasks = myTasks.filter(t => t.variant_type === 'revision').length
    const clientRevs = empRevisionRequests.get(emp.id) ?? 0
    const reworkBase = total + myReqs.length
    let reworkScore: number | null = null
    let reworkDisplay = 'No data'
    if (reworkBase > 0) {
      const rate = ((revisionTasks + clientRevs) / reworkBase) * 100
      reworkScore = clamp(100 - 2 * rate)     // 0% revisions = 100 · 10% = 80 · 50%+ = 0
      reworkDisplay = `${revisionTasks + clientRevs} revisions / ${reworkBase}`
    }
    metrics.push({ key: 'rework', label: 'Rework rate', display: reworkDisplay, score: reworkScore == null ? null : round1(reworkScore) })

    // 5 · Contribution output (the same score % Insights/Contribution Analysis uses)
    const outAgg = empOutput.get(emp.id)
    const output = outAgg && outAgg.n > 0 ? outAgg.sum / outAgg.n : null
    metrics.push({
      key: 'output', label: 'Contribution output',
      display: output != null ? `avg ${round1(output)}% over ${outAgg!.n}` : 'No contributions',
      score: output == null ? null : round1(clamp(output)),
    })

    // 6 · Productivity vs team average
    let prodScore: number | null = null
    let prodDisplay = 'No tasks in window'
    if (total > 0 && teamAvgPerMonth > 0) {
      const mine = total / WINDOW_MONTHS
      prodScore = clamp((mine / teamAvgPerMonth) * 100)
      prodDisplay = `${round1(mine)}/mo vs team ${round1(teamAvgPerMonth)}/mo`
    }
    metrics.push({ key: 'productivity', label: 'Productivity', display: prodDisplay, score: prodScore == null ? null : round1(prodScore) })

    // Composite over available metrics
    let wSum = 0, wTotal = 0
    for (const m of metrics) {
      if (m.score == null) continue
      const w = WEIGHTS[m.key] ?? 0
      wSum += m.score * w
      wTotal += w
    }
    out[emp.id] = { score: wTotal > 0 ? Math.round((wSum / wTotal) * 10) / 10 : null, metrics }
  }

  return out
}
