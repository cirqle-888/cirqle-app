import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'

/**
 * Retainer-fee invoicing cron.
 *
 * Covered tasks deliberately never become invoice lines — the client pays the
 * monthly retainer instead. But nothing was creating that retainer line, so
 * every retainer invoice had to be assembled by hand. This cron makes the
 * invoice fully agreement-driven: on the 1st of each month it inserts one
 * line per active retainer item (client_agreement_items.unit_price) into the
 * client's month draft, via the ensure_retainer_invoice_lines() DB function
 * (migration 20260807110000).
 *
 * IDEMPOTENT: invoice_items.agreement_item_id is unique per invoice, and the
 * function skips any agreement+service already billed for the month (any
 * invoice, any term row) — re-running adds nothing and a manually deleted
 * line for a month stays deleted only if the whole month is already billed;
 * otherwise re-running restores it, which is the safe default for a fee the
 * agreement says is owed.
 *
 *   GET /api/cron/retainer-invoices            → current month
 *   GET /api/cron/retainer-invoices?month=YYYY-MM  → specific month (backfill)
 *
 * Auth: shared-secret Bearer token, same as every other cron. Monthly
 * schedule in vercel.json.
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false // fail closed — never run unauthenticated
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const monthParam = req.nextUrl.searchParams.get('month')
  const period = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
    ? `${monthParam}-01`
    : `${new Date().toISOString().slice(0, 7)}-01`

  try {
    const { data, error } = await admin.rpc('ensure_retainer_invoice_lines', { p_period: period })
    if (error) {
      await logCronRun(admin, 'retainer-invoices', false, { period }, error.message)
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }
    const added = typeof data === 'number' ? data : 0
    await logCronRun(admin, 'retainer-invoices', true, { period, linesAdded: added })
    return NextResponse.json({ ok: true, period, linesAdded: added })
  } catch (err: any) {
    await logCronRun(admin, 'retainer-invoices', false, { period }, err?.message || 'unknown')
    return NextResponse.json({ ok: false, error: err?.message || 'unknown' }, { status: 500 })
  }
}
