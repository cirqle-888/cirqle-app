export interface CommissionAgreement {
  id: string
  employee_id: string
  client_id: string | null
  service_id: string | null
  agreement_type: 'fixed_per_task' | 'percentage_of_billing' | 'percentage_of_pool'
  agreement_value: number
  currency: string
  effective_from: string
  effective_to: string | null
  is_active: boolean
  created_at: string
}

export interface ResolveEarningParams {
  employeeId: string
  taskDate: string
  clientId: string | null
  serviceId: string | null
  normalEarning: number
  isManualOverride: boolean
  agreements: CommissionAgreement[]
  billingAmountInr: number
  remainingPool: number
  rates?: Record<string, number>
}

export interface ResolvedEarning {
  earnings_inr: number
  earning_source: 'contribution' | 'agreement' | 'manual_override'
  agreement_id: string | null
}

function r2(val: number) {
  return Math.round(val * 100) / 100
}

export function resolveEarning(params: ResolveEarningParams): ResolvedEarning {
  const {
    employeeId,
    taskDate,
    clientId,
    serviceId,
    normalEarning,
    isManualOverride,
    agreements,
    billingAmountInr,
    remainingPool,
    rates = { INR: 1 }
  } = params

  if (isManualOverride) {
    return {
      earnings_inr: normalEarning,
      earning_source: 'manual_override',
      agreement_id: null
    }
  }

  // 1. Filter matching agreements for this employee and task context
  const activeAgreements = agreements.filter(a => {
    if (a.employee_id !== employeeId) return false
    if (!a.is_active) return false
    
    if (a.client_id && a.client_id !== clientId) return false
    if (a.service_id && a.service_id !== serviceId) return false
    
    if (a.effective_from > taskDate) return false
    if (a.effective_to && a.effective_to < taskDate) return false
    
    return true
  })

  if (activeAgreements.length === 0) {
    return {
      earnings_inr: normalEarning,
      earning_source: 'contribution',
      agreement_id: null
    }
  }

  // 2. Find the most specific agreement
  // Rank 1: Exact (client_id set, service_id set)
  // Rank 2: Client-wide (client_id set, service_id null)
  // Rank 3: Service-wide (client_id null, service_id set)
  // Rank 4: Global (client_id null, service_id null)
  const ranked = activeAgreements.map(a => {
    let rank = 4
    if (a.client_id && a.service_id) rank = 1
    else if (a.client_id && !a.service_id) rank = 2
    else if (!a.client_id && a.service_id) rank = 3

    return { ...a, rank }
  })

  // Sort by rank ascending, then by most recent effective_from descending, then created_at descending
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.effective_from !== b.effective_from) {
      return a.effective_from > b.effective_from ? -1 : 1
    }
    return a.created_at > b.created_at ? -1 : 1
  })

  const bestMatch = ranked[0]
  let calculatedEarning = 0

  if (bestMatch.agreement_type === 'fixed_per_task') {
    const rate = rates[bestMatch.currency] || 1
    calculatedEarning = Number(bestMatch.agreement_value) * rate
  } else if (bestMatch.agreement_type === 'percentage_of_billing') {
    const safePct = Math.min(100, Number(bestMatch.agreement_value))
    calculatedEarning = billingAmountInr * (safePct / 100)
  } else if (bestMatch.agreement_type === 'percentage_of_pool') {
    const safePct = Math.min(100, Number(bestMatch.agreement_value))
    calculatedEarning = remainingPool * (safePct / 100)
  }

  return {
    earnings_inr: r2(calculatedEarning),
    earning_source: 'agreement',
    agreement_id: bestMatch.id
  }
}
