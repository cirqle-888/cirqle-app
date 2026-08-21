/**
 * What an agreement line actually paid for.
 *
 * A package fee REPLACES the task lines it covers (see sync-invoice step 2), so
 * by the time an invoice is rendered the covered work has no rows of its own.
 * That is correct billing but opaque reading: the client sees
 * "Social Media Management — AED 400" with nothing showing the posts behind it.
 *
 * This rebuilds that list from the packages, for DISPLAY ONLY. Nothing here
 * bills, prices, or writes — the covered tasks carry internal work values in
 * whatever currency the Pricing Matrix gave them, which is precisely why they
 * must never be shown as amounts on a client-facing invoice.
 *
 * Pure, so the invoice page, the PDF and any future export all read the same
 * verdict from the same inputs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCoverageForPackage, isPackageInForceForMonth, cycleForMonth } from './progress'
import type { PackageRow, PackageItemRow, PackageTaskLike } from './types'

/** One delivered task sitting inside an agreement's allowance. */
export interface CoveredTask {
  id: string
  title: string
  taskDate: string | null
  serviceId: string | null
  serviceName: string
  status: string | null
}

/** Per included service: how much of the allowance this period consumed. */
export interface AllowanceLine {
  serviceId: string
  serviceName: string
  included: number
  delivered: number
  remaining: number
  extra: number
}

export interface AgreementBreakdown {
  packageId: string
  packageName: string
  billingType: PackageRow['billing_type']
  currency: string
  /**
   * True when this invoice carries the package's own fee line. False means the
   * fee was billed on an earlier invoice — an extended opening cycle bills once
   * up front but keeps covering work in the months that follow — and the work
   * below is genuinely included at no further charge.
   */
  feeOnThisInvoice: boolean
  /** Delivered work the fee covers. Never priced on the invoice. */
  covered: CoveredTask[]
  allowance: AllowanceLine[]
  totalIncluded: number
  totalDelivered: number
}

export interface AgreementBreakdownInput {
  /** Every non-deleted package for the invoice's client. */
  packages: PackageRow[]
  itemsByPackage: Map<string, PackageItemRow[]>
  /** package_id → its linked tasks (all of them; scoped to the cycle here). */
  tasksByPackage: Map<string, TaskDetail[]>
  /** service_id → display name, for readable allowance rows. */
  serviceNames: Map<string, string>
  /** The invoice's billing month, `YYYY-MM`. */
  month: string
  /** package_ids that carry a fee line on THIS invoice. */
  feePackageIds: Set<string>
}

/** A task with enough detail to print, not just to count. */
export interface TaskDetail extends PackageTaskLike {
  title?: string | null
}

/**
 * Every agreement in force for the invoice's month, with the work it covered.
 *
 * Packages out of term are skipped entirely — an agreement that ended in June
 * has nothing to say about an August invoice.
 */
export function buildAgreementBreakdowns(input: AgreementBreakdownInput): AgreementBreakdown[] {
  const out: AgreementBreakdown[] = []

  for (const pkg of input.packages) {
    if (!isPackageInForceForMonth(pkg, input.month)) continue

    const items = input.itemsByPackage.get(pkg.id) ?? []
    const tasks = input.tasksByPackage.get(pkg.id) ?? []
    // resolveCoverageForPackage works the cycle out itself, which matters for an
    // extended opening cycle: calling resolveCoverage directly would show two
    // allowances where the client agreed to one.
    const cov = resolveCoverageForPackage(pkg, tasks, items, input.month)

    const byId = new Map(tasks.map(t => [t.id, t]))
    const covered: CoveredTask[] = cov.coveredTaskIds
      .map(id => byId.get(id))
      .filter((t): t is TaskDetail => !!t)
      .map(t => ({
        id: t.id,
        title: t.title || 'Untitled task',
        taskDate: t.task_date ?? null,
        serviceId: t.service_id ?? null,
        serviceName: (t.service_id && input.serviceNames.get(t.service_id)) || '',
        status: t.status ?? null,
      }))
      .sort((a, b) => String(a.taskDate ?? '').localeCompare(String(b.taskDate ?? '')))

    // Nothing delivered and no fee to explain — an empty block on the invoice
    // would just be noise.
    if (covered.length === 0 && !input.feePackageIds.has(pkg.id)) continue

    out.push({
      packageId: pkg.id,
      packageName: pkg.name,
      billingType: pkg.billing_type,
      currency: pkg.currency,
      feeOnThisInvoice: input.feePackageIds.has(pkg.id),
      covered,
      allowance: cov.perItem.map(p => ({
        serviceId: p.serviceId,
        serviceName: input.serviceNames.get(p.serviceId) || 'Service',
        included: p.included,
        delivered: p.delivered,
        remaining: p.remaining,
        extra: p.extra,
      })),
      totalIncluded: cov.totalIncluded,
      totalDelivered: cov.totalDelivered,
    })
  }

  return out
}

/**
 * The month an invoice bills for.
 *
 * `billing_period_start` is the authority; `cycleForMonth` then decides whether
 * that month sits inside an extended opening cycle.
 */
export function invoiceMonth(billingPeriodStart: string | null | undefined): string | null {
  return billingPeriodStart ? String(billingPeriodStart).slice(0, 7) : null
}

export { cycleForMonth }

// ── Server loader ────────────────────────────────────────────────────────────

/** The invoice fields the loader needs. */
export interface InvoiceForBreakdown {
  id: string
  client_id: string | null
  billing_period_start: string | null
  items?: { package_id?: string | null }[] | null
}

/**
 * Breakdowns for a whole page of invoices, in three small queries.
 *
 * Deliberately NOT per-invoice: the package tables are tiny and scale with
 * packaged work, not with invoice count, so one pass over them beats 500 round
 * trips. Returns invoice_id → its agreements.
 *
 * Degrades to an empty map if the packages migration hasn't run, so the
 * invoices page keeps working on an environment without these tables.
 */
export async function loadAgreementBreakdowns(
  admin: SupabaseClient,
  invoices: InvoiceForBreakdown[],
  serviceNames: Map<string, string>,
): Promise<Record<string, AgreementBreakdown[]>> {
  const clientIds = [...new Set(invoices.map(i => i.client_id).filter(Boolean))] as string[]
  if (clientIds.length === 0) return {}

  try {
    const { data: pkgData, error } = await admin
      .from('client_packages')
      .select('*')
      .in('client_id', clientIds)
      .is('deleted_at', null)
    if (error || !pkgData?.length) return {}

    const packages = pkgData as PackageRow[]
    const ids = packages.map(p => p.id)

    const [itemsRes, tasksRes] = await Promise.all([
      admin.from('client_package_items').select('*').in('package_id', ids),
      admin.from('tasks')
        .select('id, title, package_id, service_id, task_date, task_number, status')
        .in('package_id', ids).is('deleted_at', null),
    ])

    const itemsByPackage = new Map<string, PackageItemRow[]>()
    for (const it of (itemsRes.data ?? []) as PackageItemRow[]) {
      const arr = itemsByPackage.get(it.package_id)
      if (arr) arr.push(it); else itemsByPackage.set(it.package_id, [it])
    }

    const tasksByPackage = new Map<string, TaskDetail[]>()
    for (const t of (tasksRes.data ?? []) as (TaskDetail & { package_id: string })[]) {
      const arr = tasksByPackage.get(t.package_id)
      if (arr) arr.push(t); else tasksByPackage.set(t.package_id, [t])
    }

    const packagesByClient = new Map<string, PackageRow[]>()
    for (const p of packages) {
      const arr = packagesByClient.get(p.client_id)
      if (arr) arr.push(p); else packagesByClient.set(p.client_id, [p])
    }

    const out: Record<string, AgreementBreakdown[]> = {}
    for (const inv of invoices) {
      const month = invoiceMonth(inv.billing_period_start)
      if (!month || !inv.client_id) continue
      const mine = packagesByClient.get(inv.client_id)
      if (!mine?.length) continue

      const feePackageIds = new Set(
        (inv.items ?? []).map(i => i?.package_id).filter(Boolean) as string[],
      )
      const rows = buildAgreementBreakdowns({
        packages: mine, itemsByPackage, tasksByPackage, serviceNames, month, feePackageIds,
      })
      if (rows.length) out[inv.id] = rows
    }
    return out
  } catch {
    return {}
  }
}
