'use server'

/**
 * Financial Timeline actions — closing and reopening a month.
 *
 * Locking is the owner's "close the books" action. It is deliberately the ONLY
 * state transition here: a month is either open (everything recomputes live)
 * or locked (frozen). There is no draft/reviewed/approved pipeline, because
 * those states exist to coordinate multiple people and this ERP is run by one.
 *
 * Locking does two things:
 *   1. Freezes the profit snapshot for that month.
 *   2. Makes isMonthFinalized() true, which every money writer in the app
 *      already consults — so nothing else had to change to respect it.
 *
 * Permission: payroll.edit (the same right that finalises money elsewhere).
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { persistProfitSnapshot } from '@/lib/finance/profit'
import { recordAdjustments } from '@/lib/payroll/adjustments'

const REVALIDATE = '/dashboard/finance/months'
const MIGRATION = 'supabase/migrations/20260807090000_financial_core.sql'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

/**
 * Everything else in this feature degrades silently when the migration hasn't
 * been applied (profit still computes live, months still close via paid
 * payroll). Locking genuinely cannot, so say so in words the owner can act on
 * rather than surfacing a raw PostgREST 404.
 */
function friendlyError(message: string): string {
  return /does not exist|PGRST205|schema cache/i.test(message)
    ? `Period locking needs a database migration. Run ${MIGRATION} in the Supabase SQL editor, then try again.`
    : message
}

/**
 * Close a month: snapshot its profit, then lock it.
 *
 * Order matters — the snapshot is taken while the month is still open, because
 * persistProfitSnapshot computes from live data. Locking first would be
 * harmless today but reads as a trap for the next person.
 */
export async function lockMonth(
  month: number, year: number, reason?: string,
): Promise<ActionResult<{ snapshotted: boolean }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  const snap = await persistProfitSnapshot(admin, month, year)
    .catch(() => ({ ok: false as const }))

  const { error } = await admin.from('period_locks').insert({
    month, year, locked_by: guard.employeeId, reason: reason || null,
  })
  // Already locked is success, not an error — the books are closed either way.
  if (error && !/duplicate key|unique/i.test(error.message || '')) {
    return { ok: false, error: friendlyError(error.message || '') }
  }

  void logActivity({
    actorId: guard.employeeId, entityType: 'payroll', entityId: `${year}-${month}`,
    action: 'period_locked', detail: { month, year, reason: reason || null },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  revalidatePath('/dashboard/payroll')
  return { ok: true, data: { snapshotted: snap.ok } }
}

/**
 * Reopen a month.
 *
 * The profit snapshot is deliberately KEPT: it records what the books said
 * when they were closed, which is exactly the sort of history a correction
 * should be auditable against. Re-locking later reuses it rather than
 * silently rewriting the closed figures.
 *
 * Note this cannot reopen a month that has PAID payroll — that signal is
 * independent of the lock and still finalises the month, by design.
 */
export async function unlockMonth(month: number, year: number): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('period_locks').delete().eq('month', month).eq('year', year)
  if (error) return { ok: false, error: friendlyError(error.message || '') }

  void logActivity({
    actorId: guard.employeeId, entityType: 'payroll', entityId: `${year}-${month}`,
    action: 'period_unlocked', detail: { month, year },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  revalidatePath('/dashboard/payroll')
  return { ok: true }
}

/**
 * Re-scan a closed month for late corrections.
 *
 * Runs automatically whenever the Timeline is opened; this action is the
 * manual "check again now" for when a task was just backdated.
 */
export async function rescanAdjustments(month: number, year: number): Promise<ActionResult<{ recorded: number }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  try {
    const res = await recordAdjustments(admin, month, year)
    revalidatePath(REVALIDATE)
    return { ok: true, data: { recorded: res.recorded } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not scan for adjustments.' }
  }
}
