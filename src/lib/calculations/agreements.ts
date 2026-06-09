/**
 * Employee Commission Agreements — pure resolver (no DB, no side effects).
 *
 * An agreement REPLACES an employee's normal contribution-based earning on a
 * matching task, but only when the employee actually contributed
 * (score_percentage > 0). Everyone else is untouched. With no agreements, the
 * resolver is an identity function — the current system is unchanged.
 *
 * See COMMISSION_AGREEMENTS_DESIGN.md.
 */

export type AgreementType = 'fixed_per_task' | 'percentage_of_billing' | 'percentage_of_pool'
export type EarningSource = 'contribution' | 'agreement' | 'manual_override'

export interface CommissionAgreement {
  id: string
  employee_id: string
  client_id: string | null    // null = all clients
  service_id: string | null   // null = all services
  agreement_type: AgreementType
  agreement_value: number      // ₹ for fixed; % for percentage types
  currency?: string | null
  effective_from: string       // YYYY-MM-DD
  effective_to: string | null  // null = open-ended
  is_active: boolean
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** Specificity rank (lower = more specific, wins). */
function rank(a: CommissionAgreement): number {
  if (a.client_id && a.service_id) return 1   // exact client + service
  if (a.client_id) return 2                   // client-wide
  if (a.service_id) return 3                  // service-wide
  return 4                                    // global
}

/**
 * Pick the single best agreement for (employee, client, service, date).
 * Most-specific wins; tie-break by latest effective_from.
 */
export function matchAgreement(
  agreements: CommissionAgreement[],
  employeeId: string,
  clientId: string | null,
  serviceId: string | null,
  taskDateISO: string | null,
): CommissionAgreement | null {
  const date = (taskDateISO || '').slice(0, 10)
  const candidates = agreements.filter(a => {
    if (a.employee_id !== employeeId) return false
    if (!a.is_active) return false
    if (a.client_id && a.client_id !== clientId) return false
    if (a.service_id && a.service_id !== serviceId) return false
    if (date) {
      if (a.effective_from && date < a.effective_from.slice(0, 10)) return false
      if (a.effective_to && date > a.effective_to.slice(0, 10)) return false
    }
    return true
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    return (b.effective_from || '').localeCompare(a.effective_from || '')
  })
  return candidates[0]
}

/** Compute the ₹ earning an agreement produces for a task. */
export function computeAgreementEarning(
  a: CommissionAgreement,
  ctx: { billingInr: number; remainingPool: number },
): number {
  switch (a.agreement_type) {
    case 'fixed_per_task':        return r2(a.agreement_value)              // assumed INR (see design §10)
    case 'percentage_of_billing': return r2(ctx.billingInr * (a.agreement_value / 100))
    case 'percentage_of_pool':    return r2(ctx.remainingPool * (a.agreement_value / 100))
    default:                      return 0
  }
}

export interface ResolveInput {
  employeeId: string
  clientId: string | null
  serviceId: string | null
  taskDateISO: string | null
  scorePercentage: number      // the contribution score; agreement only applies when > 0
  normalEarning: number        // the contribution-based earning (engine output)
  isManualOverride?: boolean
  agreements: CommissionAgreement[]
  billingInr: number
  remainingPool: number
}

export interface ResolveResult {
  earnings: number
  source: EarningSource
  agreementId: string | null
}

/**
 * Final earning resolution. Precedence: manual override → agreement → contribution.
 * Agreement applies ONLY when scorePercentage > 0 (the "has a contribution
 * record" trigger) AND a matching active agreement exists.
 */
export function resolveEarning(input: ResolveInput): ResolveResult {
  if (input.isManualOverride) {
    return { earnings: input.normalEarning, source: 'manual_override', agreementId: null }
  }
  if (input.scorePercentage > 0 && input.agreements.length > 0) {
    const ag = matchAgreement(input.agreements, input.employeeId, input.clientId, input.serviceId, input.taskDateISO)
    if (ag) {
      return {
        earnings: computeAgreementEarning(ag, { billingInr: input.billingInr, remainingPool: input.remainingPool }),
        source: 'agreement',
        agreementId: ag.id,
      }
    }
  }
  return { earnings: input.normalEarning, source: 'contribution', agreementId: null }
}
