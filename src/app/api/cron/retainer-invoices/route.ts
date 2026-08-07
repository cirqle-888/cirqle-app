import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'
import { syncAgreementFeeLines, syncAgreementFeeHistory } from '@/lib/agreements/fee-lines'

/**
 * Agreement fee invoicing cron.
 *
 * Covered tasks deliberately never become invoice lines — the client pays the
 * agreement's fees instead. This job puts those fees on the invoice, so a
 * retainer client's bill is fully agreement-driven: the monthly retainer, any
 * one-time package fee, plus whatever extra-work tasks were flagged.
 *
 * All the logic lives in lib/agreements/fee-lines, shared with the invoice
 * Resync button and the agreement editor, so a fee reaches the invoice by the
 * same path however it is triggered. Re-running only ever converges: missing
 * lines are added, drifted prices corrected, issued invoices left alone.
 *
 *   GET /api/cron/retainer-invoices                      → current month
 *   GET /api/cron/retainer-invoices?month=YYYY-MM        → one month
 *   GET /api/cron/retainer-invoices?from=YYYY-MM         → backfill from..month
 *   GET /api/cron/retainer-invoices?...&dryRun=1         → report, change nothing
 *   GET /api/cron/retainer-invoices?...&clientId=UUID    → limit to one client
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

const isMonth = (v: string | null): v is string => !!v && /^\d{4}-\d{2}$/.test(v)

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const params = req.nextUrl.searchParams

  const monthParam = params.get('month')
  const month = isMonth(monthParam) ? monthParam : new Date().toISOString().slice(0, 7)
  const fromParam = params.get('from')
  const dryRun = params.get('dryRun') === '1'
  const clientId = params.get('clientId')

  try {
    if (isMonth(fromParam)) {
      const runs = await syncAgreementFeeHistory(admin, {
        clientId, fromMonth: fromParam, throughMonth: month, dryRun,
      })
      const totals = runs.reduce((acc, r) => ({
        added: acc.added + r.added,
        updated: acc.updated + r.updated,
        unchanged: acc.unchanged + r.unchanged,
        locked: acc.locked + r.lockedOnIssuedInvoice,
      }), { added: 0, updated: 0, unchanged: 0, locked: 0 })

      if (!dryRun) {
        await logCronRun(admin, 'retainer-invoices', true, { from: fromParam, month, ...totals })
      }
      return NextResponse.json({
        ok: true, dryRun, from: fromParam, through: month, ...totals,
        months: runs.map(r => ({
          month: r.month, added: r.added, updated: r.updated, unchanged: r.unchanged,
          lines: r.planned.map(p => ({ description: p.description, currency: p.currency, amount: p.amount })),
        })),
      })
    }

    const r = await syncAgreementFeeLines(admin, { month, clientId, dryRun })
    if (!dryRun) {
      await logCronRun(admin, 'retainer-invoices', true, {
        month, added: r.added, updated: r.updated, unchanged: r.unchanged,
      })
    }
    return NextResponse.json({
      ok: true, dryRun, month,
      added: r.added, updated: r.updated, unchanged: r.unchanged,
      lockedOnIssuedInvoice: r.lockedOnIssuedInvoice,
      lines: r.planned.map(p => ({ description: p.description, currency: p.currency, amount: p.amount })),
    })
  } catch (err: any) {
    await logCronRun(admin, 'retainer-invoices', false, { month }, err?.message || 'unknown')
    return NextResponse.json({ ok: false, error: err?.message || 'unknown' }, { status: 500 })
  }
}
