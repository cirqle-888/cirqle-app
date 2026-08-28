/**
 * How a task bills, in one word — for lists, filters and totals.
 *
 * The Tasks table needed to answer "what is this client actually paying for?"
 * without opening rows one at a time, and "how much free work did we give
 * them?" without opening any. Both questions are the same question, so they are
 * answered by one index built from data the page already has:
 *
 *   waived   — free to the client (is_billable = false), whatever else is true.
 *              Checked first: a waived task inside a package is still free.
 *   covered  — inside a package's included allowance. No separate invoice line.
 *   extra    — linked to a package but beyond the allowance, so it bills at the
 *              agreed overage rate.
 *   billable — an ordinary task that bills on its own.
 *
 * The covered/extra split is the SAME verdict the invoice reaches, because it
 * comes from the same engine (`resolveCoverageForPackage`) rather than a second
 * guess at the rule. A task linked to a package whose services do not include
 * its own is reported `billable`, which is exactly what it does — the package
 * fee cannot cover a service the client never bought.
 */

import { resolveCoverageForPackage, taskMonth } from './progress'
import type { PackageItemRow, PackageTaskLike } from './types'
import { isWaivedTask } from '@/lib/tasks/billable'

export type TaskBillingStatus = 'waived' | 'covered' | 'extra' | 'billable'

/** The package fields the cycle maths needs, plus what identifies the row. */
export interface CoveragePackage {
  id: string
  billing_type: 'one_time' | 'monthly'
  start_date: string
  end_date?: string | null
  first_cycle_end?: string | null
}

export interface CoverageTask extends PackageTaskLike {
  package_id?: string | null
  is_billable?: boolean | null
}

/**
 * task id → 'covered' | 'extra', for every task linked to one of `packages`.
 *
 * Tasks with no package are absent from the map; `taskBillingStatus` reads them
 * as ordinary billable work. Waived tasks are excluded from the coverage input
 * entirely — free work must not consume the client's allowance, which is the
 * same rule auto-link follows when it declines to link them.
 */
export function buildCoverageIndex(
  packages: CoveragePackage[],
  items: PackageItemRow[],
  tasks: CoverageTask[],
): Map<string, 'covered' | 'extra'> {
  const index = new Map<string, 'covered' | 'extra'>()
  if (!packages.length) return index

  const itemsByPackage = new Map<string, PackageItemRow[]>()
  for (const it of items) {
    const arr = itemsByPackage.get(it.package_id)
    if (arr) arr.push(it)
    else itemsByPackage.set(it.package_id, [it])
  }

  const tasksByPackage = new Map<string, CoverageTask[]>()
  for (const t of tasks) {
    if (!t.package_id || isWaivedTask(t)) continue
    const arr = tasksByPackage.get(t.package_id)
    if (arr) arr.push(t)
    else tasksByPackage.set(t.package_id, [t])
  }

  for (const pkg of packages) {
    const pkgTasks = tasksByPackage.get(pkg.id)
    if (!pkgTasks?.length) continue
    const pkgItems = itemsByPackage.get(pkg.id) ?? []

    // A monthly package's allowance resets, so each month is resolved on its
    // own. A one-time package has a single all-time period; resolving it once
    // is enough, and resolving it per month would hand out one allowance per
    // month instead of one in total.
    const months = pkg.billing_type === 'monthly'
      ? [...new Set(pkgTasks.map(t => taskMonth(t.task_date)))]
      : [taskMonth(pkgTasks[0].task_date)]

    for (const month of months) {
      const coverage = resolveCoverageForPackage(pkg, pkgTasks, pkgItems, month)
      for (const id of coverage.coveredTaskIds) index.set(id, 'covered')
      for (const id of coverage.extraTaskIds) index.set(id, 'extra')
    }
  }

  return index
}

/** One task's verdict. `index` comes from `buildCoverageIndex`. */
export function taskBillingStatus(
  task: CoverageTask,
  index: Map<string, 'covered' | 'extra'>,
): TaskBillingStatus {
  if (isWaivedTask(task)) return 'waived'
  return index.get(task.id) ?? 'billable'
}

export const TASK_BILLING_LABEL: Record<TaskBillingStatus, string> = {
  waived:   'Waived',
  covered:  'Package',
  extra:    'Extra',
  billable: 'Billable',
}
