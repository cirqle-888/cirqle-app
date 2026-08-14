import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { duePeriods, type RecurringRule } from '@/lib/finance/recurring-schedule'
import { notifyAdmins } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'
import { todayISO } from '@/lib/utils/local-date'

/**
 * Recurring-expense auto-posting cron.
 *
 * Rent, internet, phone, software, AI tools, utilities, insurance, office
 * costs — configured once in Cash Book → Recurring, then posted here as
 * ordinary cashbook entries. From that moment the existing machinery takes
 * over: the scope trigger books them to the company, the chart of accounts
 * files them under opex/cogs, and the Company P&L and profit engine pick them
 * up with no further wiring.
 *
 * These entries reduce COMPANY PROFIT only. They never touch the contribution
 * pool or any employee's contribution earnings.
 *
 * Just-in-time, same rule as /api/cron/recurring-tasks: an occurrence posts on
 * its OWN due date, never early; a missed month is back-posted on its real
 * date, capped so a long outage can't flood the ledger on the first run back.
 *
 * IDEMPOTENCY: each entry carries reference = 'recurring:{ruleId}:{period}'.
 * Re-running the cron finds the reference and skips. The existence check
 * deliberately does NOT filter on deleted_at — an occurrence the owner
 * deliberately deleted must stay deleted, not be resurrected tomorrow.
 *
 *   GET /api/cron/recurring-expenses
 *
 * Auth: shared-secret Bearer token, same as every other cron. Daily schedule
 * in vercel.json; surfaced in the Business Health Center via KNOWN_CRONS.
 */

const MAX_CATCHUP_PER_RULE = 12
const MAX_TOTAL_PER_RUN = 200

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false // fail closed — never run unauthenticated
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

interface ExpenseRule extends RecurringRule {
  name: string
  category_id: string
  amount: number
  amount_inr: number
  currency: string | null
  bank_account_id: string | null
  client_id: string | null
  notes: string | null
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const todayStr = todayISO()

  const { data: rules, error: rulesErr } = await admin
    .from('recurring_expenses')
    .select('id, name, category_id, amount, amount_inr, currency, day_of_month, frequency, start_date, end_date, bank_account_id, client_id, notes')
    .eq('is_active', true)
    .lte('start_date', todayStr)

  if (rulesErr) {
    // A missing table means the feature simply isn't installed in this
    // environment — not a failure worth alerting on.
    const missing = /does not exist|PGRST205/i.test(rulesErr.message || '')
    if (missing) return NextResponse.json({ ok: true, rulesChecked: 0, entriesPosted: 0, note: 'not migrated' })
    await logCronRun(admin, 'recurring-expenses', false, undefined, rulesErr.message)
    return NextResponse.json({ ok: false, error: rulesErr.message }, { status: 500 })
  }
  if (!rules?.length) {
    await logCronRun(admin, 'recurring-expenses', true, { rulesChecked: 0, entriesPosted: 0 })
    return NextResponse.json({ ok: true, rulesChecked: 0, entriesPosted: 0 })
  }

  let totalPosted = 0
  const posted: { name: string; periods: string[] }[] = []
  const errors: string[] = []

  for (const raw of rules as unknown as ExpenseRule[]) {
    if (totalPosted >= MAX_TOTAL_PER_RUN) break

    // Which periods this rule has already posted. No deleted_at filter — see
    // the idempotency note above.
    const { data: existing, error: existErr } = await admin
      .from('cashbook_entries')
      .select('reference')
      .like('reference', `recurring:${raw.id}:%`)
    if (existErr) { errors.push(`${raw.name}: ${existErr.message}`); continue }
    const existingPeriods = (existing || [])
      .map(e => String((e as { reference: string }).reference).split(':')[2])
      .filter(Boolean)

    const remaining = Math.min(MAX_CATCHUP_PER_RULE, MAX_TOTAL_PER_RUN - totalPosted)
    const due = duePeriods(raw, todayStr, existingPeriods, remaining)
    if (due.length === 0) continue

    // `scope` is deliberately NOT set: the derive_cashbook_scope trigger
    // computes it from the client link / category default. Omitting the column
    // also means this insert works unchanged on databases that predate the
    // scope migration — no retryWithoutScope dance needed.
    const rows = due.map(o => ({
      entry_date: o.postDate,
      type: 'outflow',
      category_id: raw.category_id,
      client_id: raw.client_id,
      bank_account_id: raw.bank_account_id,
      amount: raw.amount,
      amount_inr: raw.amount_inr,
      currency: raw.currency || 'INR',
      description: `${raw.name} (recurring)`,
      notes: raw.notes,
      reference: `recurring:${raw.id}:${o.period}`,
    }))

    const { error: insertErr } = await admin.from('cashbook_entries').insert(rows)
    if (insertErr) { errors.push(`${raw.name}: ${insertErr.message}`); continue }

    totalPosted += rows.length
    posted.push({ name: raw.name, periods: due.map(o => o.period) })
  }

  if (totalPosted > 0) {
    void notifyAdmins({
      type: 'recurring_expenses_posted',
      title: `${totalPosted} recurring expense${totalPosted === 1 ? '' : 's'} posted`,
      message: posted.map(p => `${p.name} (${p.periods.join(', ')})`).join('; '),
      link: '/dashboard/cashbook',
      sourceKey: `recurring_expenses:${todayStr}`,
    })
  }

  await logCronRun(
    admin, 'recurring-expenses', errors.length === 0,
    { rulesChecked: rules.length, entriesPosted: totalPosted },
    errors.length ? errors.join('; ') : undefined,
  )
  return NextResponse.json({
    ok: errors.length === 0,
    rulesChecked: rules.length,
    entriesPosted: totalPosted,
    posted,
    errors: errors.length ? errors : undefined,
  })
}
