/**
 * Agreement fee lines — keep an invoice's fee lines matching the agreement.
 *
 * Task lines have always been live: a DB trigger attaches them and
 * syncDraftInvoices() re-stamps them on every task edit. Agreement FEES (the
 * monthly retainer, a one-time package price) had no such path — they existed
 * only if a once-a-month cron happened to run. So a price corrected on the
 * agreement, a backfilled month, or an agreement activated after the 1st all
 * left the invoice silently wrong.
 *
 * This module is the fee equivalent of syncDraftInvoices(): idempotent, safe to
 * call as often as you like, and self-correcting. One entry point serves the
 * cron (every client), the invoice Resync button (one client-month), and the
 * agreement editor (a price that just changed).
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *  • WHEN a fee bills is decided by ./billing, which is built on the delivery
 *    period engine — one fee per period, never one per calendar month.
 *  • A missing line is INSERTed; an existing line whose amount/description
 *    drifted is UPDATEd. Both only on draft/reviewed invoices — an issued
 *    invoice is a document already sent to a client and is never rewritten.
 *  • A fee line is identified by agreement_item_id across the whole term-row
 *    lineage, so "change terms" (close-and-replace) updates the existing line
 *    instead of adding a second one.
 *  • Deleting a fee line does NOT make it stay deleted, unlike a cashbook
 *    expense: a contracted fee that is absent is nearly always an error, not an
 *    intent. To stop billing, end/pause the agreement or close the term row.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { feeBillsInMonth, feeLineDescription, feeWorkWindow } from './billing'
import { lastDayOf, DELIVERED_STATUSES } from './progress'

export interface FeeLinePlan {
  agreementId: string
  agreementTitle: string
  /** Term row in force for this month — the row whose price is charged. */
  itemId: string
  /** Every term row of this fee's lineage; the identity used to de-duplicate. */
  lineageItemIds: string[]
  clientId: string
  description: string
  amount: number
  currency: string
  /** First task delivered against this item inside the covered window; null if none yet. */
  lineDate: string | null
}

export interface FeeSyncResult {
  month: string
  planned: FeeLinePlan[]
  added: number
  updated: number
  /** Correct already — nothing to do. */
  unchanged: number
  /** Present on an issued invoice, so deliberately left alone. */
  lockedOnIssuedInvoice: number
  invoicesTouched: string[]
}

interface AgreementRow {
  id: string; client_id: string; title: string
  start_date: string; end_date: string | null
}
interface ItemRow {
  id: string; agreement_id: string; service_id: string | null
  commitment_type: 'one_time' | 'retainer'
  unit_price: number | null; currency: string | null
  effective_from: string; effective_to: string | null
  invoice_label: string | null
}

/** Invoice statuses whose lines may still be rewritten. */
const MUTABLE = ['draft', 'reviewed']

/**
 * The date to show on a fee line: the earliest task actually delivered against
 * this agreement item inside the window the fee covers.
 *
 * Two ways a task belongs to an item, because only retainers are stamped:
 *  • retainer — tasks the coverage trigger linked via tasks.retainer_item_id
 *  • one_time — nothing stamps these, so fall back to the client's tasks on
 *    the item's own service inside the window (the logo jobs you add by hand)
 *
 * Returns null when no work is dated yet, leaving the column blank rather than
 * inventing a date.
 */
async function firstDeliveredTaskDate(
  admin: SupabaseClient,
  q: {
    clientId: string
    lineageItemIds: string[]
    serviceId: string | null
    from: string
    to: string
  },
): Promise<string | null> {
  const dates: string[] = []

  const collect = async (build: (b: any) => any) => {
    const { data } = await build(
      admin.from('tasks').select('task_date')
        .is('deleted_at', null)
        .in('status', DELIVERED_STATUSES as unknown as string[])
        .gte('task_date', q.from)
        .lte('task_date', q.to)
        .order('task_date', { ascending: true })
        .limit(1),
    )
    const d = (data as { task_date: string | null }[] | null)?.[0]?.task_date
    if (d) dates.push(d)
  }

  try {
    if (q.lineageItemIds.length > 0) {
      await collect(b => b.in('retainer_item_id', q.lineageItemIds))
    }
    if (q.serviceId) {
      await collect(b => b.eq('client_id', q.clientId).eq('service_id', q.serviceId))
    }
  } catch {
    return null // pre-migration / unreadable → blank date, never a wrong one
  }

  return dates.length > 0 ? dates.sort()[0] : null
}

/**
 * Work out every agreement fee that belongs on `month`'s invoices.
 * Pure planning — reads only, writes nothing.
 */
export async function planAgreementFeeLines(
  admin: SupabaseClient,
  opts: { month: string; clientId?: string | null },
): Promise<FeeLinePlan[]> {
  const { month, clientId } = opts
  const periodStart = `${month}-01`
  const periodEnd = lastDayOf(month)

  let q = admin
    .from('client_agreements')
    .select('id, client_id, title, start_date, end_date')
    .eq('status', 'active')
    .is('deleted_at', null)
    .lte('start_date', periodEnd)
  if (clientId) q = q.eq('client_id', clientId)

  const { data: agreements, error } = await q.returns<AgreementRow[]>()
  if (error) throw new Error(`agreements: ${error.message}`)

  const inWindow = (agreements || []).filter(a => !a.end_date || a.end_date >= periodStart)
  if (inWindow.length === 0) return []

  const { data: items, error: itErr } = await admin
    .from('client_agreement_items')
    .select('id, agreement_id, service_id, commitment_type, unit_price, currency, effective_from, effective_to, invoice_label')
    .in('agreement_id', inWindow.map(a => a.id))
    .returns<ItemRow[]>()
  if (itErr) throw new Error(`agreement items: ${itErr.message}`)

  const serviceIds = Array.from(new Set((items || []).map(i => i.service_id).filter(Boolean) as string[]))
  const serviceName = new Map<string, string>()
  if (serviceIds.length > 0) {
    const { data: svcs } = await admin.from('services').select('id, name').in('id', serviceIds)
    for (const s of (svcs || []) as { id: string; name: string }[]) serviceName.set(s.id, s.name)
  }

  const planned: FeeLinePlan[] = []

  for (const agreement of inWindow) {
    // A fee's identity is (agreement, service, commitment type). "Change terms"
    // closes a row and inserts a successor, so one identity owns several term
    // rows — group them, then charge the row in force this month.
    const lineage = new Map<string, ItemRow[]>()
    for (const it of (items || []).filter(i => i.agreement_id === agreement.id)) {
      const key = `${it.commitment_type}|${it.service_id ?? it.id}`
      const arr = lineage.get(key)
      if (arr) arr.push(it)
      else lineage.set(key, [it])
    }

    for (const rows of lineage.values()) {
      const inForce = rows
        .filter(r => r.effective_from <= periodEnd && (!r.effective_to || r.effective_to >= periodStart))
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
      if (!inForce) continue
      if (!inForce.unit_price || inForce.unit_price <= 0) continue
      if (!feeBillsInMonth(month, agreement, inForce)) continue

      // The client reads the wording they signed, not the service catalogue.
      const label = inForce.invoice_label?.trim()
        || (inForce.service_id && serviceName.get(inForce.service_id))
        || agreement.title

      const window = feeWorkWindow(month, agreement, inForce)
      const lineDate = await firstDeliveredTaskDate(admin, {
        clientId: agreement.client_id,
        lineageItemIds: rows.map(r => r.id),
        serviceId: inForce.service_id,
        from: window.start,
        to: window.end,
      })

      planned.push({
        agreementId: agreement.id,
        agreementTitle: agreement.title,
        itemId: inForce.id,
        lineageItemIds: rows.map(r => r.id),
        clientId: agreement.client_id,
        description: feeLineDescription(month, agreement, inForce, label),
        amount: Number(inForce.unit_price),
        currency: inForce.currency || 'INR',
        lineDate,
      })
    }
  }

  return planned
}

/**
 * Make `month`'s invoices match the agreements: insert missing fee lines,
 * correct drifted ones, leave issued invoices alone.
 *
 * `dryRun` reports exactly what would change without writing — always worth
 * running first on a month you have not billed before.
 */
export async function syncAgreementFeeLines(
  admin: SupabaseClient,
  opts: {
    month: string; clientId?: string | null; dryRun?: boolean
    /**
     * Correct existing lines but never create one. Used when a SAVE elsewhere
     * (an agreement price edit) should flow into open drafts — creating lines
     * for months nobody chose to bill would be a money side-effect of an edit.
     */
    updateOnly?: boolean
  },
): Promise<FeeSyncResult> {
  const { month, clientId, dryRun = false, updateOnly = false } = opts
  const periodStart = `${month}-01`

  const planned = await planAgreementFeeLines(admin, { month, clientId })
  const result: FeeSyncResult = {
    month, planned, added: 0, updated: 0, unchanged: 0,
    lockedOnIssuedInvoice: 0, invoicesTouched: [],
  }
  if (planned.length === 0) return result

  // Existing fee lines for any term row in any planned lineage.
  const allItemIds = Array.from(new Set(planned.flatMap(p => p.lineageItemIds)))
  const { data: feeLines } = await admin
    .from('invoice_items')
    .select('id, agreement_item_id, invoice_id, description, unit_price, total, currency, line_date')
    .in('agreement_item_id', allItemIds)
    .returns<{
      id: string; agreement_item_id: string | null; invoice_id: string | null
      description: string | null; unit_price: number | null; total: number | null
      currency: string | null; line_date: string | null
    }[]>()

  const invoiceIds = Array.from(new Set((feeLines || []).map(l => l.invoice_id).filter(Boolean) as string[]))
  const invoiceById = new Map<string, { id: string; status: string | null; billing_period_start: string | null }>()
  if (invoiceIds.length > 0) {
    const { data: invs } = await admin
      .from('invoices').select('id, status, billing_period_start').in('id', invoiceIds)
    for (const inv of (invs || []) as { id: string; status: string | null; billing_period_start: string | null }[]) {
      invoiceById.set(inv.id, inv)
    }
  }

  // Only lines sitting on THIS billing month count as "already billed".
  const existingForMonth = (feeLines || []).filter(l => {
    const inv = l.invoice_id ? invoiceById.get(l.invoice_id) : null
    return inv?.billing_period_start === periodStart
  })

  const touched = new Set<string>()

  for (const p of planned) {
    const existing = existingForMonth.find(
      l => l.agreement_item_id && p.lineageItemIds.includes(l.agreement_item_id),
    )

    if (existing) {
      const inv = existing.invoice_id ? invoiceById.get(existing.invoice_id) : null
      if (!inv || !MUTABLE.includes(inv.status || '')) {
        result.lockedOnIssuedInvoice++
        continue
      }
      const drifted =
        Math.abs(Number(existing.total ?? 0) - p.amount) > 0.005 ||
        Math.abs(Number(existing.unit_price ?? 0) - p.amount) > 0.005 ||
        (existing.currency || 'INR') !== p.currency ||
        existing.description !== p.description ||
        // A date only ever fills in as work lands; never blank one already set.
        (p.lineDate != null && existing.line_date !== p.lineDate)
      if (!drifted) { result.unchanged++; continue }

      if (!dryRun) {
        const { error } = await admin.from('invoice_items').update({
          agreement_item_id: p.itemId,   // follow a term change onto the new row
          description: p.description,
          quantity: 1,
          unit_price: p.amount,
          total: p.amount,
          currency: p.currency,
          ...(p.lineDate != null ? { line_date: p.lineDate } : {}),
        }).eq('id', existing.id)
        if (error) continue
        touched.add(existing.invoice_id!)
      }
      result.updated++
      continue
    }

    // No line yet — create one on the client's month draft.
    if (updateOnly) continue
    if (!dryRun) {
      const { data: rate } = await admin.rpc('rate_to_inr_for', { p_currency: p.currency })
      const { data: invoiceId, error: invErr } = await admin.rpc('find_or_create_client_month_draft', {
        p_client_id: p.clientId,
        p_period: periodStart,
        p_currency: p.currency,
        p_exchange_rate: rate ?? 1,
      })
      if (invErr || !invoiceId) continue

      const { data: rows } = await admin
        .from('invoice_items').select('display_order').eq('invoice_id', invoiceId)
      const nextOrder = ((rows || []) as { display_order: number | null }[])
        .reduce((m, r) => Math.max(m, r.display_order ?? 0), -1) + 1

      const { error: insErr } = await admin.from('invoice_items').insert({
        invoice_id: invoiceId,
        task_id: null,
        agreement_item_id: p.itemId,
        description: p.description,
        quantity: 1,
        unit_price: p.amount,
        total: p.amount,
        currency: p.currency,
        line_date: p.lineDate,
        display_order: nextOrder,
      })
      if (insErr) continue
      touched.add(invoiceId as string)
    }
    result.added++
  }

  if (!dryRun) {
    for (const id of touched) {
      await admin.rpc('recalc_invoice_totals', { p_invoice_id: id })
    }
  }
  result.invoicesTouched = Array.from(touched)
  return result
}

/**
 * A price changed on an agreement item — push it into every OPEN invoice that
 * already carries this fee, and nowhere else.
 *
 * Deliberately update-only: an agreement edit must not conjure invoices for
 * months nobody chose to bill. Use the cron's `from=` backfill for that, where
 * creating lines is the explicit intent.
 */
export async function syncFeeLinesForAgreementItem(
  admin: SupabaseClient,
  itemId: string,
): Promise<{ monthsTouched: string[]; updated: number }> {
  const { data: item } = await admin
    .from('client_agreement_items')
    .select('id, agreement_id, service_id, commitment_type')
    .eq('id', itemId)
    .maybeSingle<{ id: string; agreement_id: string; service_id: string | null; commitment_type: string }>()
  if (!item) return { monthsTouched: [], updated: 0 }

  const { data: agreement } = await admin
    .from('client_agreements').select('client_id').eq('id', item.agreement_id)
    .maybeSingle<{ client_id: string }>()
  if (!agreement) return { monthsTouched: [], updated: 0 }

  // The whole lineage: same agreement, service and commitment type.
  const { data: siblings } = await admin
    .from('client_agreement_items')
    .select('id, service_id, commitment_type')
    .eq('agreement_id', item.agreement_id)
    .returns<{ id: string; service_id: string | null; commitment_type: string }[]>()
  const lineage = (siblings || [])
    .filter(s => s.commitment_type === item.commitment_type
      && (s.service_id ?? s.id) === (item.service_id ?? item.id))
    .map(s => s.id)
  if (lineage.length === 0) return { monthsTouched: [], updated: 0 }

  const { data: lines } = await admin
    .from('invoice_items').select('invoice_id').in('agreement_item_id', lineage)
    .returns<{ invoice_id: string | null }[]>()
  const invoiceIds = Array.from(new Set((lines || []).map(l => l.invoice_id).filter(Boolean) as string[]))
  if (invoiceIds.length === 0) return { monthsTouched: [], updated: 0 }

  const { data: invs } = await admin
    .from('invoices').select('billing_period_start, status').in('id', invoiceIds)
    .returns<{ billing_period_start: string | null; status: string | null }[]>()
  const months = Array.from(new Set(
    (invs || [])
      .filter(i => MUTABLE.includes(i.status || '') && i.billing_period_start)
      .map(i => i.billing_period_start!.slice(0, 7)),
  ))

  let updated = 0
  for (const month of months) {
    const r = await syncAgreementFeeLines(admin, {
      month, clientId: agreement.client_id, updateOnly: true,
    })
    updated += r.updated
  }
  return { monthsTouched: months, updated }
}

/**
 * Sync every month an agreement has been active in, up to `throughMonth`.
 * The backfill path: activating an agreement late, or correcting a price that
 * has been wrong for several months, without hand-running one month at a time.
 */
export async function syncAgreementFeeHistory(
  admin: SupabaseClient,
  opts: { clientId?: string | null; fromMonth: string; throughMonth: string; dryRun?: boolean },
): Promise<FeeSyncResult[]> {
  const out: FeeSyncResult[] = []
  let cursor = opts.fromMonth
  // Hard stop: a malformed range must not spin forever.
  for (let guard = 0; guard < 120 && cursor <= opts.throughMonth; guard++) {
    out.push(await syncAgreementFeeLines(admin, {
      month: cursor, clientId: opts.clientId, dryRun: opts.dryRun,
    }))
    const [y, m] = cursor.split('-').map(Number)
    const next = new Date(Date.UTC(y, m, 1))
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`
  }
  return out
}
