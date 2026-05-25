/**
 * Employee performance analytics — pure aggregation helpers.
 *
 * All functions are pure (no I/O, no DB, no React). They consume rows from
 * the `contributions` table (raw per-parameter inputs) and the dimension
 * tables (parameters, contribution_groups).
 *
 * ## Data architecture note
 * Raw `contributions` rows only exist for tasks saved after migration 008.
 * Historical tasks have `contribution_scores` (final score%) but no per-parameter
 * breakdown. Employees with taskCount < MIN_TASKS_FOR_BAND receive the
 * 'Insufficient' band — callers should render "N/A" rather than a misleading score.
 *
 * ## Math source of truth: commission.ts
 * The aggregation logic here mirrors `calculateCommission` exactly:
 *
 *   Per parameter p in task t:
 *     totalValue(p,t)    = Σ_employees contributions where parameter_id = p, task_id = t
 *     active             = totalValue > 0   (inactive params are skipped — same as commission.ts ~line 78)
 *     empShare(e,p,t)    = empValue(e,p,t) / totalValue(p,t)   (0–1)
 *
 *   Per group g in task t:
 *     activeParams       = params in g where totalValue > 0
 *     activeWeightSum(g,t) = Σ activeParams: param.weight
 *     empGroupScore(e,g,t) = Σ activeParams p: empShare(e,p,t) × p.weight
 *     normalizedGroupScore(e,g,t) = empGroupScore / activeWeightSum  (0–1)
 *
 * Analytics then average these per-task scores across the employee's task history.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** One row from contributions(task_id, employee_id, parameter_id, value). */
export interface ContribRow {
  task_id:      string
  employee_id:  string
  parameter_id: string
  value:        number
}

export interface Param {
  id:          string
  group_id:    string
  name:        string
  weight:      number
  is_master:   boolean
  input_type?: 'count' | 'percentage'
}

export interface Group {
  id:     string
  name:   string
  weight: number
}

/**
 * Strength on a single parameter.
 * score:     mean share (0–1) across tasks where this employee participated
 *            AND the parameter was active (totalValue > 0).
 * taskCount: how many qualifying tasks contributed to the score.
 */
export interface ParamStrength {
  score:     number  // 0.0 – 1.0
  taskCount: number
}

/**
 * Strength within a contribution group — weighted roll-up of parameter strengths,
 * mirroring commission.ts active-parameter normalization.
 */
export interface GroupStrength {
  score:     number  // 0.0 – 1.0
  taskCount: number
}

/**
 * Minimum task count before we assign a meaningful band.
 * Below this threshold we return 'Insufficient' to prevent misleading ratings
 * from 1–2 lucky tasks.
 */
export const MIN_TASKS_FOR_BAND = 3

export type StrengthBand = 'Expert' | 'Strong' | 'Developing' | 'Learning' | 'Insufficient'

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Build a lookup map: paramId → { [taskId]: { [employeeId]: value } } */
function buildParamTaskEmpMap(
  contributions: ContribRow[],
): Map<string, Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, Map<string, number>>>()

  for (const row of contributions) {
    let byTask = result.get(row.parameter_id)
    if (!byTask) { byTask = new Map(); result.set(row.parameter_id, byTask) }

    let byEmp = byTask.get(row.task_id)
    if (!byEmp) { byEmp = new Map(); byTask.set(row.task_id, byEmp) }

    byEmp.set(row.employee_id, (byEmp.get(row.employee_id) ?? 0) + row.value)
  }
  return result
}

/** Sum all values in a map. */
function sumMap(m: Map<string, number>): number {
  let s = 0; m.forEach(v => { s += v }); return s
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Aggregate each employee's strength per parameter.
 *
 * Returns: { [employeeId]: { [parameterId]: ParamStrength } }
 *
 * Algorithm (per parameter p):
 *   For each task t where p is active (totalValue > 0):
 *     empShare = empValue(e,p,t) / totalValue(p,t)
 *   score(e,p) = mean empShare across tasks where e participated on p and p was active
 */
export function aggregateEmployeeByParameter(
  contributions: ContribRow[],
  parameters: Param[],
): Record<string, Record<string, ParamStrength>> {
  const result: Record<string, Record<string, ParamStrength>> = {}

  // paramId → Set of employee IDs seen (to pre-populate result keys)
  const seenEmployees = new Set<string>()
  contributions.forEach(r => seenEmployees.add(r.employee_id))
  seenEmployees.forEach(eid => { result[eid] = {} })

  const paramMap = buildParamTaskEmpMap(contributions)

  for (const param of parameters) {
    const byTask = paramMap.get(param.id)
    if (!byTask) continue  // no contributions for this param at all

    // Accumulator: employeeId → { sumShare, count }
    const acc = new Map<string, { sumShare: number; count: number }>()

    byTask.forEach((empMap, _taskId) => {
      const totalVal = sumMap(empMap)
      if (totalVal <= 0) return  // inactive param on this task — skip (commission.ts rule)

      empMap.forEach((empVal, empId) => {
        const share = empVal / totalVal            // 0–1; can exceed 1 if totalVal oddly <1
        const cur = acc.get(empId) ?? { sumShare: 0, count: 0 }
        acc.set(empId, { sumShare: cur.sumShare + share, count: cur.count + 1 })
      })
    })

    acc.forEach(({ sumShare, count }, empId) => {
      if (!result[empId]) result[empId] = {}
      result[empId][param.id] = {
        score:     count > 0 ? sumShare / count : 0,
        taskCount: count,
      }
    })
  }

  return result
}

/**
 * Aggregate each employee's strength per contribution group.
 *
 * This is the per-group weighted roll-up from commission.ts:
 *   normalizedGroupScore(e,g,t)
 *     = Σ_activeParams (empShare × param.weight) / activeWeightSum
 *
 * Returns: { [employeeId]: { [groupId]: GroupStrength } }
 */
export function aggregateEmployeeByGroup(
  contributions: ContribRow[],
  parameters: Param[],
  groups: Group[],
): Record<string, Record<string, GroupStrength>> {
  const result: Record<string, Record<string, GroupStrength>> = {}

  if (contributions.length === 0) return result

  // Build fast lookups
  const paramById = new Map(parameters.map(p => [p.id, p]))
  const paramsByGroup = new Map<string, Param[]>()
  for (const p of parameters) {
    const arr = paramsByGroup.get(p.group_id) ?? []
    arr.push(p)
    paramsByGroup.set(p.group_id, arr)
  }

  // Collect all unique task IDs that have any contributions
  const allTaskIds = new Set(contributions.map(r => r.task_id))

  // Pre-index contributions: taskId → paramId → employeeId → value
  const taskParamEmp = new Map<string, Map<string, Map<string, number>>>()
  for (const row of contributions) {
    let byParam = taskParamEmp.get(row.task_id)
    if (!byParam) { byParam = new Map(); taskParamEmp.set(row.task_id, byParam) }
    let byEmp = byParam.get(row.parameter_id)
    if (!byEmp) { byEmp = new Map(); byParam.set(row.parameter_id, byEmp) }
    byEmp.set(row.employee_id, (byEmp.get(row.employee_id) ?? 0) + row.value)
  }

  // Accumulator: [empId][groupId] → { sumScore, count }
  const acc = new Map<string, Map<string, { sumScore: number; count: number }>>()
  const ensureAcc = (empId: string, groupId: string) => {
    if (!acc.has(empId)) acc.set(empId, new Map())
    const gMap = acc.get(empId)!
    if (!gMap.has(groupId)) gMap.set(groupId, { sumScore: 0, count: 0 })
    return gMap.get(groupId)!
  }

  for (const taskId of allTaskIds) {
    const byParam = taskParamEmp.get(taskId)
    if (!byParam) continue

    for (const group of groups) {
      const groupParams = paramsByGroup.get(group.id) ?? []

      // Active params = those with totalValue > 0 on this task (commission.ts rule)
      let activeWeightSum = 0
      const activeParams: Array<{ param: Param; totalVal: number }> = []
      for (const param of groupParams) {
        const empMap = byParam.get(param.id)
        if (!empMap) continue
        const totalVal = sumMap(empMap)
        if (totalVal <= 0) continue
        activeWeightSum += param.weight
        activeParams.push({ param, totalVal })
      }
      if (activeWeightSum <= 0 || activeParams.length === 0) continue

      // Collect all employees who touched this group on this task
      const empIds = new Set<string>()
      for (const { param } of activeParams) {
        const empMap = byParam.get(param.id)
        empMap?.forEach((_, empId) => empIds.add(empId))
      }

      for (const empId of empIds) {
        // empGroupScore = Σ active params: (empValue/totalValue) × param.weight
        let empGroupScore = 0
        for (const { param, totalVal } of activeParams) {
          const empMap = byParam.get(param.id)
          const empVal = empMap?.get(empId) ?? 0
          empGroupScore += (empVal / totalVal) * param.weight
        }

        // normalizedGroupScore: employee's fraction of this group (0–1)
        const normalizedGroupScore = empGroupScore / activeWeightSum

        const slot = ensureAcc(empId, group.id)
        slot.sumScore += normalizedGroupScore
        slot.count    += 1
      }
    }
  }

  acc.forEach((gMap, empId) => {
    if (!result[empId]) result[empId] = {}
    gMap.forEach(({ sumScore, count }, groupId) => {
      result[empId][groupId] = {
        score:     count > 0 ? sumScore / count : 0,
        taskCount: count,
      }
    })
  })

  return result
}

/**
 * Infer the production owner for a single task.
 *
 * Algorithm:
 *   1. dominant group = group whose parameters had the highest total contribution sum.
 *   2. master param of dominant group = param with is_master = true (fallback: highest weight).
 *   3. production owner = employee with highest value on that master param.
 *   4. confidence = topValue / secondValue (capped at 10.0). Returns null if no contributions.
 */
export function inferProductionOwner(
  taskId: string,
  contributions: ContribRow[],
  parameters: Param[],
): { employeeId: string; confidence: number } | null {
  const taskRows = contributions.filter(r => r.task_id === taskId)
  if (taskRows.length === 0) return null

  const paramById = new Map(parameters.map(p => [p.id, p]))

  // Step 1: sum by group
  const groupTotals = new Map<string, number>()
  for (const row of taskRows) {
    const param = paramById.get(row.parameter_id)
    if (!param) continue
    groupTotals.set(param.group_id, (groupTotals.get(param.group_id) ?? 0) + row.value)
  }
  if (groupTotals.size === 0) return null

  // dominant group = argmax by total
  let dominantGroupId = ''
  let maxGroupTotal = -Infinity
  groupTotals.forEach((total, groupId) => {
    if (total > maxGroupTotal) { maxGroupTotal = total; dominantGroupId = groupId }
  })

  // Step 2: master param of dominant group
  const groupParams = parameters.filter(p => p.group_id === dominantGroupId)
  const masterParam =
    groupParams.find(p => p.is_master) ??
    groupParams.sort((a, b) => b.weight - a.weight)[0]

  if (!masterParam) return null

  // Step 3: employee with highest value on master param for this task
  const masterRows = taskRows.filter(r => r.parameter_id === masterParam.id)
  if (masterRows.length === 0) return null

  masterRows.sort((a, b) => b.value - a.value)
  const top    = masterRows[0]
  const second = masterRows[1]

  const confidence = second && second.value > 0
    ? Math.min(10, top.value / second.value)
    : 10  // sole contributor — maximum confidence

  return { employeeId: top.employee_id, confidence }
}

/**
 * Map a normalized score (0–1) and task count to a strength band.
 *
 * Bands align with team-relative performance expectations:
 *   Insufficient: < MIN_TASKS_FOR_BAND tasks — not enough evidence
 *   Learning:     0 – <0.25   (rarely handles this parameter solo)
 *   Developing:   0.25 – <0.50 (handles ~¼ to ½ of work when present)
 *   Strong:       0.50 – <0.75 (handles majority when present)
 *   Expert:       0.75 – 1.0  (dominates when present)
 */
export function bandStrength(score: number, taskCount: number): StrengthBand {
  if (taskCount < MIN_TASKS_FOR_BAND) return 'Insufficient'
  if (score >= 0.75) return 'Expert'
  if (score >= 0.50) return 'Strong'
  if (score >= 0.25) return 'Developing'
  return 'Learning'
}

/**
 * Team coverage / bus-factor risk for a single parameter.
 *
 * strongCount: employees at Strong or Expert band.
 * totalCount:  employees with any data for this parameter (Insufficient counts).
 * risk:        'high' if 0–1 strong, 'medium' if 2, 'low' if 3+.
 */
export function teamCoverage(
  aggregated: ReturnType<typeof aggregateEmployeeByParameter>,
  parameterId: string,
): { strongCount: number; totalCount: number; risk: 'high' | 'medium' | 'low' } {
  let strongCount = 0
  let totalCount  = 0

  for (const empData of Object.values(aggregated)) {
    const ps = empData[parameterId]
    if (!ps) continue
    totalCount++
    const band = bandStrength(ps.score, ps.taskCount)
    if (band === 'Strong' || band === 'Expert') strongCount++
  }

  const risk: 'high' | 'medium' | 'low' =
    strongCount <= 1 ? 'high' :
    strongCount === 2 ? 'medium' : 'low'

  return { strongCount, totalCount, risk }
}

/**
 * Convenience: produce the team-wide coverage report for every parameter.
 *
 * Useful for the "Team Coverage" widget — one pass over all parameters.
 */
export function teamCoverageReport(
  aggregated: ReturnType<typeof aggregateEmployeeByParameter>,
  parameters: Param[],
): Array<{
  parameterId: string
  parameterName: string
  groupId: string
  strongCount: number
  totalCount: number
  risk: 'high' | 'medium' | 'low'
}> {
  return parameters.map(p => ({
    parameterId:   p.id,
    parameterName: p.name,
    groupId:       p.group_id,
    ...teamCoverage(aggregated, p.id),
  }))
}

/**
 * Per-employee summary: top strengths, growth area, versatility.
 *
 * topStrengths:  up to 3 parameters sorted by score descending (Expert/Strong only).
 * growthArea:    lowest-scored parameter where taskCount ≥ MIN_TASKS_FOR_BAND (meaningful gap).
 * versatility:  fraction of available parameters this employee has worked on (taskCount ≥ 1).
 */
export function employeeSummary(
  employeeId: string,
  aggregated: ReturnType<typeof aggregateEmployeeByParameter>,
  parameters: Param[],
): {
  topStrengths: Array<{ parameterId: string; parameterName: string; score: number; band: StrengthBand }>
  growthArea:   { parameterId: string; parameterName: string; score: number; band: StrengthBand } | null
  versatility:  { active: number; total: number; fraction: number }
} {
  const empData = aggregated[employeeId] ?? {}
  const total   = parameters.length

  const ranked = parameters
    .map(p => {
      const ps   = empData[p.id]
      const band = ps ? bandStrength(ps.score, ps.taskCount) : 'Insufficient'
      return { parameterId: p.id, parameterName: p.name, score: ps?.score ?? 0, taskCount: ps?.taskCount ?? 0, band }
    })
    .filter(r => r.taskCount > 0)
    .sort((a, b) => b.score - a.score)

  const topStrengths = ranked
    .filter(r => r.band === 'Expert' || r.band === 'Strong')
    .slice(0, 3)
    .map(({ parameterId, parameterName, score, band }) => ({ parameterId, parameterName, score, band }))

  // Growth area = lowest meaningful score (enough task history, not already Expert)
  const growthCandidates = ranked
    .filter(r => r.taskCount >= MIN_TASKS_FOR_BAND && r.band !== 'Expert')
    .sort((a, b) => a.score - b.score)
  const growthArea = growthCandidates[0]
    ? { parameterId: growthCandidates[0].parameterId, parameterName: growthCandidates[0].parameterName,
        score: growthCandidates[0].score, band: growthCandidates[0].band }
    : null

  const active      = ranked.length
  const versatility = { active, total, fraction: total > 0 ? active / total : 0 }

  return { topStrengths, growthArea, versatility }
}

/**
 * Trend data: monthly mean strength on a specific parameter for an employee.
 *
 * Requires `contributions` rows to include a `task_date` field on the task.
 * Call site should join contributions with tasks.task_date before calling.
 *
 * Returns months sorted ascending with the mean share that month.
 * Months with no data are omitted (sparse series — chart should handle gaps).
 */
export function parameterTrend(
  employeeId: string,
  parameterId: string,
  contributions: (ContribRow & { task_date: string })[],
): Array<{ month: string; score: number; taskCount: number }> {
  // Accumulate: "YYYY-MM" → { sumShare, count }
  const monthly = new Map<string, { sumShare: number; count: number }>()

  // Group by task to compute per-task share first (avoid double-counting multi-row tasks)
  const byTask = new Map<string, ContribRow[]>()
  for (const row of contributions) {
    if (row.parameter_id !== parameterId) continue
    const arr = byTask.get(row.task_id) ?? []
    arr.push(row)
    byTask.set(row.task_id, arr)
  }

  // For each task where this param was active, compute share
  byTask.forEach((rows, taskId) => {
    const totalVal = rows.reduce((s, r) => s + r.value, 0)
    if (totalVal <= 0) return  // inactive — skip

    const empRow = rows.find(r => r.employee_id === employeeId)
    if (!empRow) return

    const share = empRow.value / totalVal

    // task_date comes from the enriched row — use task_date not calculated_at
    const taskRow = contributions.find(r => r.task_id === taskId && r.parameter_id === parameterId)
    const taskDate = (taskRow as any)?.task_date ?? ''
    if (!taskDate) return

    const month = taskDate.slice(0, 7)  // "YYYY-MM"
    const cur = monthly.get(month) ?? { sumShare: 0, count: 0 }
    monthly.set(month, { sumShare: cur.sumShare + share, count: cur.count + 1 })
  })

  return [...monthly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { sumShare, count }]) => ({
      month,
      score:     count > 0 ? sumShare / count : 0,
      taskCount: count,
    }))
}
