/**
 * What a package puts on an invoice.
 *
 * Pure — no database. Given the packages in force for a client-month and the
 * tasks linked to them, this decides:
 *
 *   • which package FEE lines the invoice should carry (one per package)
 *   • which tasks are covered by those fees, and so must NOT appear as their
 *     own line — the whole point of a package
 *   • which tasks are extra, and what each should be charged
 *
 * The caller reconciles the database against this answer. Keeping the decision
 * here means the invoice, the Packages page and the profit calculation all read
 * the same verdict from the same inputs.
 */

import { resolveCoverage, isPackageInForceForMonth, cycleForMonth, tasksInCycle, taskMonth } from './progress'
import type { BillingCycle } from './progress'
import type { PackageRow, PackageItemRow, PackageTaskLike } from './types'

/** A package fee line the invoice should carry. */
export interface PackageFeeLine {
  packageId: string
  /** Client-facing text — the package's own name. */
  description: string
  amount: number
  currency: string
  /** Dates the line, since a fee line has no task of its own to date it. */
  lineDate: string
}

/** A task billing on its own because it went beyond what's included. */
export interface ExtraTaskCharge {
  taskId: string
  packageId: string
  /**
   * Agreed overage rate, or null to leave the task at its normal
   * Pricing-Matrix price. Null is NOT zero — it means "don't override".
   */
  unitPrice: number | null
  currency: string
}

export interface PackageInvoicePlan {
  feeLines: PackageFeeLine[]
  /** Tasks the fees already pay for — no separate invoice line. */
  coveredTaskIds: Set<string>
  extras: ExtraTaskCharge[]
  /**
   * Linked to a package whose included services don't cover them. They bill
   * normally, like any unlinked task — the client never agreed to them as part
   * of the bundle.
   */
  unmatchedTaskIds: Set<string>
}

export interface PackageInvoiceInput {
  /** Every non-deleted package for this client. Filtered by term here. */
  packages: PackageRow[]
  /** package_id → its included lines. */
  itemsByPackage: Map<string, PackageItemRow[]>
  /** package_id → its linked tasks (ALL of them, not just this month's). */
  tasksByPackage: Map<string, PackageTaskLike[]>
  /** The invoice's billing month, `YYYY-MM`. */
  month: string
  /**
   * One-time packages that already carry a fee line on SOME invoice. They bill
   * exactly once, ever — without this a second month's invoice would charge the
   * one-off fee again.
   */
  oneTimeAlreadyBilled: Set<string>
  /**
   * package_id → billing months (`YYYY-MM`) of OTHER invoices that already
   * carry a fee line for it.
   *
   * Only the opening cycle reads this. That cycle spans several months and
   * bills once for the whole span, so "has it been billed?" cannot be answered
   * by the month alone — it has to look across the span. Regular monthly fees
   * don't need it: one line per (invoice, package) is already enforced.
   */
  feeLineMonths?: Map<string, Set<string>>
}

/**
 * Decide the package side of a client's invoice for one month.
 *
 * A fee line is added when:
 *   • monthly  — the package is in force for any part of that month, AND this
 *     is the month its cycle bills in (only ever different when an extended
 *     opening cycle spans more than one month — it bills once, up front)
 *   • one_time — in force, AND it has never been billed before
 *
 * `lineDate` is the earliest linked task in the period, falling back to the
 * package start date. That is what a reader expects: the fee sits with the work
 * it paid for, not at an arbitrary month boundary.
 */
export function planPackageInvoice(input: PackageInvoiceInput): PackageInvoicePlan {
  const feeLines: PackageFeeLine[] = []
  const coveredTaskIds = new Set<string>()
  const extras: ExtraTaskCharge[] = []
  const unmatchedTaskIds = new Set<string>()

  for (const pkg of input.packages) {
    if (!isPackageInForceForMonth(pkg, input.month)) continue

    const items = input.itemsByPackage.get(pkg.id) ?? []
    const tasks = input.tasksByPackage.get(pkg.id) ?? []
    const cycle = cycleForMonth(pkg, input.month)
    const cov = resolveCoverage(tasks, items, pkg.billing_type, input.month, cycle)

    // Coverage already scoped the tasks to the period, so these sets only ever
    // contain tasks that belong on this invoice.
    for (const id of cov.coveredTaskIds) coveredTaskIds.add(id)
    for (const id of cov.unmatchedTaskIds) unmatchedTaskIds.add(id)
    for (const id of cov.extraTaskIds) {
      extras.push({
        taskId: id,
        packageId: pkg.id,
        unitPrice: pkg.extra_task_price ?? null,
        currency: pkg.currency,
      })
    }

    // A one-time fee is charged once in the package's life, not once a month.
    if (pkg.billing_type === 'one_time' && input.oneTimeAlreadyBilled.has(pkg.id)) continue

    // An extended opening cycle is ONE cycle spanning several months, so it
    // carries one fee for the whole span. It is charged on the first invoice
    // that COVERS the span, not strictly on the month the package started —
    // that month may never have been invoiced at all (a package signed on 20
    // July whose first invoice is August's). Anchoring on the start month
    // instead would leave the opening fee permanently unbillable.
    //
    // "Once" is enforced by looking across the span: if another invoice inside
    // the cycle already carries the fee, this one must not add a second.
    if (cycle.isFirstCycle) {
      const endMonth = taskMonth(cycle.end)
      const billed = input.feeLineMonths?.get(pkg.id)
      const billedInThisCycle = billed
        && [...billed].some(m => m >= cycle.billingMonth && m <= endMonth)
      if (billedInThisCycle) continue
    } else if (cycle.billingMonth !== input.month) {
      // The later months of an ordinary span still cover their tasks (above);
      // they just don't bill again.
      continue
    }

    feeLines.push({
      packageId: pkg.id,
      // The opening cycle's line names its span. Without it the client sees one
      // month's invoice carrying a fee that silently covers two, which reads as
      // an overcharge.
      description: cycle.isFirstCycle
        ? `${pkg.name} — first cycle (${formatSpan(cycle.start, cycle.end)})`
        : pkg.name,
      amount: Number(pkg.price) || 0,
      currency: pkg.currency,
      // A one-time fee (and an opening cycle's fee) is dated to the day the
      // package was AGREED — that is the event being billed. Dating it to
      // whichever task happened to land first reads as if the commitment
      // started days later than it did. Ordinary monthly cycles keep the
      // earliest work of the month, which is what those fees pay for.
      lineDate: (pkg.billing_type === 'one_time' || cycle.isFirstCycle)
        ? pkg.start_date
        : (earliestTaskDate(tasks, cycle) ?? pkg.start_date),
    })
  }

  return { feeLines, coveredTaskIds, extras, unmatchedTaskIds }
}

/**
 * "20 Jul – 31 Aug 2026" — the year stated once when both ends share it.
 *
 * Deliberately plain-English rather than ISO: this string goes on the invoice
 * the client reads, not into a machine.
 */
function formatSpan(start: string, end: string): string {
  const fmt = (iso: string, withYear: boolean) => {
    const d = new Date(iso + 'T00:00:00')
    const day = d.getDate()
    const mon = d.toLocaleDateString('en-GB', { month: 'short' })
    return `${day} ${mon}${withYear ? ` ${d.getFullYear()}` : ''}`
  }
  const sameYear = start.slice(0, 4) === end.slice(0, 4)
  return `${fmt(start, !sameYear)} – ${fmt(end, true)}`
}

/** Earliest linked task date inside the cycle, or null when none was done. */
function earliestTaskDate(tasks: PackageTaskLike[], cycle: BillingCycle): string | null {
  const inPeriod = tasksInCycle(tasks, cycle)
  if (inPeriod.length === 0) return null
  return inPeriod.reduce(
    (min, t) => (String(t.task_date) < min ? String(t.task_date) : min),
    String(inPeriod[0].task_date),
  )
}

/**
 * What an extra task's invoice line should charge.
 *
 * Returns null when the package sets no overage rate, meaning "leave this task
 * at whatever the Pricing Matrix already gave it". Returning 0 there would
 * silently zero a billable task.
 */
export function extraTaskUnitPrice(
  extra: ExtraTaskCharge | undefined,
  matrixAmount: number,
): number {
  if (!extra || extra.unitPrice == null) return matrixAmount
  return extra.unitPrice
}
