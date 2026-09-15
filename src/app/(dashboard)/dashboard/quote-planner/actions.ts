'use server'

/**
 * Quote-plan server actions — the only write path for a plan.
 *
 * A plan is a hypothesis about money, not money. Nothing here writes to
 * `contributions`, `contribution_scores`, `payroll` or `client_service_pricing`.
 * If a plan is ever *applied* to real pricing that is a separate action with
 * its own guards, the way `reports/what-if/apply-actions.ts` does it.
 *
 * Note: a `'use server'` module may only EXPORT async functions. Input types
 * live in @/lib/quote-planner/types — exporting one from here would survive the
 * server-actions transform as a value reference and 500 the whole module.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission, loadCurrentUser } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import type { PlannedCost, PlanLine, PlanStatus, QuotePlan, ShareOverride } from '@/lib/quote-planner/types'

const REVALIDATE = '/dashboard/quote-planner'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** Save the whole plan in one go: head, lines, shares, ratings, costs. */
export async function saveQuotePlan(plan: QuotePlan): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.QUOTE_PLANNER_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const me = await loadCurrentUser().catch(() => null)

  try {
    const head = {
      client_id: plan.clientId,
      name: plan.name.trim() || 'Untitled plan',
      status: plan.status,
      currency: plan.currency,
      term_months: Math.max(0, Math.round(plan.termMonths)),
      include_overheads: plan.includeOverheads,
      quotation_id: plan.quotationId,
      notes: plan.notes || null,
      updated_at: new Date().toISOString(),
    }

    let planId = plan.id
    const isNew = !planId || planId.startsWith('new-')
    if (isNew) {
      const { data, error } = await admin
        .from('quote_plans')
        .insert({ ...head, created_by: me?.employeeId ?? null })
        .select('id')
        .single()
      if (error) return { ok: false, error: error.message }
      planId = (data as { id: string }).id
    } else {
      const { error } = await admin.from('quote_plans').update(head).eq('id', planId)
      if (error) return { ok: false, error: error.message }
    }

    // Children are replaced wholesale. A plan is small and always saved as a
    // whole from one screen, so diffing would add a second way for the parts
    // to disagree with each other for no gain.
    await admin.from('quote_plan_shares').delete().eq('plan_id', planId)
    await admin.from('quote_plan_ratings').delete().eq('plan_id', planId)
    await admin.from('quote_plan_costs').delete().eq('plan_id', planId)
    await admin.from('quote_plan_lines').delete().eq('plan_id', planId)

    const lineIdMap = new Map<string, string>()
    if (plan.lines.length) {
      const { data, error } = await admin
        .from('quote_plan_lines')
        .insert(plan.lines.map((l: PlanLine, i: number) => ({
          plan_id: planId,
          service_id: l.serviceId,
          monthly_quantity: l.monthlyQuantity,
          unit_price: l.unitPrice,
          currency: l.currency,
          commission_pct: l.commissionPct,
          display_order: i,
        })))
        .select('id, display_order')
      if (error) return { ok: false, error: error.message }
      for (const row of (data as { id: string; display_order: number }[]) || []) {
        const original = plan.lines[row.display_order]
        if (original) lineIdMap.set(original.id, row.id)
      }
    }

    const shares = plan.shares
      .filter((s: ShareOverride) => s.sharePct > 0 && lineIdMap.has(s.lineId))
      .map((s: ShareOverride) => ({
        plan_id: planId,
        line_id: lineIdMap.get(s.lineId)!,
        employee_id: s.employeeId,
        parameter_id: s.parameterId,
        share_pct: s.sharePct,
      }))
    if (shares.length) {
      const { error } = await admin.from('quote_plan_shares').insert(shares)
      if (error) return { ok: false, error: error.message }
    }

    const ratings = Object.entries(plan.ratings)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      .map(([employeeId, ratingPct]) => ({
        plan_id: planId, employee_id: employeeId, rating_pct: Math.max(0, Math.min(100, ratingPct)),
      }))
    if (ratings.length) {
      const { error } = await admin.from('quote_plan_ratings').insert(ratings)
      if (error) return { ok: false, error: error.message }
    }

    if (plan.costs.length) {
      const { error } = await admin.from('quote_plan_costs').insert(
        plan.costs.map((c: PlannedCost, i: number) => ({
          plan_id: planId, label: c.label.trim() || 'Cost',
          amount: c.amount, currency: c.currency, cadence: c.cadence, display_order: i,
        })),
      )
      if (error) return { ok: false, error: error.message }
    }

    revalidatePath(REVALIDATE)
    return { ok: true, data: { id: planId } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save the plan.' }
  }
}

/** Load one plan and everything under it. */
export async function loadQuotePlan(id: string): Promise<ActionResult<QuotePlan>> {
  const guard = await requireReadPermission(PERMS.QUOTE_PLANNER_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: head, error } = await admin
    .from('quote_plans').select('*').eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!head) return { ok: false, error: 'No such plan.' }

  const [lines, shares, ratings, costs] = await Promise.all([
    admin.from('quote_plan_lines').select('*').eq('plan_id', id).order('display_order'),
    admin.from('quote_plan_shares').select('*').eq('plan_id', id),
    admin.from('quote_plan_ratings').select('*').eq('plan_id', id),
    admin.from('quote_plan_costs').select('*').eq('plan_id', id).order('display_order'),
  ])

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const h = head as any
  return {
    ok: true,
    data: {
      id: h.id,
      clientId: h.client_id,
      name: h.name,
      status: h.status as PlanStatus,
      currency: h.currency,
      termMonths: Number(h.term_months) || 0,
      includeOverheads: Boolean(h.include_overheads),
      quotationId: h.quotation_id,
      notes: h.notes || '',
      lines: ((lines.data as any[]) || []).map(l => ({
        id: l.id,
        serviceId: l.service_id,
        monthlyQuantity: Number(l.monthly_quantity) || 0,
        unitPrice: Number(l.unit_price) || 0,
        currency: l.currency,
        matrixUnitPrice: null,   // re-resolved from the live matrix on open
        commissionPct: l.commission_pct === null ? 50 : Number(l.commission_pct),
        displayOrder: Number(l.display_order) || 0,
      })),
      shares: ((shares.data as any[]) || []).map(s => ({
        lineId: s.line_id, employeeId: s.employee_id,
        parameterId: s.parameter_id, sharePct: Number(s.share_pct) || 0,
      })),
      ratings: Object.fromEntries(((ratings.data as any[]) || [])
        .map(r => [r.employee_id, Number(r.rating_pct) || 0])),
      costs: ((costs.data as any[]) || []).map(c => ({
        id: c.id, label: c.label, amount: Number(c.amount) || 0,
        currency: c.currency, cadence: c.cadence,
      })),
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Soft-delete. A plan is a record of a decision; nothing is hard-deleted. */
export async function deleteQuotePlan(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.QUOTE_PLANNER_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin
    .from('quote_plans').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}
