'use server'

/**
 * Ad funds — one-step top-ups and Meta funding-event triage.
 *
 * recordAdTopUp() is the "Add Fund" button: one call records the top-up in
 * the Cashbook (default bank from Settings, Online Spend category, tagged to
 * the client and the ad account), credits the client's wallet, allocates it
 * to the client's running campaign on that account, and links it to Meta's
 * funding event when one is known. Because the entry carries ad_account_id it
 * is NEVER rebilled as an expense — the client is billed actual spend + GST.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { todayISO, toISODate } from '@/lib/utils/local-date'
import { reconcileAccountFunding, syncAccountBilling } from '@/lib/advertising/meta-billing'
import { syncAccountAdSpendLines } from '@/lib/advertising/ad-spend-invoicing'
import { addClientFund, addCompanyFund, allocateToCampaign } from '../actions'
import { asRow, asRows, num, type AdAccountRow, type FundingEventRow } from '@/lib/advertising/funds-rows'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const MIGRATION_MISSING = 'Ad funds tables are not set up yet — apply migration 20261027120000_ad_funds_autopilot.sql first.'
const r2 = (v: number) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100

function revalidateAll(projectId?: string | null) {
  revalidatePath('/dashboard/advertising')
  revalidatePath('/dashboard/advertising/funds')
  revalidatePath('/dashboard/cashbook')
  revalidatePath('/dashboard/invoices')
  if (projectId) revalidatePath(`/dashboard/advertising/${projectId}`)
}

export interface RecordTopUpInput {
  /** null = Cirqle's own (company) wallet. */
  clientId: string | null
  /** ad_accounts.id the money was paid into. */
  adAccountId: string
  amount: number
  /** YYYY-MM-DD; defaults to today (or the Meta event's date). */
  entryDate?: string | null
  /** Defaults to the bank marked default in Settings › Bank accounts. */
  bankAccountId?: string | null
  /** Campaign to allocate to; defaults to the client's only running campaign on the account. */
  projectId?: string | null
  /** UPI / transaction reference. */
  reference?: string | null
  /** A detected Meta funding event this top-up records. */
  fundingEventId?: string | null
}

export async function recordAdTopUp(input: RecordTopUpInput): Promise<ActionResult<{ entryId: string; allocatedTo: string | null; warning?: string }>> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  // ── Funding event (when recording one Meta already reported) ──────────────
  let event: FundingEventRow | null = null
  if (input.fundingEventId) {
    const { data, error } = await admin.from('ad_funding_events')
      .select('id, ad_account_id, status, amount, event_time, cashbook_entry_id, suggested_client_id, dismissed_at')
      .eq('id', input.fundingEventId).maybeSingle()
    if (error) return { ok: false, error: MIGRATION_MISSING }
    event = asRow<FundingEventRow>(data)
    if (!event) return { ok: false, error: 'That Meta payment was not found.' }
    if (event.cashbook_entry_id) return { ok: false, error: 'That Meta payment is already recorded in the Cashbook.' }
    if (event.status !== 'successful') return { ok: false, error: 'Only successful Meta payments can be recorded.' }
  }

  const amount = r2(Number(input.amount) || num(event?.amount))
  if (amount <= 0) return { ok: false, error: 'Enter the amount you added.' }
  const adAccountId = event?.ad_account_id ?? input.adAccountId
  if (!adAccountId) return { ok: false, error: 'Pick the ad account the money went into.' }

  const entryDate = input.entryDate || (event ? toISODate(new Date(event.event_time)) : todayISO())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return { ok: false, error: 'Invalid date.' }

  // ── Lookups: account, client, default bank, category ──────────────────────
  const [accRes, clientRes, bankRes, catRes] = await Promise.all([
    admin.from('ad_accounts').select('id, name, account_id, currency').eq('id', adAccountId).maybeSingle(),
    input.clientId
      ? admin.from('clients').select('id, name, code').eq('id', input.clientId).maybeSingle()
      : Promise.resolve({ data: null }),
    input.bankAccountId
      ? admin.from('bank_accounts').select('id, name').eq('id', input.bankAccountId).maybeSingle()
      : admin.from('bank_accounts').select('id, name').eq('is_default', true).limit(1).maybeSingle(),
    admin.from('cashbook_categories').select('id').eq('account_code', 'cogs.ad_spend').limit(1).maybeSingle(),
  ])
  const account = asRow<AdAccountRow>(accRes.data)
  if (!account) return { ok: false, error: 'Ad account not found.' }
  const client = asRow<{ id: string; name: string }>(clientRes.data)
  if (input.clientId && !client) return { ok: false, error: 'Client not found.' }
  const bank = asRow<{ id: string; name: string }>(bankRes.data)
  if (!bank) return { ok: false, error: 'No bank account selected and no default bank is set in Settings › Bank accounts.' }
  let categoryId = asRow<{ id: string }>(catRes.data)?.id
  if (!categoryId) {
    const { data: byName } = await admin.from('cashbook_categories').select('id').ilike('name', 'Online Spend').limit(1).maybeSingle()
    categoryId = asRow<{ id: string }>(byName)?.id
  }
  if (!categoryId) return { ok: false, error: 'No "Online Spend" (cogs.ad_spend) cashbook category found.' }

  const who = client?.name ?? 'Cirqle (company)'
  const description = `Meta ad top-up — ${who} — ${account.name || account.account_id}`

  // ── 1. Cashbook entry ─────────────────────────────────────────────────────
  // Plain insert (no "retry without missing columns"): without ad_account_id
  // the entry would be auto-rebilled as an expense, so a missing migration
  // must fail loudly here instead of silently double-billing.
  const { data: entry, error: entryErr } = await admin.from('cashbook_entries').insert({
    type: 'outflow',
    amount, currency: 'INR', amount_inr: amount,
    exchange_rate: 1, rate_source: 'manual', rate_date: entryDate,
    entry_date: entryDate,
    category_id: categoryId,
    bank_account_id: bank.id,
    client_id: input.clientId,
    scope: input.clientId ? 'client' : 'company',
    description,
    reference: input.reference?.trim() || null,
    invoice_id: null,
    ad_account_id: adAccountId,
    created_by: guard.employeeId,
  }).select('id').single()
  if (entryErr || !entry) {
    return { ok: false, error: /ad_account_id|column/i.test(entryErr?.message ?? '') ? MIGRATION_MISSING : (entryErr?.message || 'Could not record the top-up.') }
  }
  const entryId = asRow<{ id: string }>(entry)?.id as string

  // ── 2. Wallet credit ──────────────────────────────────────────────────────
  // New installs credit client-tagged funding atomically with the Cashbook insert.
  // Keep the old credit path for company wallets and pre-migration installs.
  const { data: autoCredit } = await admin.from('ad_wallet_ledger')
    .select('id').eq('cashbook_entry_id', entryId).eq('cashbook_auto_credit', true)
    .is('deleted_at', null).maybeSingle()
  const credit = autoCredit ? { ok: true as const } : input.clientId
    ? await addClientFund(input.clientId, { cashbookEntryId: entryId, amount, notes: 'Meta top-up' })
    : await addCompanyFund({ cashbookEntryId: entryId, amount, notes: 'Meta top-up' })
  if (!credit.ok) {
    // Undo the entry so the books never hold an orphan top-up.
    await admin.from('cashbook_entries').update({ deleted_at: new Date().toISOString() }).eq('id', entryId)
    return { ok: false, error: credit.error || 'Could not credit the wallet.' }
  }

  // ── 3. Allocate to the running campaign ───────────────────────────────────
  let projectId = input.projectId ?? null
  if (!projectId) {
    let q = admin.from('ad_projects').select('id').eq('ad_account_id', adAccountId)
      .is('deleted_at', null).in('status', ['active', 'paused'])
    q = input.clientId ? q.eq('client_id', input.clientId) : q.eq('scope', 'company')
    const { data: running } = await q
    const live = asRows<{ id: string }>(running)
    if (live.length === 1) projectId = live[0].id
  }
  let warning: string | undefined
  let allocatedTo: string | null = null
  if (projectId) {
    const alloc = await allocateToCampaign(projectId, { amount, notes: 'Meta top-up' })
    if (alloc.ok) allocatedTo = projectId
    else warning = `Wallet credited, but allocation failed: ${alloc.error}`
  } else {
    warning = 'Wallet credited. Pick a campaign to allocate it to — this client has more than one (or no) running campaign on this account.'
  }

  // ── 4. Link Meta's confirmation ───────────────────────────────────────────
  if (event) {
    await admin.from('ad_funding_events').update({
      cashbook_entry_id: entryId, matched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', event.id)
  } else {
    await reconcileAccountFunding(admin, adAccountId)
  }

  void logActivity({
    actorId: guard.employeeId, entityType: 'cashbook', entityId: entryId,
    action: 'expense_added', category: 'finance', clientId: input.clientId,
    detail: { label: description, amount, currency: 'INR' },
  })

  revalidateAll(allocatedTo)
  return { ok: true, data: { entryId, allocatedTo, warning } }
}

/**
 * A Meta payment that WAS recorded, but as a plain Cashbook entry: link them,
 * and mark the entry as an ad top-up (which takes it off any draft invoice it
 * was auto-rebilled onto — the client is billed actual spend instead).
 */
export async function linkFundingEventToEntry(eventId: string, entryId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data: evData, error } = await admin.from('ad_funding_events')
    .select('id, ad_account_id, cashbook_entry_id').eq('id', eventId).maybeSingle()
  if (error) return { ok: false, error: MIGRATION_MISSING }
  const ev = asRow<Pick<FundingEventRow, 'id' | 'ad_account_id' | 'cashbook_entry_id'>>(evData)
  if (!ev) return { ok: false, error: 'Meta payment not found.' }
  if (ev.cashbook_entry_id) return { ok: false, error: 'Already linked.' }
  const { data: taken } = await admin.from('ad_funding_events').select('id').eq('cashbook_entry_id', entryId).limit(1).maybeSingle()
  if (taken) return { ok: false, error: 'That Cashbook entry is already linked to another Meta payment.' }

  const { error: upErr } = await admin.from('cashbook_entries')
    .update({ ad_account_id: ev.ad_account_id }).eq('id', entryId).eq('type', 'outflow')
  if (upErr) return { ok: false, error: upErr.message }
  await admin.from('ad_funding_events').update({
    cashbook_entry_id: entryId, matched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', eventId)
  revalidateAll()
  return { ok: true }
}

/** Hide a Meta payment from the to-do list (e.g. a refund handled elsewhere). */
export async function dismissFundingEvent(eventId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('ad_funding_events')
    .update({ dismissed_at: new Date().toISOString(), dismissed_by: guard.employeeId })
    .eq('id', eventId)
  if (error) return { ok: false, error: error.message }
  revalidateAll()
  return { ok: true }
}

/** "Sync now" — pull balance, payments and spend from Meta for every account. */
export async function syncAdBillingNow(): Promise<ActionResult<{ accounts: number; failed: string[] }>> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data: accounts, error } = await admin.from('ad_accounts')
    .select('id, name').eq('is_active', true).eq('provider', 'meta')
  if (error) return { ok: false, error: error.message }
  const failed: string[] = []
  const list = asRows<{ id: string; name: string }>(accounts)
  for (const a of list) {
    const r = await syncAccountBilling(admin, a.id)
    if (r.ok) await syncAccountAdSpendLines(admin, a.id)
    else failed.push(`${a.name}: ${r.error}`)
  }
  revalidateAll()
  return { ok: true, data: { accounts: list.length, failed } }
}
