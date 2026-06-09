import { createAdminClient } from '@/lib/supabase/server'
import { matchAgreement, computeAgreementEarning, type CommissionAgreement } from '@/lib/calculations/agreements'

/**
 * Apply employee commission agreements to a task's stored earnings.
 *
 * MUST run AFTER the base contribution earnings are written (recalc / save):
 *  - it overrides matching employees' `earnings_inr` with the agreement value,
 *  - and tags every row's `earning_source` (agreement | contribution).
 * For non-agreement rows it only fixes the tag and leaves `earnings_inr` as the
 * base value the engine already computed.
 *
 * Fully defensive: if the agreements table doesn't exist yet (pre-migration) or
 * there are no active agreements, it is a complete no-op — the current system is
 * unchanged.
 */

export async function loadActiveAgreements(
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ available: boolean; agreements: CommissionAgreement[] }> {
  try {
    const { data, error } = await admin
      .from('employee_commission_agreements')
      .select('id, employee_id, client_id, service_id, agreement_type, agreement_value, currency, effective_from, effective_to, is_active')
      .eq('is_active', true)
    if (error) return { available: false, agreements: [] }
    return { available: true, agreements: (data || []) as CommissionAgreement[] }
  } catch {
    return { available: false, agreements: [] }
  }
}

export async function syncTaskAgreementEarnings(taskId: string): Promise<{ changed: number }> {
  const admin = createAdminClient()

  const { available, agreements } = await loadActiveAgreements(admin)
  if (!available) return { changed: 0 } // pre-migration / no table → no-op

  const { data: task } = await admin
    .from('tasks')
    .select('id, client_id, service_id, billing_amount_inr, task_date')
    .eq('id', taskId)
    .single()
  if (!task) return { changed: 0 }

  const { data: scores } = await admin
    .from('contribution_scores')
    .select('employee_id, score_percentage, earnings_inr, is_manual_override, earning_source, agreement_id')
    .eq('task_id', taskId)
  if (!scores || scores.length === 0) return { changed: 0 }

  // Fast exit: if no active agreement is even for one of these employees, skip
  // all the pool math (keeps the common case cheap).
  const empIds = new Set(scores.map(s => s.employee_id))
  const anyRelevant = agreements.some(a => empIds.has(a.employee_id))
  if (!anyRelevant) {
    // Still reset any stale agreement tags (rare), but no pool math needed.
    return await resetStaleTags(admin, taskId, scores)
  }

  // remainingPool — same derivation the engine / refreshStoredEarningsFromBilling use.
  let commPct = 50
  if (task.client_id && task.service_id) {
    const { data: pricing } = await admin
      .from('client_service_pricing')
      .select('commission_percentage')
      .eq('client_id', task.client_id)
      .eq('service_id', task.service_id)
      .maybeSingle()
    if (pricing?.commission_percentage != null) commPct = pricing.commission_percentage
  }
  let toolPct = 0
  const { data: taskTools } = await admin.from('task_tools').select('tool_id').eq('task_id', taskId)
  if (taskTools && taskTools.length) {
    const { data: tools } = await admin
      .from('tools').select('fixed_percentage, is_active').in('id', taskTools.map(t => t.tool_id))
    toolPct = (tools || []).reduce((s, t) => s + (t.is_active !== false ? Number(t.fixed_percentage) || 0 : 0), 0)
  }
  const billingInr = task.billing_amount_inr || 0
  const remainingPool = (billingInr * commPct / 100) * (1 - toolPct / 100)

  let changed = 0
  for (const s of scores) {
    if (s.is_manual_override) continue // manual overrides are never touched

    const eligible = (s.score_percentage || 0) > 0
    const ag = eligible
      ? matchAgreement(agreements, s.employee_id, task.client_id, task.service_id, task.task_date)
      : null

    if (ag) {
      const newEarn = computeAgreementEarning(ag, { billingInr, remainingPool })
      const needs =
        Math.abs((s.earnings_inr || 0) - newEarn) > 0.01 ||
        s.earning_source !== 'agreement' ||
        s.agreement_id !== ag.id
      if (needs) {
        await admin.from('contribution_scores')
          .update({ earnings_inr: newEarn, earning_source: 'agreement', agreement_id: ag.id })
          .eq('task_id', taskId).eq('employee_id', s.employee_id)
        changed++
      }
    } else if (s.earning_source !== 'contribution' || s.agreement_id != null) {
      // No agreement now → reset the tag (earnings_inr was already recomputed to
      // the base contribution value by the recompute step that ran before us).
      await admin.from('contribution_scores')
        .update({ earning_source: 'contribution', agreement_id: null })
        .eq('task_id', taskId).eq('employee_id', s.employee_id)
      changed++
    }
  }
  return { changed }
}

async function resetStaleTags(
  admin: ReturnType<typeof createAdminClient>,
  taskId: string,
  scores: { employee_id: string; earning_source?: string | null; agreement_id?: string | null; is_manual_override?: boolean | null }[],
): Promise<{ changed: number }> {
  let changed = 0
  for (const s of scores) {
    if (s.is_manual_override) continue
    if (s.earning_source === 'agreement' || s.agreement_id != null) {
      await admin.from('contribution_scores')
        .update({ earning_source: 'contribution', agreement_id: null })
        .eq('task_id', taskId).eq('employee_id', s.employee_id)
      changed++
    }
  }
  return { changed }
}
