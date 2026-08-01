'use server'

/**
 * Advertising module — server actions.
 *
 * Follows the house shape used everywhere else: requirePermission/-AnyPermission
 * guard → admin DB mutation → fire-and-forget event log → revalidatePath. Reuses
 * existing primitives (generateInvoiceNumber, nextTaskNumber, computeBudgetTotals)
 * and never duplicates the tasks / invoices tables — it links to them.
 */

import { revalidatePath } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireAnyPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { generateInvoiceNumber } from '@/lib/invoices/numbering'
import { nextTaskNumber } from '@/lib/utils/task-code'
import { computeBudgetTotals, computeServiceCharge } from '@/lib/advertising/budget'
import { recomputeCampaignBilling, writeInvoiceLines } from '@/lib/advertising/billing'
import { getWalletSummary, getCompanyWalletSummary, getEntryUncredited } from '@/lib/advertising/wallet'
import { createManualRequest } from '@/app/(dashboard)/dashboard/requests/actions'
import { logRequestActivity } from '@/lib/requests/core'
import { logActivity } from '@/lib/activity/log'
import { deriveWorkScope, retryWithoutScope, withoutScope } from '@/lib/finance/classify'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const REVALIDATE = '/dashboard/advertising'
const VALID_STATUS = ['draft', 'pending_approval', 'active', 'paused', 'completed', 'cancelled']

const today = () => new Date().toISOString().slice(0, 10)

/** Convert an amount to INR via exchange_rates (mirrors tasks/actions.ts toInr). */
async function toInr(admin: SupabaseClient, amount: number, currency?: string | null): Promise<number> {
  if (!currency || currency === 'INR') return amount
  const { data } = await admin.from('exchange_rates').select('rate_to_inr').eq('currency', currency).maybeSingle()
  const rate = (data as any)?.rate_to_inr ?? 1
  return Math.round(amount * rate * 100) / 100
}

/**
 * Persist the daily-budget metadata (best-effort). ad_budget_amount already
 * holds the resolved total, so if the daily-budget migration hasn't been applied
 * these columns simply don't update — the campaign budget still works.
 */
async function persistBudgetMeta(
  admin: SupabaseClient,
  id: string,
  meta: { mode?: string | null; dailyBudget?: number | null; budgetDays?: number | null },
): Promise<void> {
  const daily = meta.mode === 'daily'
  try {
    await admin.from('ad_projects').update({
      budget_input_mode: daily ? 'daily' : 'total',
      daily_budget: daily ? (meta.dailyBudget ?? null) : null,
      budget_days: daily ? (meta.budgetDays ?? null) : null,
    }).eq('id', id)
  } catch { /* daily-budget columns not migrated — resolved total already saved */ }
}

/** Append a timeline/audit row. Never throws. */
async function logAdEvent(
  admin: SupabaseClient,
  projectId: string,
  eventType: string,
  actorId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await admin.from('ad_events').insert({
      project_id: projectId, event_type: eventType, actor_id: actorId, detail: detail ?? null,
    })
  } catch { /* events table not migrated / transient — never block the action */ }
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface CreateAdProjectInput {
  clientId?: string | null
  campaignName: string
  platform?: string
  campaignType?: string | null
  status?: string
  /** Resolved total ad spend (the form computes daily×days into this). */
  adBudget?: number
  adBudgetCurrency?: string
  /** Budget entry metadata (persisted best-effort for re-editing). */
  budgetInputMode?: 'total' | 'daily'
  dailyBudget?: number | null
  budgetDays?: number | null
  /** The advertising service from the Services catalog (drives pricing + contribution parameters). */
  serviceId?: string | null
  serviceChargeType?: 'fixed' | 'percent'
  serviceChargeValue?: number
  taxPercent?: number
  objective?: string | null
  optimizationGoal?: string | null
  startDate?: string | null
  endDate?: string | null
  requestId?: string | null
}

/**
 * Create the SINGLE task that represents a campaign's work (replaces the old
 * 7-task checklist). It is a normal Cirqle task — the chosen advertising service
 * drives its contribution parameters, so the work breakdown (setup, creative,
 * media buying, …) is split via Contributions, not separate tasks. Billing =
 * the agency service charge, so team earnings flow from the agency fee (the ad
 * spend is a pass-through, billed separately on the campaign invoice).
 */
export async function createCampaignTask(
  admin: SupabaseClient,
  opts: {
    projectId: string; campaignName: string; clientId: string | null;
    serviceId: string | null; serviceCharge: number; currency: string; employeeId: string;
  },
): Promise<string | null> {
  try {
    const { data: maxRow } = await admin
      .from('tasks').select('task_number')
      .order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    const billingInr = await toInr(admin, opts.serviceCharge, opts.currency)
    const taskRow = {
      task_number: nextTaskNumber((maxRow as any)?.task_number),
      title: opts.campaignName,
      client_id: opts.clientId,
      service_id: opts.serviceId,
      status: 'pending',
      task_date: today(),
      billing_amount: opts.serviceCharge,
      billing_amount_inr: billingInr,
      currency: opts.currency,
      created_by: opts.employeeId,
      scope: deriveWorkScope(opts.clientId),
    }
    const { data: t } = await retryWithoutScope(strip =>
      admin.from('tasks').insert(strip ? withoutScope(taskRow) : taskRow).select('id').single()
    )
    if (!t) return null
    await admin.from('ad_project_tasks').insert({ project_id: opts.projectId, task_id: (t as any).id })
    return (t as any).id
  } catch { return null /* tasks shape differs / transient — campaign still created */ }
}

export async function createAdProject(
  input: CreateAdProjectInput,
): Promise<ActionResult<{ id: string; taskId: string | null }>> {
  const guard = await requirePermission(PERMS.ADVERTISING_CREATE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = (input.campaignName || '').trim()
  if (!name) return { ok: false, error: 'Campaign name is required.' }

  const admin = createAdminClient()
  const projectRow = {
    client_id:            input.clientId || null,
    request_id:           input.requestId || null,
    campaign_name:        name,
    platform:             input.platform || 'meta',
    campaign_type:        input.campaignType || null,
    status:               VALID_STATUS.includes(input.status || '') ? input.status : 'draft',
    ad_budget_amount:     input.adBudget ?? 0,
    ad_budget_currency:   input.adBudgetCurrency || 'INR',
    service_charge_type:  input.serviceChargeType || 'fixed',
    service_charge_value: input.serviceChargeValue ?? 0,
    tax_percent:          input.taxPercent ?? 0,
    objective:            input.objective || null,
    optimization_goal:    input.optimizationGoal || null,
    start_date:           input.startDate || null,
    end_date:             input.endDate || null,
    created_by:           guard.employeeId,
    scope:                deriveWorkScope(input.clientId || null),
  }
  const { data, error } = await retryWithoutScope(strip =>
    admin.from('ad_projects').insert(strip ? withoutScope(projectRow) : projectRow).select('id').single()
  )

  if (error) return { ok: false, error: error.message }
  const id = (data as any).id as string

  await persistBudgetMeta(admin, id, {
    mode: input.budgetInputMode, dailyBudget: input.dailyBudget, budgetDays: input.budgetDays,
  })
  // Persist the chosen advertising service (best-effort — column added by the
  // service/requests migration; ad_budget_amount etc. already saved regardless).
  if (input.serviceId) {
    try { await admin.from('ad_projects').update({ service_id: input.serviceId }).eq('id', id) } catch { /* not migrated */ }
  }
  await logAdEvent(admin, id, 'created', guard.employeeId, {
    campaign_name: name, request_id: input.requestId || null,
  })
  void logActivity({
    actorId: guard.employeeId, entityType: 'project', entityId: id,
    action: 'created', clientId: input.clientId || null, projectId: id,
    detail: { label: name },
  })

  // One task per campaign (the work item). Billing = the agency service charge.
  // Company (internal) campaigns have no one to charge: the task starts at 0 —
  // any contribution pool for internal work is a deliberate manual decision.
  const serviceCharge = input.clientId
    ? computeServiceCharge(
        input.adBudget ?? 0, input.serviceChargeType || 'fixed', input.serviceChargeValue ?? 0,
      )
    : 0
  const taskId = await createCampaignTask(admin, {
    projectId: id,
    campaignName: name,
    clientId: input.clientId || null,
    serviceId: input.serviceId || null,
    serviceCharge,
    currency: input.adBudgetCurrency || 'INR',
    employeeId: guard.employeeId,
  })

  revalidatePath(REVALIDATE); revalidatePath('/dashboard/tasks')
  return { ok: true, data: { id, taskId } }
}

export async function generateTaskForProject(projectId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  
  const { data: existing } = await admin.from('ad_project_tasks').select('task_id').eq('project_id', projectId).maybeSingle()
  if (existing) return { ok: false, error: 'Task already linked' }

  const { data: project, error: projErr } = await admin.from('ad_projects').select('*').eq('id', projectId).single()
  if (projErr || !project) return { ok: false, error: 'Project not found' }

  const serviceCharge = computeServiceCharge(
    project.ad_budget_amount ?? 0, project.service_charge_type || 'fixed', project.service_charge_value ?? 0
  )

  const taskId = await createCampaignTask(admin, {
    projectId,
    campaignName: project.campaign_name,
    clientId: project.client_id,
    serviceId: project.service_id,
    serviceCharge,
    currency: project.ad_budget_currency || 'INR',
    employeeId: guard.employeeId,
  })

  if (!taskId) return { ok: false, error: 'Failed to create task' }

  revalidatePath(REVALIDATE); revalidatePath(`${REVALIDATE}/${projectId}`)
  return { ok: true }
}

export interface UpdateAdProjectInput {
  campaignName?: string
  platform?: string
  campaignType?: string | null
  objective?: string | null
  optimizationGoal?: string | null
  startDate?: string | null
  endDate?: string | null
  notes?: string | null
}

export async function updateAdProject(id: string, patch: UpdateAdProjectInput): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.campaignName !== undefined)     upd.campaign_name = patch.campaignName.trim()
  if (patch.platform !== undefined)         upd.platform = patch.platform
  if (patch.campaignType !== undefined)     upd.campaign_type = patch.campaignType
  if (patch.objective !== undefined)        upd.objective = patch.objective
  if (patch.optimizationGoal !== undefined) upd.optimization_goal = patch.optimizationGoal
  if (patch.startDate !== undefined)        upd.start_date = patch.startDate
  if (patch.endDate !== undefined)          upd.end_date = patch.endDate
  if (patch.notes !== undefined)            upd.notes = patch.notes

  const { error } = await admin.from('ad_projects').update(upd).eq('id', id)
  if (error) return { ok: false, error: error.message }
  await logAdEvent(admin, id, 'updated', guard.employeeId, {})
  revalidatePath(REVALIDATE); revalidatePath(`${REVALIDATE}/${id}`)
  return { ok: true }
}

export async function updateAdStatus(id: string, status: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!VALID_STATUS.includes(status)) return { ok: false, error: 'Invalid status.' }

  const admin = createAdminClient()
  const { error } = await admin.from('ad_projects')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  await logAdEvent(admin, id, 'status_changed', guard.employeeId, { to: status })
  void logActivity({
    actorId: guard.employeeId, entityType: 'project', entityId: id,
    action: 'status_changed', projectId: id, detail: { to: status },
  })
  revalidatePath(REVALIDATE); revalidatePath(`${REVALIDATE}/${id}`)
  return { ok: true }
}

/**
 * Archive / unarchive a campaign. Archived campaigns leave the dashboard, stop
 * syncing and stop alerting, but keep all data (metrics, wallet ledger, task,
 * invoices) — unarchiving restores them exactly as they were.
 */
export async function setAdProjectArchived(id: string, archived: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('ad_projects')
    .update({ archived_at: archived ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    return {
      ok: false,
      error: error.message.includes('archived_at')
        ? 'Archiving needs a database migration — apply 20260703150000_ad_projects_archive.sql first.'
        : error.message,
    }
  }
  await logAdEvent(admin, id, archived ? 'archived' : 'unarchived', guard.employeeId, {})
  revalidatePath(REVALIDATE); revalidatePath(`${REVALIDATE}/${id}`)
  return { ok: true }
}

export async function softDeleteAdProject(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_DELETE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('ad_projects')
    .update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  await logAdEvent(admin, id, 'deleted', guard.employeeId, {})
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Budget + invoice sync ─────────────────────────────────────────────────

export interface SaveAdBudgetInput {
  /** Resolved total ad spend (daily×days already applied by the caller). */
  adBudget: number
  adBudgetCurrency?: string
  budgetInputMode?: 'total' | 'daily'
  dailyBudget?: number | null
  budgetDays?: number | null
  serviceChargeType: 'fixed' | 'percent'
  serviceChargeValue: number
  taxPercent?: number
}

export async function saveAdBudget(id: string, budget: SaveAdBudgetInput): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('ad_projects').update({
    ad_budget_amount:     budget.adBudget ?? 0,
    ad_budget_currency:   budget.adBudgetCurrency || 'INR',
    service_charge_type:  budget.serviceChargeType,
    service_charge_value: budget.serviceChargeValue ?? 0,
    tax_percent:          budget.taxPercent ?? 0,
    updated_at:           new Date().toISOString(),
  }).eq('id', id)
  if (error) return { ok: false, error: error.message }

  await persistBudgetMeta(admin, id, {
    mode: budget.budgetInputMode, dailyBudget: budget.dailyBudget, budgetDays: budget.budgetDays,
  })
  await logAdEvent(admin, id, 'budget_changed', guard.employeeId, { ad_budget: budget.adBudget })
  // Re-derive the task billing from the latest basis (allocated funds when any
  // exist, else this estimated budget) and resync any linked draft invoice.
  await recomputeCampaignBilling(admin, id)

  revalidatePath(REVALIDATE); revalidatePath(`${REVALIDATE}/${id}`); revalidatePath('/dashboard/invoices'); revalidatePath('/dashboard/tasks')
  return { ok: true }
}

// ─── Client wallet ledger (Cashbook → client wallet → campaign) ─────────────
//
// The agency funds the platform in advance (one Cashbook outflow, e.g. a
// ₹20,000 Meta top-up). That money is CREDITED to client wallets, then
// DEBITED to campaigns. Every movement is a ledger transaction (full audit
// trail); balances are always derived from the rows. The campaign's debited
// total — GST-inclusive, actually-paid money — is the billing basis; the
// platform-reported spend stays reporting-only.

const LEDGER_MISSING = 'Wallet ledger not available yet — apply migration 20260703140000_ad_wallet_ledger.sql first.'

export interface AddClientFundInput {
  cashbookEntryId: string
  amount: number
  notes?: string | null
}

/** CREDIT: assign a share of a Cashbook outflow (top-up) to a client's wallet. */
export async function addClientFund(
  clientId: string, input: AddClientFundInput,
): Promise<ActionResult> {
  if (!clientId) return { ok: false, error: 'Client is required.' }
  return creditWallet(clientId, input)
}

/**
 * CREDIT the COMPANY wallet: a share of a Cashbook outflow reserved for
 * Cirqle's own (company-scoped) campaigns. Same rails as client wallets —
 * client_id NULL is the company wallet (migration 20260714093000).
 */
export async function addCompanyFund(input: AddClientFundInput): Promise<ActionResult> {
  return creditWallet(null, input)
}

async function creditWallet(
  clientId: string | null, input: AddClientFundInput,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }

  const amount = Math.round((Number(input.amount) || 0) * 100) / 100
  if (amount <= 0) return { ok: false, error: 'Amount must be greater than zero.' }

  const admin = createAdminClient()

  // Preferred path: atomic DB credit (migration 20260714095000). The function
  // row-locks the funding entry, so concurrent credits can never over-credit
  // it — the TS path below has an unavoidable check-then-insert window.
  const rpc = await (admin as any).rpc('credit_ad_wallet', {
    p_client_id: clientId,
    p_entry_id: input.cashbookEntryId,
    p_amount: amount,
    p_notes: input.notes?.trim() || null,
    p_created_by: guard.employeeId,
  })
  if (!rpc.error) {
    revalidatePath(REVALIDATE)
    return { ok: true }
  }
  const fnMissing = rpc.error.code === 'PGRST202' || rpc.error.code === '42883'
    || /could not find the function|function .* does not exist/i.test(rpc.error.message ?? '')
  if (!fnMissing) {
    // Real validation failure raised by the DB — its message is user-facing.
    return { ok: false, error: rpc.error.message }
  }

  // Legacy fallback (RPC not applied yet): app-side validation + insert.
  const { data: entry, error: entryErr } = await admin
    .from('cashbook_entries')
    .select('id, type, amount, amount_inr, currency, deleted_at')
    .eq('id', input.cashbookEntryId).maybeSingle()
  if (entryErr || !entry) return { ok: false, error: 'Cashbook entry not found.' }
  if ((entry as any).deleted_at) return { ok: false, error: 'That cashbook entry was deleted.' }
  if ((entry as any).type !== 'outflow') return { ok: false, error: 'Wallet credits must come from an outflow (payment) entry.' }

  // Over-crediting guard: total credited across ALL clients stays within the entry.
  const entryAmount = Number((entry as any).amount || 0)
  const uncredited = await getEntryUncredited(admin, input.cashbookEntryId, entryAmount)
  if (uncredited === Infinity) return { ok: false, error: LEDGER_MISSING }
  if (amount > uncredited + 0.005) {
    return { ok: false, error: `Only ₹${uncredited.toLocaleString('en-IN')} of this entry is still unassigned.` }
  }

  // INR normalisation: proportional share of the entry's stored amount_inr.
  const entryInr = Number((entry as any).amount_inr || 0) || entryAmount
  const amountInr = entryAmount > 0
    ? Math.round((entryInr * (amount / entryAmount)) * 100) / 100
    : amount

  const { error } = await admin.from('ad_wallet_ledger').insert({
    client_id: clientId,
    direction: 'credit',
    kind: 'topup',
    cashbook_entry_id: input.cashbookEntryId,
    amount,
    amount_inr: amountInr,
    notes: input.notes?.trim() || null,
    created_by: guard.employeeId,
  })
  if (error) {
    if (clientId === null && /not-null|null value/i.test(error.message)) {
      return { ok: false, error: 'Company wallet not enabled yet — apply migration 20260714093000_finance_views_company_wallet.sql first.' }
    }
    return { ok: false, error: error.message.includes('does not exist') ? LEDGER_MISSING : error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** DEBIT: allocate from the campaign's client wallet to the campaign. */
export async function allocateToCampaign(
  projectId: string, input: { amount: number; notes?: string | null },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }

  const amount = Math.round((Number(input.amount) || 0) * 100) / 100
  if (amount <= 0) return { ok: false, error: 'Amount must be greater than zero.' }

  const admin = createAdminClient()
  const { data: project } = await admin
    .from('ad_projects').select('*')
    .eq('id', projectId).is('deleted_at', null).maybeSingle()
  if (!project) return { ok: false, error: 'Campaign not found.' }
  const clientId = (project as any).client_id as string | null
  const isCompanyCampaign = (project as any).scope === 'company'
  if (!clientId && !isCompanyCampaign) {
    return { ok: false, error: 'Assign a client to this campaign before allocating funds.' }
  }

  // Company campaigns draw from the company wallet (client_id NULL rows).
  const wallet = clientId
    ? await getWalletSummary(admin, clientId)
    : await getCompanyWalletSummary(admin)
  if (amount > wallet.balanceInr + 0.005) {
    const which = clientId ? 'Client wallet' : 'Company wallet'
    return { ok: false, error: `${which} has only ₹${wallet.balanceInr.toLocaleString('en-IN')} available. Add funds to the wallet first.` }
  }

  const { error } = await admin.from('ad_wallet_ledger').insert({
    client_id: clientId,
    direction: 'debit',
    kind: 'campaign_allocation',
    ad_project_id: projectId,
    amount,          // debits are entered in INR (the base currency)
    amount_inr: amount,
    notes: input.notes?.trim() || null,
    created_by: guard.employeeId,
  })
  if (error) return { ok: false, error: error.message.includes('does not exist') ? LEDGER_MISSING : error.message }

  await logAdEvent(admin, projectId, 'funds_allocated', guard.employeeId, { amount })
  await recomputeCampaignBilling(admin, projectId)

  revalidatePath(REVALIDATE); revalidatePath(`${REVALIDATE}/${projectId}`)
  revalidatePath('/dashboard/invoices'); revalidatePath('/dashboard/tasks')
  return { ok: true }
}

/**
 * Reverse a ledger transaction (soft delete — the row stays for audit).
 * Credits are blocked when removing them would push the wallet negative.
 */
export async function removeWalletTransaction(ledgerId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_BUDGET)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: row } = await admin
    .from('ad_wallet_ledger')
    .select('id, client_id, direction, kind, ad_project_id, amount, amount_inr')
    .eq('id', ledgerId).is('deleted_at', null).maybeSingle()
  if (!row) return { ok: false, error: 'Transaction not found.' }

  if ((row as any).direction === 'credit') {
    const rowClientId = (row as any).client_id as string | null
    const wallet = rowClientId
      ? await getWalletSummary(admin, rowClientId)
      : await getCompanyWalletSummary(admin)
    if (wallet.balanceInr - Number((row as any).amount_inr || 0) < -0.005) {
      return { ok: false, error: 'Removing this credit would make the wallet negative — remove campaign allocations first.' }
    }
  }

  const { error } = await admin.from('ad_wallet_ledger')
    .update({ deleted_at: new Date().toISOString() }).eq('id', ledgerId)
  if (error) return { ok: false, error: error.message }

  const projectId = (row as any).ad_project_id as string | null
  if (projectId) {
    await logAdEvent(admin, projectId, 'allocation_removed', guard.employeeId, {
      ledger_id: ledgerId, amount: (row as any).amount,
    })
    await recomputeCampaignBilling(admin, projectId)
  }

  revalidatePath(REVALIDATE)
  if (projectId) { revalidatePath(`${REVALIDATE}/${projectId}`); revalidatePath('/dashboard/invoices'); revalidatePath('/dashboard/tasks') }
  return { ok: true }
}

export async function createInvoiceForProject(projectId: string): Promise<ActionResult<{ invoiceId: string }>> {
  const guard = await requireAnyPermission([PERMS.ADVERTISING_MANAGE_BUDGET, PERMS.BILLING_EDIT])
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: project } = await admin.from('ad_projects')
    .select('*, client:clients(id, code, name, default_currency)').eq('id', projectId).maybeSingle()
  if (!project) return { ok: false, error: 'Campaign not found.' }
  if (!(project as any).client_id) return { ok: false, error: 'Add a client to the campaign before invoicing.' }

  // Reuse an existing draft invoice for this project rather than duplicating.
  const { data: existing } = await admin.from('invoices')
    .select('id, status').eq('ad_project_id', projectId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing && (existing as any).status === 'draft') {
    await writeInvoiceLines(admin, projectId, (existing as any).id, project)
    revalidatePath(REVALIDATE); revalidatePath('/dashboard/invoices')
    return { ok: true, data: { invoiceId: (existing as any).id } }
  }

  const clientCode = (project as any).client?.code || '000'
  const currency = (project as any).ad_budget_currency || (project as any).client?.default_currency || 'INR'
  const { invoiceNumber } = await generateInvoiceNumber(admin, new Date(), clientCode)
  const totals = computeBudgetTotals({
    adBudget: Number((project as any).ad_budget_amount || 0),
    serviceChargeType: (project as any).service_charge_type,
    serviceChargeValue: Number((project as any).service_charge_value || 0),
    taxPercent: Number((project as any).tax_percent || 0),
  })

  const { data: inv, error } = await admin.from('invoices').insert({
    invoice_number: invoiceNumber,
    client_id: (project as any).client_id,
    issue_date: today(),
    status: 'draft',
    currency,
    total_amount: totals.subtotal,
    paid_amount: 0,
    ad_project_id: projectId,
    ad_spend_mode: 'separate',
    created_by: guard.employeeId,
  }).select('id').single()
  if (error) return { ok: false, error: error.message }

  await writeInvoiceLines(admin, projectId, (inv as any).id, project)
  await logAdEvent(admin, projectId, 'invoice_created', guard.employeeId, {
    invoice_id: (inv as any).id, invoice_number: invoiceNumber,
  })
  void logActivity({
    actorId: guard.employeeId, entityType: 'invoice', entityId: (inv as any).id,
    action: 'generated', category: 'billing',
    clientId: (project as any).client_id ?? null, projectId,
    detail: { label: invoiceNumber },
  })

  revalidatePath(REVALIDATE); revalidatePath('/dashboard/invoices')
  return { ok: true, data: { invoiceId: (inv as any).id } }
}

// ─── Daily metrics ───────────────────────────────────────────────────────────

export interface DailyMetricInput {
  metricDate: string
  spend?: number | null
  revenue?: number | null
  reach?: number | null
  impressions?: number | null
  clicks?: number | null
  conversions?: number | null
  leads?: number | null
  messages?: number | null
  purchases?: number | null
  videoViews?: number | null
  landingPageViews?: number | null
  addsToCart?: number | null
  checkouts?: number | null
  ctr?: number | null
  cpc?: number | null
  cpm?: number | null
  cpr?: number | null
  roas?: number | null
  frequency?: number | null
  resultCost?: number | null
  remainingBudget?: number | null
  currency?: string
  notes?: string | null
}

export async function upsertDailyMetric(projectId: string, row: DailyMetricInput): Promise<ActionResult> {
  const guard = await requireAnyPermission([PERMS.ADVERTISING_ENTER_METRICS, PERMS.ADVERTISING_EDIT])
  if (!guard.ok) return { ok: false, error: guard.error }
  
  const admin = createAdminClient()
  const res = await upsertDailyMetricInternal(projectId, row.metricDate, row, 'Manual', guard.employeeId)
  if (res.ok) {
    await logAdEvent(admin, projectId, 'metric_entered', guard.employeeId, { date: row.metricDate })
  }
  return res
}

/** Internal upsert that bypasses permission checks (used by API sync engines). */
export async function upsertDailyMetricInternal(
  projectId: string,
  metricDate: string,
  row: Partial<DailyMetricInput>,
  source: string = 'Manual',
  employeeId: string | null = null
): Promise<ActionResult> {
  if (!metricDate) return { ok: false, error: 'A date is required.' }

  const admin = createAdminClient()
  const { error } = await admin.from('ad_daily_metrics').upsert({
    project_id:         projectId,
    metric_date:        metricDate,
    spend:              row.spend ?? null,
    revenue:            row.revenue ?? null,
    reach:              row.reach ?? null,
    impressions:        row.impressions ?? null,
    clicks:             row.clicks ?? null,
    conversions:        row.conversions ?? null,
    leads:              row.leads ?? null,
    messages:           row.messages ?? null,
    purchases:          row.purchases ?? null,
    video_views:        row.videoViews ?? null,
    landing_page_views: row.landingPageViews ?? null,
    adds_to_cart:       row.addsToCart ?? null,
    checkouts:          row.checkouts ?? null,
    ctr:                row.ctr ?? null,
    cpc:                row.cpc ?? null,
    cpm:                row.cpm ?? null,
    cpr:                row.cpr ?? null,
    roas:               row.roas ?? null,
    frequency:          row.frequency ?? null,
    result_cost:        row.resultCost ?? null,
    remaining_budget:   row.remainingBudget ?? null,
    currency:           row.currency || 'INR',
    notes:              row.notes ?? null,
    status:             'submitted',
    entered_by:         employeeId,
    source:             source,
    updated_at:         new Date().toISOString(),
  }, { onConflict: 'project_id,metric_date' })

  if (error) return { ok: false, error: error.message }
  revalidatePath(`${REVALIDATE}/${projectId}`)
  return { ok: true }
}

export async function approveDailyMetric(metricId: string, projectId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_APPROVE_METRICS)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('ad_daily_metrics').update({
    status: 'approved', approved_by: guard.employeeId, approved_at: new Date().toISOString(),
  }).eq('id', metricId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(`${REVALIDATE}/${projectId}`)
  return { ok: true }
}

export async function deleteDailyMetric(metricId: string, projectId: string): Promise<ActionResult> {
  const guard = await requireAnyPermission([PERMS.ADVERTISING_ENTER_METRICS, PERMS.ADVERTISING_EDIT])
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('ad_daily_metrics').delete().eq('id', metricId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(`${REVALIDATE}/${projectId}`)
  return { ok: true }
}

// ─── Tasks (reuse the tasks table; link via ad_project_tasks) ────────────────

export async function addAdTask(
  projectId: string,
  input: { title: string; serviceId?: string | null; clientId?: string | null },
): Promise<ActionResult<{ taskId: string }>> {
  const guard = await requireAnyPermission([PERMS.ADVERTISING_EDIT, PERMS.TASKS_CREATE])
  if (!guard.ok) return { ok: false, error: guard.error }
  const title = (input.title || '').trim()
  if (!title) return { ok: false, error: 'A task title is required.' }

  const admin = createAdminClient()
  const { data: maxRow } = await admin.from('tasks')
    .select('task_number').order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
  const addTaskRow = {
    task_number: nextTaskNumber((maxRow as any)?.task_number),
    title, client_id: input.clientId || null, service_id: input.serviceId || null,
    status: 'pending', task_date: today(), billing_amount: 0, billing_amount_inr: 0,
    currency: 'INR', created_by: guard.employeeId,
    scope: deriveWorkScope(input.clientId || null),
  }
  const { data: t, error } = await retryWithoutScope(strip =>
    admin.from('tasks').insert(strip ? withoutScope(addTaskRow) : addTaskRow).select('id').single()
  )
  if (error) return { ok: false, error: error.message }

  await admin.from('ad_project_tasks').insert({ project_id: projectId, task_id: (t as any).id })
  await logAdEvent(admin, projectId, 'task_added', guard.employeeId, { task_id: (t as any).id, title })
  revalidatePath(`${REVALIDATE}/${projectId}`); revalidatePath('/dashboard/tasks')
  return { ok: true, data: { taskId: (t as any).id } }
}

// ─── Notes ─────────────────────────────────────────────────────────────────

export async function addAdNote(projectId: string, body: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  const text = (body || '').trim()
  if (!text) return { ok: false, error: 'Note is empty.' }

  const admin = createAdminClient()
  const { error } = await admin.from('ad_notes')
    .insert({ project_id: projectId, body: text, author_id: guard.employeeId })
  if (error) return { ok: false, error: error.message }
  revalidatePath(`${REVALIDATE}/${projectId}`)
  return { ok: true }
}

// ─── Request integration (advertising rides the Requests inbox) ──────────────

/**
 * Create an advertising request in the normal Requests inbox, tagged via
 * ad_meta so the inbox + Advertising dashboard can offer "Start as campaign".
 * Reuses the Requests module's guarded createManualRequest, then attaches the
 * captured hints best-effort.
 */
export async function createAdvertisingRequest(input: {
  clientId: string
  title: string
  description?: string
  platform?: string | null
  campaignType?: string | null
  adBudget?: number | null
}): Promise<ActionResult<{ requestId: string; ref: string | null }>> {
  const res = await createManualRequest({
    clientId: input.clientId,
    title: input.title || 'Advertising campaign',
    description: input.description || '',
  })
  if (!res.ok || !res.data) return { ok: false, error: res.error || 'Could not create the request.' }

  const requestId = (res.data as any).id as string
  const refNo = (res.data as any).ref_no as number | undefined
  const admin = createAdminClient()
  try {
    await admin.from('task_requests').update({
      ad_meta: {
        platform: input.platform ?? null,
        campaign_type: input.campaignType ?? null,
        ad_budget: input.adBudget ?? null,
      },
    }).eq('id', requestId)
  } catch { /* ad_meta column not migrated — request still created, just untagged */ }

  revalidatePath('/dashboard/requests'); revalidatePath(REVALIDATE)
  return { ok: true, data: { requestId, ref: refNo ? `REQ-${String(refNo).padStart(4, '0')}` : null } }
}

/**
 * Start an advertising request: create the campaign + its single task (via
 * createAdProject), then promote the request to that task — mirroring the normal
 * request→task promotion so the Requests/portal status stays in sync.
 */
export async function startAdvertisingRequest(requestId: string): Promise<ActionResult<{ projectId: string }>> {
  const guard = await requirePermission(PERMS.ADVERTISING_CREATE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: req } = await admin.from('task_requests')
    .select('id, ref_no, title, status, source, client_id, service_id, ad_meta, promoted_task_id')
    .eq('id', requestId).maybeSingle()
  if (!req) return { ok: false, error: 'Request not found.' }
  if ((req as any).promoted_task_id) return { ok: false, error: 'This request was already started.' }
  const meta = ((req as any).ad_meta || {}) as any

  const res = await createAdProject({
    clientId: (req as any).client_id,
    campaignName: (req as any).title || 'Advertising campaign',
    requestId: (req as any).id,
    serviceId: (req as any).service_id || null,
    platform: meta.platform || 'meta',
    campaignType: meta.campaign_type || null,
    adBudget: Number(meta.ad_budget) || 0,
    status: 'active',
  })
  if (!res.ok || !res.data) return { ok: false, error: res.error || 'Could not create the campaign.' }

  const taskId = res.data.taskId
  if (taskId) {
    await admin.from('task_requests').update({
      promoted_task_id: taskId,
      promoted_at: new Date().toISOString(),
      promoted_by: guard.employeeId,
      status: 'started',
      client_status: 'started',
      status_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', requestId)
    try {
      await logRequestActivity(admin, {
        requestId, actorType: 'admin', actorId: guard.employeeId, actorLabel: 'Cirqle',
        action: 'promoted', visibility: 'internal',
        detail: { task_id: taskId, ad_project_id: res.data.id },
      })
    } catch { /* portal not migrated */ }
  }

  revalidatePath('/dashboard/requests'); revalidatePath(REVALIDATE); revalidatePath('/dashboard/tasks')
  return { ok: true, data: { projectId: res.data.id } }
}

export async function setMetricSyncState(metricId: string, projectId: string, state: 'imported' | 'manual' | 'locked') {
  const me = await requirePermission(PERMS.ADVERTISING_ENTER_METRICS)
  if (!me.ok) throw new Error(me.error)

  const admin = createAdminClient()
  const { error } = await admin
    .from('ad_daily_metrics')
    .update({ sync_state: state })
    .eq('id', metricId)
    .eq('project_id', projectId)

  if (error) throw error
  
  await logAdEvent(admin, projectId, state === 'locked' ? 'metric_locked' : 'manual_metric_edited', me.employeeId, { metricId, newState: state })
  revalidatePath(`/dashboard/advertising/${projectId}`)
  return { ok: true }
}
