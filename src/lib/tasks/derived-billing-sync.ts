/**
 * Derived Billing — the write side.
 *
 * Keeps a derived task's amount in step with the tasks it bills from. The
 * arithmetic lives in `./derived-billing` (shared with the form's preview);
 * this module owns WHEN it may run and WHAT it cascades into.
 *
 * Two entry points:
 *   • recomputeDerivedTask   — one derived task, e.g. after its rule changed.
 *   • resyncDerivedForSource — fan-in: a SOURCE task moved, so find the derived
 *                              tasks reading it and recompute each.
 *
 * ── Freeze doctrine ─────────────────────────────────────────────────────────
 * A derived amount stops moving once it has been acted on commercially:
 * manually locked, billed to the client, or paid out to contributors. This
 * mirrors the fee-line and work-value rules elsewhere in the app — a figure
 * that someone has already been invoiced or paid from must never be rewritten
 * by a later edit upstream.
 *
 * ── Recursion ───────────────────────────────────────────────────────────────
 * Structurally impossible: `isBasisTask` rejects derived tasks, so a recompute
 * only ever reads ordinary rows, and `resyncDerivedForSource` no-ops when the
 * source is itself derived. Nothing here can trigger itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity/log'
import { isTaskMonthProtected } from '@/lib/payroll/compute'
import { recalcTaskCommissions, syncDraftInvoices } from '@/lib/sync/integrity'
import {
  parseBillingRule, monthRange, isBasisTask, sumBasis, computeRule,
  isDerivedTask, isFrozenByStatus,
  type BillingRule, type BasisTaskLike,
} from './derived-billing'

/* eslint-disable @typescript-eslint/no-explicit-any -- the tasks columns used
   here (billing_rule) post-date the generated Database types. */
type Admin = SupabaseClient<any, any, any>

const TASK_FIELDS =
  'id, task_number, title, client_id, service_id, task_date, status, quantity, deleted_at, ' +
  'billing_mode, billing_rule, billing_amount, billing_amount_inr, currency'

export interface RecomputeOutcome {
  ok: boolean
  /** Why nothing was written, when ok === false. */
  reason?: 'not-found' | 'not-derived' | 'invalid-rule' | 'locked' | 'billed' | 'payroll-finalized'
  changed?: boolean
  fromInr?: number
  toInr?: number
  basisCount?: number
}

/** Is this derived task's own invoice past the point of editing? */
async function isOnIssuedInvoice(admin: Admin, taskId: string): Promise<boolean> {
  try {
    const { data: lines } = await admin
      .from('invoice_items').select('invoice_id').eq('task_id', taskId)
    const ids = (lines ?? []).map((l: any) => l.invoice_id).filter(Boolean)
    if (ids.length === 0) return false
    const { data: invs } = await admin.from('invoices').select('id, status').in('id', ids)
    return (invs ?? []).some((i: any) => !['draft', 'reviewed'].includes(i.status))
  } catch {
    return true // unreadable → fail closed, leave the amount alone
  }
}

/**
 * Recompute ONE derived task and cascade.
 *
 * `trigger` is a short human phrase ("task #1901 saved") recorded on the
 * activity timeline, so "why did this change?" is answerable from the UI
 * without a diffing engine.
 */
export async function recomputeDerivedTask(
  admin: Admin,
  taskId: string,
  trigger: string,
  actorId?: string | null,
): Promise<RecomputeOutcome> {
  const { data: taskRow } = await admin.from('tasks').select(TASK_FIELDS).eq('id', taskId).maybeSingle()
  const task = taskRow as any
  if (!task) return { ok: false, reason: 'not-found' }
  if (!isDerivedTask(task)) return { ok: false, reason: 'not-derived' }

  const parsed = parseBillingRule((task as any).billing_rule)
  if (!parsed.ok) return { ok: false, reason: 'invalid-rule' }
  const rule: BillingRule = parsed.rule

  // ── Freeze checks, cheapest first ──────────────────────────────────────────
  if (rule.override) return { ok: false, reason: 'locked' }
  if (isFrozenByStatus((task as any).status)) return { ok: false, reason: 'billed' }
  if (await isTaskMonthProtected(admin as any, (task as any).task_date)) {
    return { ok: false, reason: 'payroll-finalized' }
  }
  if (await isOnIssuedInvoice(admin, taskId)) return { ok: false, reason: 'billed' }

  const taskDate: string | null = (task as any).task_date
  if (!taskDate) return { ok: false, reason: 'invalid-rule' }

  // ── Basis ──────────────────────────────────────────────────────────────────
  // Narrow in SQL (client + month + source services), then apply the SHARED
  // predicate so the server and the form's preview can never disagree.
  const { start, endExclusive } = monthRange(taskDate)
  const { data: candidates } = await admin
    .from('tasks')
    .select(TASK_FIELDS)
    .eq('client_id', (task as any).client_id)
    .in('service_id', rule.sources.serviceIds)
    .gte('task_date', start)
    .lt('task_date', endExclusive)
    .is('deleted_at', null)

  const ctx = { id: taskId, clientId: (task as any).client_id, taskDate, rule }
  const basisTasks = ((candidates ?? []) as unknown as BasisTaskLike[]).filter(t => isBasisTask(t, ctx))
  const basis = sumBasis(basisTasks)
  const computed = computeRule(rule, basis)

  const billingAmount = computed.billingAmount
  const billingAmountInr = computed.billingAmountInr

  const fromInr = Number((task as any).billing_amount_inr) || 0
  const changed = Math.abs(fromInr - billingAmountInr) > 0.005
    || Math.abs((Number((task as any).billing_amount) || 0) - billingAmount) > 0.005

  const snapshot = {
    mode: 'percent_of_services',
    method: rule.method,
    percent: rule.percent,
    source_service_ids: rule.sources.serviceIds,
    basis_task_ids: basis.taskIds,
    basis_count: basis.count,
    basis_sum_inr: basis.inr,
    basis_sum_native: basis.native,
    basis_currency: basis.uniformCurrency,
    clamps: rule.clamps ?? null,
    computed_amount: billingAmount,
    computed_amount_inr: billingAmountInr,
    currency: computed.currency,
    trigger,
    computed_at: new Date().toISOString(),
  }

  const { error } = await admin.from('tasks').update({
    billing_amount: billingAmount,
    billing_amount_inr: billingAmountInr,
    currency: computed.currency,
    quantity: 1,               // a fee is one line; the invoice rate = amount
    billing_snapshot: snapshot,
  }).eq('id', taskId)
  if (error) return { ok: false, reason: 'invalid-rule' }

  if (changed) {
    void logActivity({
      actorId: actorId ?? null,
      entityType: 'task',
      entityId: taskId,
      action: 'billing_recomputed',
      detail: {
        title: (task as any).title,
        from_inr: fromInr,
        to_inr: billingAmountInr,
        percent: rule.percent,
        basis_count: basis.count,
        basis_sum_inr: basis.inr,
        trigger,
      },
    })

    await syncDraftInvoices(taskId)
    await recalcTaskCommissions(taskId, actorId ?? undefined)
  }

  return { ok: true, changed, fromInr, toInr: billingAmountInr, basisCount: basis.count }
}

/**
 * A source task changed — recompute every derived task that reads it.
 *
 * Scope is (client, month, service): the GIN index on the rule's serviceIds
 * makes the lookup cheap enough to run on every task write.
 */
export async function resyncDerivedForSource(
  admin: Admin,
  source: {
    clientId?: string | null
    serviceId?: string | null
    taskDate?: string | null
    /** Skip when the changed task is itself derived — they never chain. */
    billingMode?: string | null
  },
  trigger: string,
  actorId?: string | null,
): Promise<{ recomputed: number }> {
  if (!source.clientId || !source.serviceId || !source.taskDate) return { recomputed: 0 }
  if (source.billingMode === 'percent_of_services') return { recomputed: 0 }

  const { start, endExclusive } = monthRange(source.taskDate)

  let derived: any[] = []
  try {
    const { data } = await admin
      .from('tasks')
      .select('id, billing_rule')
      .eq('client_id', source.clientId)
      .eq('billing_mode', 'percent_of_services')
      .gte('task_date', start)
      .lt('task_date', endExclusive)
      .is('deleted_at', null)
      // JSONB array containment — matches the partial GIN index from
      // migration 20260808110000.
      .contains('billing_rule->sources->serviceIds', [source.serviceId])
    derived = data ?? []
  } catch {
    return { recomputed: 0 } // pre-migration (no billing_rule column) → no-op
  }

  let recomputed = 0
  for (const d of derived) {
    const res = await recomputeDerivedTask(admin, d.id, trigger, actorId)
    if (res.ok && res.changed) recomputed++
  }
  return { recomputed }
}

/**
 * Convenience for the task actions: resync for a task's CURRENT scope and, when
 * it moved client/service/month, its previous one too — otherwise the old
 * month's derived task keeps counting a task that left it.
 */
export async function resyncDerivedForMovedTask(
  admin: Admin,
  before: { clientId?: string | null; serviceId?: string | null; taskDate?: string | null; billingMode?: string | null } | null,
  after: { clientId?: string | null; serviceId?: string | null; taskDate?: string | null; billingMode?: string | null },
  trigger: string,
  actorId?: string | null,
): Promise<void> {
  await resyncDerivedForSource(admin, after, trigger, actorId)

  if (!before) return
  const movedScope =
    before.clientId !== after.clientId ||
    before.serviceId !== after.serviceId ||
    (before.taskDate ?? '').slice(0, 7) !== (after.taskDate ?? '').slice(0, 7)
  if (movedScope) {
    await resyncDerivedForSource(admin, before, trigger, actorId)
  }
}
