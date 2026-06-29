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
import { requirePermission, requireAnyPermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { generateInvoiceNumber } from '@/lib/invoices/numbering'
import { nextTaskNumber } from '@/lib/utils/task-code'
import { computeBudgetTotals, computeServiceCharge } from '@/lib/advertising/budget'
import { PLATFORM_LABEL } from '@/lib/advertising/types'
import { createManualRequest } from '@/app/(dashboard)/dashboard/requests/actions'
import { logRequestActivity } from '@/lib/requests/core'

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
async function createCampaignTask(
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
    const { data: t } = await admin.from('tasks').insert({
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
    }).select('id').single()
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
  const { data, error } = await admin.from('ad_projects').insert({
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
  }).select('id').single()

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

  // One task per campaign (the work item). Billing = the agency service charge.
  const serviceCharge = computeServiceCharge(
    input.adBudget ?? 0, input.serviceChargeType || 'fixed', input.serviceChargeValue ?? 0,
  )
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
  // Keep any linked draft invoice in step with the new budget.
  await resyncInvoiceForProject(admin, id)

  revalidatePath(REVALIDATE); revalidatePath(`${REVALIDATE}/${id}`); revalidatePath('/dashboard/invoices')
  return { ok: true }
}

/** Recompute the linked draft invoice's service-charge + ad-spend lines. No-op if none. */
async function resyncInvoiceForProject(admin: SupabaseClient, projectId: string): Promise<void> {
  try {
    const { data: project } = await admin.from('ad_projects')
      .select('*, client:clients(default_currency)').eq('id', projectId).maybeSingle()
    if (!project) return
    const { data: inv } = await admin.from('invoices')
      .select('id, status').eq('ad_project_id', projectId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    // Only touch a draft we created — never edit a sent/paid invoice.
    if (!inv || (inv as any).status !== 'draft') return
    await writeInvoiceLines(admin, projectId, (inv as any).id, project)
  } catch { /* invoice tables not migrated / transient */ }
}

/** Write (insert-or-update) the agency service-charge item + ad-spend section for a project's invoice. */
async function writeInvoiceLines(
  admin: SupabaseClient, projectId: string, invoiceId: string, project: any,
): Promise<void> {
  const currency = project.ad_budget_currency || project.client?.default_currency || 'INR'
  const totals = computeBudgetTotals({
    adBudget: Number(project.ad_budget_amount || 0),
    serviceChargeType: project.service_charge_type,
    serviceChargeValue: Number(project.service_charge_value || 0),
    taxPercent: Number(project.tax_percent || 0),
  })

  // Agency service charge → normal invoice item (matched by description prefix).
  const { data: scItem } = await admin.from('invoice_items')
    .select('id').eq('invoice_id', invoiceId).ilike('description', 'Agency Service Charge%').limit(1).maybeSingle()
  const scDesc = `Agency Service Charge — ${project.campaign_name}`
  if (scItem) {
    await admin.from('invoice_items').update({
      description: scDesc, unit_price: totals.serviceCharge, total: totals.serviceCharge, currency,
    }).eq('id', (scItem as any).id)
  } else if (totals.serviceCharge > 0) {
    await admin.from('invoice_items').insert({
      invoice_id: invoiceId, description: scDesc, quantity: 1,
      unit_price: totals.serviceCharge, total: totals.serviceCharge, currency, display_order: 0,
    })
  }

  // Advertising spend → separate section.
  const adInr = await toInr(admin, totals.adSpend, currency)
  const adDesc = `${PLATFORM_LABEL[project.platform] || 'Advertising'} Ad Spend — ${project.campaign_name}`
  const { data: adItem } = await admin.from('invoice_ad_spend_items')
    .select('id').eq('invoice_id', invoiceId).eq('ad_project_id', projectId).limit(1).maybeSingle()
  if (adItem) {
    await admin.from('invoice_ad_spend_items').update({
      description: adDesc, amount: totals.adSpend, amount_inr: adInr, currency,
    }).eq('id', (adItem as any).id)
  } else {
    await admin.from('invoice_ad_spend_items').insert({
      invoice_id: invoiceId, ad_project_id: projectId, description: adDesc,
      amount: totals.adSpend, amount_inr: adInr, currency, display_order: 0,
    })
  }

  // Invoice grand total = agency service + ad spend (the true amount owed).
  await admin.from('invoices')
    .update({ total_amount: totals.subtotal, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
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
  const { data: t, error } = await admin.from('tasks').insert({
    task_number: nextTaskNumber((maxRow as any)?.task_number),
    title, client_id: input.clientId || null, service_id: input.serviceId || null,
    status: 'pending', task_date: today(), billing_amount: 0, billing_amount_inr: 0,
    currency: 'INR', created_by: guard.employeeId,
  }).select('id').single()
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
