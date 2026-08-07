import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'
import { feeBillsInMonth, feeLineDescription } from '@/lib/agreements/billing'
import { lastDayOf } from '@/lib/agreements/progress'

/**
 * Agreement fee invoicing cron.
 *
 * Covered tasks deliberately never become invoice lines — the client pays the
 * agreement's fees instead. This job puts those fees on the invoice, so a
 * retainer client's bill is fully agreement-driven: the monthly retainer, plus
 * any one-time package fee, plus whatever extra-work tasks were flagged.
 *
 * WHEN each fee bills is decided by `lib/agreements/billing`, which is built on
 * the progress engine's period model — one fee per delivery period, never per
 * calendar month. That distinction is the whole point: an agreement starting
 * mid-month merges its stub month into the next, so billing per month would
 * charge two retainers for one cycle.
 *
 * IDEMPOTENT: a fee is skipped when any invoice for that billing month already
 * carries a line for the same agreement + service + commitment type (across
 * every historical term row, so a mid-life "change terms" cannot re-bill).
 *
 *   GET /api/cron/retainer-invoices                  → current month
 *   GET /api/cron/retainer-invoices?month=YYYY-MM    → a specific month
 *   GET /api/cron/retainer-invoices?dryRun=1         → report, change nothing
 *
 * Auth: shared-secret Bearer token, same as every other cron. Monthly schedule
 * in vercel.json; surfaced in the Business Health Center via KNOWN_CRONS.
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false // fail closed — never run unauthenticated
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
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
}

interface PlannedLine {
  agreementId: string
  agreementTitle: string
  itemId: string
  /** Every term row of this fee's lineage — the idempotency key. */
  lineageItemIds: string[]
  clientId: string
  description: string
  amount: number
  currency: string
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const monthParam = req.nextUrl.searchParams.get('month')
  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
    ? monthParam
    : new Date().toISOString().slice(0, 7)
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'

  const periodStart = `${month}-01`
  const periodEnd = lastDayOf(month)

  try {
    // ── 1. Active agreements whose window covers this month ──────────────────
    const { data: agreements, error: agErr } = await admin
      .from('client_agreements')
      .select('id, client_id, title, start_date, end_date')
      .eq('status', 'active')
      .is('deleted_at', null)
      .lte('start_date', periodEnd)
      .returns<AgreementRow[]>()
    if (agErr) throw new Error(`agreements: ${agErr.message}`)

    const inWindow = (agreements || []).filter(a => !a.end_date || a.end_date >= periodStart)
    if (inWindow.length === 0) {
      await logCronRun(admin, 'retainer-invoices', true, { month, linesAdded: 0 })
      return NextResponse.json({ ok: true, month, linesAdded: 0, planned: [] })
    }

    const { data: items, error: itErr } = await admin
      .from('client_agreement_items')
      .select('id, agreement_id, service_id, commitment_type, unit_price, currency, effective_from, effective_to')
      .in('agreement_id', inWindow.map(a => a.id))
      .returns<ItemRow[]>()
    if (itErr) throw new Error(`items: ${itErr.message}`)

    // Service names for readable line descriptions.
    const serviceIds = Array.from(new Set((items || []).map(i => i.service_id).filter(Boolean) as string[]))
    const serviceName = new Map<string, string>()
    if (serviceIds.length > 0) {
      const { data: svcs } = await admin.from('services').select('id, name').in('id', serviceIds)
      for (const s of svcs || []) serviceName.set(s.id, s.name)
    }

    // ── 2. Decide what should bill this month ────────────────────────────────
    const planned: PlannedLine[] = []

    for (const agreement of inWindow) {
      // A fee's identity is (agreement, service, commitment type). "Change
      // terms" closes a row and inserts a successor, so one identity can own
      // several term rows — group them, then bill the row in force this month.
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

        const label = (inForce.service_id && serviceName.get(inForce.service_id)) || agreement.title
        planned.push({
          agreementId: agreement.id,
          agreementTitle: agreement.title,
          itemId: inForce.id,
          lineageItemIds: rows.map(r => r.id),
          clientId: agreement.client_id,
          description: feeLineDescription(month, agreement, inForce, label),
          amount: Number(inForce.unit_price),
          currency: inForce.currency || 'INR',
        })
      }
    }

    // ── 3. Drop anything already billed for this month ───────────────────────
    // Two plain queries rather than an embedded join: the fee lines, then which
    // of their invoices belong to this billing month.
    const allItemIds = Array.from(new Set(planned.flatMap(p => p.lineageItemIds)))
    const alreadyBilled = new Set<string>()
    if (allItemIds.length > 0) {
      const { data: feeLines } = await admin
        .from('invoice_items')
        .select('agreement_item_id, invoice_id')
        .in('agreement_item_id', allItemIds)
        .returns<{ agreement_item_id: string | null; invoice_id: string | null }[]>()

      const invoiceIds = Array.from(new Set((feeLines || []).map(l => l.invoice_id).filter(Boolean) as string[]))
      if (invoiceIds.length > 0) {
        const { data: invs } = await admin
          .from('invoices')
          .select('id')
          .in('id', invoiceIds)
          .eq('billing_period_start', periodStart)
        const thisMonth = new Set((invs || []).map(i => i.id))
        for (const line of feeLines || []) {
          if (line.agreement_item_id && line.invoice_id && thisMonth.has(line.invoice_id)) {
            alreadyBilled.add(line.agreement_item_id)
          }
        }
      }
    }
    const toAdd = planned.filter(p => !p.lineageItemIds.some(id => alreadyBilled.has(id)))

    if (dryRun) {
      return NextResponse.json({
        ok: true, dryRun: true, month,
        wouldAdd: toAdd.length,
        skippedAlreadyBilled: planned.length - toAdd.length,
        lines: toAdd.map(p => ({ description: p.description, currency: p.currency, amount: p.amount })),
      })
    }

    // ── 4. Write the lines ───────────────────────────────────────────────────
    const touchedInvoices = new Set<string>()
    let added = 0

    for (const p of toAdd) {
      const { data: rate } = await admin.rpc('rate_to_inr_for', { p_currency: p.currency })
      const { data: invoiceId, error: invErr } = await admin.rpc('find_or_create_client_month_draft', {
        p_client_id: p.clientId,
        p_period: periodStart,
        p_currency: p.currency,
        p_exchange_rate: rate ?? 1,
      })
      if (invErr || !invoiceId) continue

      const { data: existingRows } = await admin
        .from('invoice_items').select('display_order').eq('invoice_id', invoiceId)
      const nextOrder = (existingRows || []).reduce((m, r) => Math.max(m, r.display_order ?? 0), -1) + 1

      const { error: insErr } = await admin.from('invoice_items').insert({
        invoice_id: invoiceId,
        task_id: null,
        agreement_item_id: p.itemId,
        description: p.description,
        quantity: 1,
        unit_price: p.amount,
        total: p.amount,
        currency: p.currency,
        display_order: nextOrder,
      })
      if (insErr) continue

      touchedInvoices.add(invoiceId as string)
      added++
    }

    for (const id of touchedInvoices) {
      await admin.rpc('recalc_invoice_totals', { p_invoice_id: id })
    }

    await logCronRun(admin, 'retainer-invoices', true, {
      month, linesAdded: added, skippedAlreadyBilled: planned.length - toAdd.length,
    })
    return NextResponse.json({
      ok: true, month,
      linesAdded: added,
      skippedAlreadyBilled: planned.length - toAdd.length,
      lines: toAdd.map(p => ({ description: p.description, currency: p.currency, amount: p.amount })),
    })
  } catch (err: any) {
    await logCronRun(admin, 'retainer-invoices', false, { month }, err?.message || 'unknown')
    return NextResponse.json({ ok: false, error: err?.message || 'unknown' }, { status: 500 })
  }
}
