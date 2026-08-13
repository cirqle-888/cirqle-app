/**
 * Reconcile an invoice's package lines against what the packages actually say.
 *
 * The decision lives in `planPackageInvoice` (pure, tested); this module only
 * loads the inputs and writes the difference. Splitting it that way means the
 * hard part — which task is covered, which is extra, whether a one-time fee has
 * already gone out — is verifiable without a database.
 *
 * Safe to run repeatedly: fee lines are keyed by (invoice_id, package_id), so a
 * second resync updates the same row rather than adding another. A unique index
 * enforces that at the database level too, in case two resyncs race.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { planPackageInvoice, extraTaskUnitPrice } from './invoice-lines'
import type { PackageRow, PackageItemRow, PackageTaskLike } from './types'

export interface PackageSyncResult {
  feeLines: number
  /** Task lines removed because a package fee now covers them. */
  coveredLinesRemoved: number
  /** Fee lines removed because the package no longer applies to this month. */
  staleFeeLinesRemoved: number
  /** Over-allowance task lines repriced to the package's agreed extra rate. */
  extrasRepriced: number
}

const EMPTY: PackageSyncResult = {
  feeLines: 0, coveredLinesRemoved: 0, staleFeeLinesRemoved: 0, extrasRepriced: 0,
}

/**
 * Bring one draft invoice's package lines in line with the packages.
 *
 * Only ever called for a DRAFT — an invoice the client has already seen must
 * not change because a package was edited afterwards.
 */
export async function syncInvoicePackageLines(
  admin: SupabaseClient,
  invoiceId: string,
): Promise<PackageSyncResult> {
  const { data: inv } = await admin
    .from('invoices')
    .select('id, client_id, status, billing_period_start')
    .eq('id', invoiceId)
    .maybeSingle()

  if (!inv || inv.status !== 'draft' || !inv.client_id || !inv.billing_period_start) return EMPTY
  const month = String(inv.billing_period_start).slice(0, 7)

  // ── Load ───────────────────────────────────────────────────────────────────
  let packages: PackageRow[] = []
  try {
    const { data, error } = await admin
      .from('client_packages')
      .select('*')
      .eq('client_id', inv.client_id)
      .is('deleted_at', null)
    // Pre-migration environment: leave the invoice completely alone.
    if (error) return EMPTY
    packages = (data ?? []) as PackageRow[]
  } catch {
    return EMPTY
  }
  if (packages.length === 0) return EMPTY

  const ids = packages.map(p => p.id)

  const [itemsRes, tasksRes, billedRes] = await Promise.all([
    admin.from('client_package_items').select('*').in('package_id', ids),
    // `status` is not optional here: coverage must not let an unfinished task
    // take a covered slot and push a delivered one into billable overage.
    admin.from('tasks')
      .select('id, package_id, service_id, task_date, task_number, status')
      .in('package_id', ids).is('deleted_at', null),
    // One-time fees bill once EVER, so this looks across every invoice, not
    // just this one — and ignores lines on this invoice, which we are about to
    // rewrite anyway.
    admin.from('invoice_items')
      .select('package_id, invoice_id')
      .in('package_id', ids).neq('invoice_id', invoiceId),
  ])

  const itemsByPackage = new Map<string, PackageItemRow[]>()
  for (const it of (itemsRes.data ?? []) as PackageItemRow[]) {
    const arr = itemsByPackage.get(it.package_id)
    if (arr) arr.push(it)
    else itemsByPackage.set(it.package_id, [it])
  }

  const tasksByPackage = new Map<string, PackageTaskLike[]>()
  for (const t of (tasksRes.data ?? []) as (PackageTaskLike & { package_id: string })[]) {
    const arr = tasksByPackage.get(t.package_id)
    if (arr) arr.push(t)
    else tasksByPackage.set(t.package_id, [t])
  }

  const oneTimeAlreadyBilled = new Set(
    ((billedRes.data ?? []) as { package_id: string | null }[])
      .map(r => r.package_id).filter(Boolean) as string[],
  )

  // ── Decide ─────────────────────────────────────────────────────────────────
  const plan = planPackageInvoice({
    packages, itemsByPackage, tasksByPackage, month, oneTimeAlreadyBilled,
  })

  // ── Write the difference ───────────────────────────────────────────────────
  const { data: existing } = await admin
    .from('invoice_items')
    .select('id, package_id, task_id, display_order, quantity, unit_price, currency')
    .eq('invoice_id', invoiceId)

  const rows = (existing ?? []) as {
    id: string; package_id: string | null; task_id: string | null; display_order: number | null
    quantity: number | null; unit_price: number | null; currency: string | null
  }[]

  // 1. Drop fee lines for packages that no longer belong on this invoice —
  //    paused mid-month, term ended, or the one-time fee already went out.
  const wantedFeeIds = new Set(plan.feeLines.map(f => f.packageId))
  const staleFees = rows.filter(r => r.package_id && !wantedFeeIds.has(r.package_id))
  if (staleFees.length) {
    await admin.from('invoice_items').delete().in('id', staleFees.map(r => r.id))
  }

  // 2. Drop task lines the package fee now covers. This is the whole point:
  //    the client pays the fee, not the fee AND each task inside it.
  const coveredLines = rows.filter(r => r.task_id && plan.coveredTaskIds.has(r.task_id))
  if (coveredLines.length) {
    await admin.from('invoice_items').delete().in('id', coveredLines.map(r => r.id))
  }

  // 3. Upsert the fee lines.
  let nextOrder = Math.max(-1, ...rows.map(r => r.display_order ?? -1)) + 1
  const byPackage = new Map(rows.filter(r => r.package_id).map(r => [r.package_id!, r]))

  for (const fee of plan.feeLines) {
    const payload = {
      invoice_id: invoiceId,
      package_id: fee.packageId,
      task_id: null,
      description: fee.description,
      quantity: 1,
      unit_price: fee.amount,
      total: fee.amount,
      currency: fee.currency,
      // A fee line has no task to date it; without this it prints undated and
      // sorts to the bottom of the PDF, away from the work it paid for.
      line_date: fee.lineDate,
    }
    const found = byPackage.get(fee.packageId)
    if (found) {
      await admin.from('invoice_items').update(payload).eq('id', found.id)
    } else {
      await admin.from('invoice_items').insert({ ...payload, display_order: nextOrder++ })
    }
  }

  // 4. Reprice over-allowance tasks to the agreed extra rate.
  //
  //    A task beyond what's included keeps its own line — it is genuinely extra
  //    work — but the client agreed a specific overage rate for it, which is not
  //    the Pricing-Matrix figure the per-task sync just wrote. Where no rate was
  //    agreed the matrix price stands (`extraTaskUnitPrice` returns it), so a
  //    blank field never silently zeroes a billable task.
  const extraByTask = new Map(plan.extras.map(e => [e.taskId, e]))
  let extrasRepriced = 0
  for (const r of rows) {
    if (!r.task_id || coveredLines.some(c => c.id === r.id)) continue
    const extra = extraByTask.get(r.task_id)
    if (!extra || extra.unitPrice == null) continue
    // Repricing across currencies would need a conversion this function has no
    // business inventing. Leave the line at its matrix price instead.
    if (r.currency && extra.currency && r.currency !== extra.currency) continue

    const unit = extraTaskUnitPrice(extra, r.unit_price ?? 0)
    const qty = r.quantity ?? 1
    if (r.unit_price === unit) continue
    await admin.from('invoice_items')
      .update({ unit_price: unit, total: Math.round(unit * qty * 100) / 100 })
      .eq('id', r.id)
    extrasRepriced++
  }

  await recalcInvoiceTotal(admin, invoiceId)

  return {
    feeLines: plan.feeLines.length,
    coveredLinesRemoved: coveredLines.length,
    staleFeeLinesRemoved: staleFees.length,
    extrasRepriced,
  }
}

/**
 * Recompute subtotal/total after changing lines.
 *
 * Mirrors the canonical formula (recalc_invoice_totals in SQL): subtotal is
 * items + expenses; total subtracts discount and adds tax and any brought-
 * forward balance. previous_balance is deliberately included — omitting it is a
 * known bug elsewhere in this codebase that silently zeroes a carried balance.
 */
async function recalcInvoiceTotal(admin: SupabaseClient, invoiceId: string): Promise<void> {
  const [itemsRes, expRes, invRes] = await Promise.all([
    admin.from('invoice_items').select('total').eq('invoice_id', invoiceId),
    admin.from('invoice_expense_items').select('amount').eq('invoice_id', invoiceId),
    admin.from('invoices')
      .select('discount_amount, tax_amount, previous_balance').eq('id', invoiceId).maybeSingle(),
  ])

  const r2 = (n: number) => Math.round(n * 100) / 100
  const itemTotal = ((itemsRes.data ?? []) as { total: number | null }[])
    .reduce((s, i) => s + (i.total || 0), 0)
  const expTotal = ((expRes.data ?? []) as { amount: number | null }[])
    .reduce((s, e) => s + (e.amount || 0), 0)

  const inv = invRes.data as {
    discount_amount: number | null; tax_amount: number | null; previous_balance: number | null
  } | null

  const subtotal = r2(itemTotal + expTotal)
  const total_amount = r2(
    subtotal - (inv?.discount_amount || 0) + (inv?.tax_amount || 0) + (inv?.previous_balance || 0),
  )

  await admin.from('invoices').update({ subtotal, total_amount }).eq('id', invoiceId)
}
