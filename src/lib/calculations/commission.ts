import { Contribution, ContributionGroup, Parameter, Tool, Employee } from '@/types'

export interface TaskContributionInput {
  taskId: string
  billingAmountINR: number
  serviceCommissionPct: number  // from client_service_pricing
  employees: Employee[]
  groups: ContributionGroup[]
  parameters: Parameter[]
  toolsUsed: { tool: Tool; used: boolean }[]
  contributions: Contribution[]  // all employee contributions for this task
}

export interface EmployeeEarning {
  employeeId: string
  employeeName: string
  scorePercentage: number
  earnings: number
  groupBreakdown: { groupName: string; score: number; weight: number }[]
}

export interface TaskCalculationResult {
  totalBilling: number
  employeePool: number  // after service commission %
  toolDeductions: { toolName: string; groupName: string; amount: number }[]
  remainingPool: number
  employeeEarnings: EmployeeEarning[]
}

/**
 * Main commission calculation function
 *
 * Formula:
 *   Earning = RemainingPool × ContributionShare% × PerformanceRating%
 *
 * Per group, an employee's share is computed as:
 *   share = Σ (empValue[p] / totalValue[p]) × weight[p]   ← only active params (totalValue > 0)
 *         / Σ weight[p]                                    ← only active params
 *
 * Active params = parameters where at least one employee entered a value.
 * This prevents unused sub-parameters (revisions with 0 count) from diluting
 * the master % score.
 *
 * Group weights are RELATIVE importance values — they are normalized over the
 * active groups (step 1) and again in the final score (step 5), so any weight
 * combination yields scores on a 0–100 scale; weights never need to sum to 100.
 */
export function calculateCommission(input: TaskContributionInput): TaskCalculationResult {
  const {
    billingAmountINR,
    serviceCommissionPct,
    employees,
    groups,
    parameters,
    toolsUsed,
    contributions,
  } = input

  const employeePool = billingAmountINR * (serviceCommissionPct / 100)

  // ── Pre-compute per-param totals across all employees ───────────────────────
  const paramTotals: Record<string, number> = {}
  for (const param of parameters) {
    paramTotals[param.id] = contributions
      .filter(c => c.parameter_id === param.id)
      .reduce((sum, c) => sum + c.value, 0)
  }

  // A group "has data" when at least one of its params has any contribution.
  const groupHasData: Record<string, boolean> = {}
  for (const group of groups) {
    const params = parameters.filter(p => p.group_id === group.id)
    groupHasData[group.id] = params.some(p => (paramTotals[p.id] || 0) > 0)
  }

  // ── Step 1: Active groups and their raw portions of the pool ─────────────────
  // If only Design group is used → it gets 100% of pool.
  // If both Design + Variable are used → each gets share proportional to its weight.
  const activeGroups = groups.filter(g => groupHasData[g.id])
  const totalActiveWeight = activeGroups.reduce((s, g) => s + g.weight, 0)
  const groupActivePortion: Record<string, number> = {}  // groupId → % of pool (0-100)
  for (const g of activeGroups) {
    groupActivePortion[g.id] = totalActiveWeight > 0 ? (g.weight / totalActiveWeight) * 100 : 0
  }

  // ── Step 2: Tool deductions — flat % of total pool, charged to owning group ──
  // e.g. Ideogram (10%) always deducts 10% of pool, regardless of how many groups are active.
  const toolDeductionMap: Record<string, number> = {}   // groupId → total deduct %
  const toolDeductions: TaskCalculationResult['toolDeductions'] = []

  for (const { tool, used } of toolsUsed) {
    if (used && tool.group_id && groupActivePortion[tool.group_id] !== undefined) {
      toolDeductionMap[tool.group_id] = (toolDeductionMap[tool.group_id] || 0) + tool.fixed_percentage
      const group = groups.find(g => g.id === tool.group_id)
      // Flat deduction: pool × tool% — no group-weight scaling
      toolDeductions.push({
        toolName: tool.name,
        groupName: group?.name || '',
        amount: employeePool * tool.fixed_percentage / 100,
      })
    }
  }

  // ── Step 3: Effective group share = activePortion MINUS tool deduct % ────────
  // e.g. Design active (100%) + Ideogram (10%) → effectiveShare = 90%
  // e.g. Both active (Design 50%, Variable 50%) + Ideogram (10%) → Design = 40%, Variable = 50%
  const effectiveGroupWeights: Record<string, number> = {}
  for (const g of activeGroups) {
    const toolDeductPct = toolDeductionMap[g.id] || 0
    effectiveGroupWeights[g.id] = Math.max(0, groupActivePortion[g.id] - toolDeductPct)
  }

  // ── Per-employee earnings ───────────────────────────────────────────────────
  const employeeEarnings: EmployeeEarning[] = []

  for (const employee of employees) {
    const empContribs = contributions.filter(c => c.employee_id === employee.id)
    if (empContribs.length === 0) continue

    let totalScore = 0
    const groupBreakdown: EmployeeEarning['groupBreakdown'] = []

    for (const group of activeGroups) {
      const groupParams = parameters.filter(p => p.group_id === group.id)
      const effectiveWeight = effectiveGroupWeights[group.id]  // e.g. 90 or 40 or 50

      let empGroupScore = 0
      let activeWeightSum = 0   // sum of param weights that have any contribution

      for (const param of groupParams) {
        const totalVal = paramTotals[param.id] || 0
        if (totalVal === 0) continue  // param unused — skip

        activeWeightSum += param.weight

        const empContrib = empContribs.find(c => c.parameter_id === param.id)
        const empValue = empContrib?.value || 0
        empGroupScore += (empValue / totalVal) * param.weight
      }

      // normalizedGroupScore: employee's fraction of this group (0–1)
      const normalizedGroupScore = activeWeightSum > 0 ? empGroupScore / activeWeightSum : 0

      // Weighted contribution to total score = fraction × effectiveGroupShare%
      totalScore += normalizedGroupScore * effectiveWeight

      groupBreakdown.push({
        groupName: group.name,
        score: normalizedGroupScore * 100,
        weight: effectiveWeight,
      })
    }

    // activeGroupWeightSum = sum of effectiveGroupShares for active groups
    // e.g. Design only + Ideogram → 90   |   Both groups + Ideogram → 40+50=90   |   Both no tool → 100
    const activeGroupWeightSum = activeGroups
      .reduce((s, g) => s + (effectiveGroupWeights[g.id] || 0), 0)

    // normalizedScore: employee's overall share (0–1) of the remaining pool
    const normalizedScore = activeGroupWeightSum > 0 ? totalScore / activeGroupWeightSum : 0

    const totalToolDeductionsSoFar = toolDeductions.reduce((s, d) => s + d.amount, 0)
    const remainingPoolForEmp = employeePool - totalToolDeductionsSoFar
    const earnings = remainingPoolForEmp * normalizedScore * (employee.performance_rating / 100)

    employeeEarnings.push({
      employeeId: employee.id,
      employeeName: employee.name,
      scorePercentage: normalizedScore * 100,   // always 0–100 regardless of group weight sum
      earnings,
      groupBreakdown,
    })
  }

  const totalToolDeductions = toolDeductions.reduce((sum, t) => sum + t.amount, 0)

  return {
    totalBilling: billingAmountINR,
    employeePool,
    toolDeductions,
    remainingPool: employeePool - totalToolDeductions,
    employeeEarnings,
  }
}

/**
 * Convert contribution score to quality band
 */
export function getQualityBand(score: number): '100' | '76-99' | '51-75' | '26-50' | '0-25' {
  if (score >= 100) return '100'
  if (score >= 76) return '76-99'
  if (score >= 51) return '51-75'
  if (score >= 26) return '26-50'
  return '0-25'
}

/**
 * Calculate monthly performance score for rating suggestion
 * Quality 60% + Consistency 25% + Volume trend 15%
 */
export function calculatePerformanceScore(metrics: {
  avgScore: number
  activeDays: number
  totalWorkingDays: number
  totalCreatives: number
  prevMonthCreatives: number
}): { score: number; suggestion: string } {
  const qualityScore = metrics.avgScore * 0.6
  const consistencyScore = metrics.totalWorkingDays > 0
    ? (metrics.activeDays / metrics.totalWorkingDays) * 100 * 0.25
    : 0
  const volumeTrend = metrics.prevMonthCreatives > 0
    ? Math.min((metrics.totalCreatives / metrics.prevMonthCreatives) * 100, 120) * 0.15
    : 50 * 0.15

  const score = qualityScore + consistencyScore + volumeTrend

  let suggestion = ''
  if (score >= 85) suggestion = 'Excellent performance. Consider increasing rating by 5%.'
  else if (score >= 70) suggestion = 'Good performance. Maintain current rating.'
  else if (score >= 55) suggestion = 'Average performance. Review if needed.'
  else suggestion = 'Below average. Consider discussion and support.'

  return { score, suggestion }
}
