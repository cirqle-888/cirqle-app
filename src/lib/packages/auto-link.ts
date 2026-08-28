/**
 * Auto-linking a task to the client's package.
 *
 * A task is only covered by a package fee if it carries that package's
 * `package_id` (see progress.ts — coverage is keyed off the column, because a
 * row-level trigger cannot count how many tasks came before it in the period).
 * That link used to be a manual tick in the task form, which meant every task a
 * designer started from My Work, every recurring occurrence and every shortcut
 * task billed the client separately for work their retainer had already paid
 * for. Nobody notices that until the invoice goes out.
 *
 * So the link is derived instead: if the client has an active package on the
 * task's date whose included services contain the task's service, the task is
 * delivered under it. That is the same question `activePackagesForClient`
 * already answers for the picker — this module only adds the decision and the
 * write, so the two can never disagree.
 *
 * Three rules keep it safe to run on any creation path:
 *
 *   1. An existing `package_id` is never overwritten. A human choice — or an
 *      earlier auto-link — always wins over a fresh guess.
 *   2. WAIVED tasks are never linked. Free work must not eat the client's
 *      allowance: a goodwill highlight icon would otherwise consume one of the
 *      15 posters they are paying for.
 *   3. The amount is never touched. Linking changes INVOICING only; the
 *      Pricing-Matrix value stays, which is what pays the designer.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { activePackagesForClient, type PackageOption } from './queries'
import { isBillableTask } from '@/lib/tasks/billable'

/**
 * Which of the client's active packages delivers this service — pure, so the
 * rule is testable without a database.
 *
 * Ambiguity is possible (two active packages both including the service) and is
 * resolved by taking the first, which `activePackagesForClient` orders newest
 * first: the package signed most recently is the one the work was sold under.
 * Deterministic beats clever — a manager can always re-point the task.
 */
export function pickPackageForTask(
  options: PackageOption[],
  serviceId: string | null | undefined,
): string | null {
  if (!serviceId) return null
  return options.find(p => p.serviceIds.includes(serviceId))?.id ?? null
}

/** The task fields the decision needs. */
export interface AutoLinkTaskLike {
  id: string
  client_id: string | null
  service_id: string | null
  task_date: string | null
  package_id: string | null
  is_billable?: boolean | null
  deleted_at?: string | null
}

/** Should this task even be considered? Pure half of `autoLinkTaskPackage`. */
export function isAutoLinkCandidate(task: AutoLinkTaskLike | null | undefined): boolean {
  if (!task) return false
  if (task.deleted_at) return false
  if (task.package_id) return false            // rule 1 — never overwrite
  if (!isBillableTask(task)) return false      // rule 2 — free work eats no allowance
  return !!task.client_id && !!task.service_id
}

const TASK_COLS = 'id, client_id, service_id, task_date, package_id, is_billable, deleted_at'

/**
 * Link one task to the client's package if there is one for it.
 *
 * Returns the package id it linked, or null when nothing applied. Never
 * throws — a task that fails to link is a task that bills normally, which is
 * the pre-existing behaviour and always recoverable by hand.
 */
export async function autoLinkTaskPackage(
  admin: SupabaseClient,
  taskId: string,
): Promise<string | null> {
  try {
    const { data } = await admin.from('tasks').select(TASK_COLS).eq('id', taskId).maybeSingle()
    const task = data as AutoLinkTaskLike | null
    if (!isAutoLinkCandidate(task)) return null

    const options = await activePackagesForClient(admin, task!.client_id, task!.task_date)
    const packageId = pickPackageForTask(options, task!.service_id)
    if (!packageId) return null

    // `.is('package_id', null)` makes the write itself the race guard: two
    // concurrent creation paths cannot both claim the task, and a manager who
    // picked a package a moment ago keeps their choice.
    const { data: linked } = await admin
      .from('tasks')
      .update({ package_id: packageId, updated_at: new Date().toISOString() })
      .eq('id', taskId)
      .is('package_id', null)
      .select('id')

    return linked?.length ? packageId : null
  } catch {
    return null
  }
}
