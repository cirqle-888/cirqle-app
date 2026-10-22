'use server'

/**
 * Profit Sharing — server actions (design §10–12).
 *
 * Every action requires its profit_sharing.* permission AND isAdmin: Admin
 * only in this release, so a permission granted to another designation by
 * mistake still opens nothing. Amounts are always recomputed here from the
 * books, never taken from the browser. Multi-row writes go through one
 * database function each, so they land together or not at all.
 *
 * Nothing here calls logActivity: the activity feed is visible to people who
 * must not see profit sharing. The audit trail is profit_share_events.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { round2 } from '@/lib/calculations/currency'
import { computeRun, isBlocked, monthEnd, type RunComputation } from '@/lib/profit-sharing/engine'
import { validateSettings } from '@/lib/profit-sharing/distribution'
import { settlementRefusal, type SettlementKind } from '@/lib/profit-sharing/settlements'
import { validateDevicePolicy, type DevicePolicy } from '@/lib/profit-sharing/device'
import {
  loadModuleState, loadRunInput, pendingByEntitlement, pendingByValuation, recordEvent, reserveBalance,
  settingsOn, type Admin, type ModuleState, type RunRow,
} from '@/lib/profit-sharing/load'
import { addDays } from '@/lib/profit-sharing/capital'
import type { ReviewCategory } from '@/lib/profit-sharing/types'
import { done, fail, guard, isDate, money, text, type Result } from './_shared'

// ═══ Members ════════════════════════════════════════════════════════════════

export async function createMember(input: {
  employeeId: string | null; displayLabel: string | null; roles: string[]; joinedOn: string | null; notes: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const roles = [...new Set(input.roles)].filter(r => ['founder', 'employee', 'investor'].includes(r))
  if (!roles.length) return { ok: false, error: 'Choose at least one role.' }
  if (!input.employeeId && !text(input.displayLabel)) return { ok: false, error: 'An external investor needs a name or label.' }
  if (input.joinedOn && !isDate(input.joinedOn)) return { ok: false, error: 'Joined date is not a valid date.' }
  const admin = createAdminClient()
  const { data, error } = await admin.from('profit_share_members').insert({
    employee_id: input.employeeId || null, display_label: text(input.displayLabel), roles,
    joined_on: input.joinedOn || null, notes: text(input.notes), created_by: g.actor,
  }).select('id').single()
  if (error) return fail(new Error(/duplicate key/i.test(error.message) ? 'This employee is already a member.' : error.message))
  await recordEvent(admin, { actorId: g.actor, entity: 'member', entityId: data.id, action: 'created', detail: { roles } }).catch(() => {})
  done()
  return { ok: true }
}

export async function updateMember(input: {
  id: string; roles: string[]; displayLabel: string | null; exitedOn: string | null; notes: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const roles = [...new Set(input.roles)].filter(r => ['founder', 'employee', 'investor'].includes(r))
  if (!roles.length) return { ok: false, error: 'Choose at least one role.' }
  if (input.exitedOn && !isDate(input.exitedOn)) return { ok: false, error: 'Exit date is not a valid date.' }
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_members').update({
    roles, display_label: text(input.displayLabel), exited_on: input.exitedOn || null, notes: text(input.notes),
    updated_at: new Date().toISOString(),
  }).eq('id', input.id)
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'member', entityId: input.id, action: 'updated', detail: { roles, exitedOn: input.exitedOn } }).catch(() => {})
  done()
  return { ok: true }
}

// ═══ Capital ════════════════════════════════════════════════════════════════

const CAPITAL_KINDS = ['opening_balance', 'investment', 'withdrawal', 'correction_in', 'correction_out'] as const

export async function recordCapital(input: {
  memberId: string; kind: typeof CAPITAL_KINDS[number]; amountInr: number; receivedOn: string; effectiveOn: string
  cashbookEntryId: string | null; agreementId: string | null; reason: string | null; notes: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  if (!CAPITAL_KINDS.includes(input.kind)) return { ok: false, error: 'Unknown capital movement.' }
  const amount = money(input.amountInr)
  if (!(amount > 0)) return { ok: false, error: 'Enter an amount above zero.' }
  if (!isDate(input.receivedOn) || !isDate(input.effectiveOn)) return { ok: false, error: 'Enter valid dates.' }
  if (input.kind !== 'opening_balance' && input.effectiveOn < input.receivedOn) {
    return { ok: false, error: 'Capital cannot start counting before it was received.' }
  }
  if (input.kind.startsWith('correction') && !text(input.reason)) return { ok: false, error: 'A correction needs a reason.' }
  const admin = createAdminClient()
  const { error } = await admin.rpc('profit_share_record_capital', {
    p: {
      actor: g.actor, member_id: input.memberId, kind: input.kind, amount_inr: amount,
      received_on: input.receivedOn, effective_on: input.effectiveOn,
      cashbook_entry_id: input.cashbookEntryId || null, agreement_id: input.agreementId || null,
      reason: text(input.reason), notes: text(input.notes),
    },
  })
  if (error) return fail(error)
  done()
  return { ok: true }
}

export async function decideCapital(id: string, decision: 'approved' | 'rejected'): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_capital').update({
    status: decision,
    approved_by: decision === 'approved' ? g.actor : null,
    approved_at: decision === 'approved' ? new Date().toISOString() : null,
  }).eq('id', id).eq('status', 'pending_approval')
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'capital', entityId: id, action: decision }).catch(() => {})
  done()
  return { ok: true }
}

// ═══ Agreements (D12 — every term explicit, professional review noted) ══════

export async function createAgreement(input: {
  memberId: string; kind: 'capital_investment' | 'device_investment'; title: string; terms: string | null
  repaymentTerms: string | null; entitlementsSurviveExit: boolean | null; deviceCapitalWeight: number | null
  deviceCapitalFixed: boolean | null; buybackTerms: string | null; effectiveFrom: string; effectiveTo: string | null
  documentUrl: string | null; professionalReviewNote: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  if (!text(input.title)) return { ok: false, error: 'Give the agreement a title.' }
  if (!isDate(input.effectiveFrom) || (input.effectiveTo && !isDate(input.effectiveTo))) return { ok: false, error: 'Enter valid dates.' }
  const weight = input.deviceCapitalWeight == null ? null : Number(input.deviceCapitalWeight)
  if (weight != null && !(weight > 0 && weight <= 1)) return { ok: false, error: 'Device capital weight must be above 0 and at most 1.' }
  const admin = createAdminClient()
  const { data, error } = await admin.from('profit_share_agreements').insert({
    member_id: input.memberId, kind: input.kind, title: text(input.title), terms: text(input.terms),
    repayment_terms: text(input.repaymentTerms), entitlements_survive_exit: input.entitlementsSurviveExit,
    device_capital_weight: input.kind === 'device_investment' ? weight : null,
    device_capital_fixed: input.kind === 'device_investment' ? input.deviceCapitalFixed : null,
    buyback_terms: input.kind === 'device_investment' ? text(input.buybackTerms) : null,
    effective_from: input.effectiveFrom, effective_to: input.effectiveTo || null,
    document_url: text(input.documentUrl), professional_review_note: text(input.professionalReviewNote), created_by: g.actor,
  }).select('id').single()
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'agreement', entityId: data.id, action: 'drafted' }).catch(() => {})
  done()
  return { ok: true }
}

export async function approveAgreement(id: string): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_agreements').update({
    status: 'approved', approved_by: g.actor, approved_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'draft')
  if (error) {
    return fail(/check constraint/i.test(error.message)
      ? new Error('Every term must be recorded before approval: repayment on exit, whether entitlements survive exit, and for device agreements the capital weight, whether it stays fixed, and buy-back terms.')
      : error)
  }
  await recordEvent(admin, { actorId: g.actor, entity: 'agreement', entityId: id, action: 'approved' }).catch(() => {})
  done()
  return { ok: true }
}

export async function endAgreement(id: string, effectiveTo: string): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  if (!isDate(effectiveTo)) return { ok: false, error: 'Enter a valid end date.' }
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_agreements').update({ status: 'ended', effective_to: effectiveTo })
    .eq('id', id).eq('status', 'approved')
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'agreement', entityId: id, action: 'ended', detail: { effectiveTo } }).catch(() => {})
  done()
  return { ok: true }
}

// ═══ Reviews (classification overlay — the source is never edited) ══════════

const CLASSIFICATIONS: Record<ReviewCategory, string[]> = {
  personal_withdrawal: ['capital_withdrawal', 'advance_distribution', 'personal_drawing', 'reimbursement', 'loan_to_member', 'other'],
  unidentified_receipt: ['own_revenue', 'client_funds', 'capital', 'loan', 'other'],
  chargeback: ['reduce_own_revenue', 'refund_client_funds', 'other'],
  salary_without_payroll: ['payroll_settlement', 'extra_pay', 'advance'],
  advance_deduction: ['linked'],
  credit_conversion: ['additional_pay', 'records_deduction'],
  invoice_split: ['split'],
  unassigned_ad_funding: ['write_off'],
}

export async function saveReview(input: {
  sourceTable: string; sourceId: string; category: ReviewCategory; classification: string
  memberId: string | null; amountInr: number | null; sourceDate: string | null
  detail: Record<string, unknown> | null; note: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const allowed = CLASSIFICATIONS[input.category]
  if (!allowed?.includes(input.classification)) return { ok: false, error: 'Choose a classification.' }
  const needsNote = ['other', 'reimbursement', 'write_off', 'extra_pay', 'records_deduction', 'additional_pay']
  if (needsNote.includes(input.classification) && !text(input.note)) return { ok: false, error: 'Add a note explaining this classification.' }
  if (['capital_withdrawal', 'advance_distribution'].includes(input.classification) && !input.memberId) {
    return { ok: false, error: 'Choose whose capital or advance this is.' }
  }
  let detail = input.detail ?? null
  if (input.category === 'invoice_split') {
    const n = (k: string) => round2(Number(detail?.[k] ?? 0))
    const own = n('ownInr'); const pass = n('passInr'); const tax = n('taxInr')
    if ([own, pass, tax].some(v => !(v >= 0))) return { ok: false, error: 'Split amounts cannot be negative.' }
    detail = { ownInr: own, passInr: pass, taxInr: tax, carriedInr: 0, totalInr: round2(own + pass + tax) }
  }
  if (input.category === 'salary_without_payroll' && input.classification === 'payroll_settlement' && !detail?.payrollId) {
    return { ok: false, error: 'Choose the payslip this payment settles.' }
  }
  if (input.category === 'advance_deduction' && !(Array.isArray(detail?.creditIds) && (detail!.creditIds as unknown[]).length)) {
    return { ok: false, error: 'Choose the credit-ledger advance(s) this deduction recovers.' }
  }

  const admin = createAdminClient()
  const row = {
    source_table: input.sourceTable, source_id: input.sourceId, category: input.category,
    classification: input.classification, member_id: input.memberId || null,
    amount_inr: input.amountInr == null ? null : money(input.amountInr),
    source_date: input.sourceDate || null, detail, note: text(input.note),
    reviewed_by: g.actor, reviewed_at: new Date().toISOString(),
  }
  const { data: existing } = await admin.from('profit_share_reviews').select('id')
    .eq('source_table', input.sourceTable).eq('source_id', input.sourceId).maybeSingle()
  const write = existing
    ? await admin.from('profit_share_reviews').update(row).eq('id', existing.id).select('id').single()
    : await admin.from('profit_share_reviews').insert(row).select('id').single()
  if (write.error) return fail(write.error)
  const reviewId = write.data.id as string

  // A withdrawal reviewed as a capital withdrawal becomes a pending capital
  // movement, which an Admin then approves like any other.
  if (input.category === 'personal_withdrawal' && input.classification === 'capital_withdrawal' && !existing) {
    const { error } = await admin.rpc('profit_share_record_capital', {
      p: {
        actor: g.actor, member_id: input.memberId, kind: 'withdrawal', amount_inr: money(input.amountInr),
        received_on: input.sourceDate, effective_on: input.sourceDate, review_id: reviewId,
        notes: 'From a reviewed Personal Withdrawal',
      },
    })
    if (error) return fail(error)
  }
  await recordEvent(admin, {
    actorId: g.actor, entity: 'review', entityId: reviewId, action: existing ? 'reclassified' : 'classified',
    detail: { source: `${input.sourceTable}:${input.sourceId}`, category: input.category, classification: input.classification },
  }).catch(() => {})
  done()
  return { ok: true }
}

export async function deleteReview(id: string): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_reviews').delete().eq('id', id)
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'review', entityId: id, action: 'removed' }).catch(() => {})
  done()
  return { ok: true }
}

// ═══ Settings (versioned, append-only) ══════════════════════════════════════

export async function addSettingsVersion(input: {
  effectiveFrom: string; distributionPct: number; capitalSharePct: number; reservePct: number
  toleranceInr: number; adPrepaidBlockDays: number; passthroughWarnDays: number; note: string | null
}): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  if (!isDate(input.effectiveFrom) || !input.effectiveFrom.endsWith('-01')) return { ok: false, error: 'Settings take effect from the first day of a month.' }
  const values = {
    distributionPct: Number(input.distributionPct), capitalSharePct: Number(input.capitalSharePct), reservePct: Number(input.reservePct),
    toleranceInr: Number(input.toleranceInr), adPrepaidBlockDays: Number(input.adPrepaidBlockDays), passthroughWarnDays: Number(input.passthroughWarnDays),
  }
  const errors = validateSettings(values)
  if (errors.length) return { ok: false, error: errors.join('. ') }
  const admin = createAdminClient()
  const state = await loadModuleState(admin).catch(e => e as Error)
  if (state instanceof Error) return fail(state)
  const lastConfirmed = state.runs.filter(r => r.status === 'confirmed').map(r => r.periodEnd).sort().at(-1)
  if (lastConfirmed && input.effectiveFrom <= lastConfirmed) {
    return { ok: false, error: `Confirmed periods run to ${lastConfirmed}; new settings must start after that.` }
  }
  const current = settingsOn(state.settings, input.effectiveFrom)
  const { error } = await admin.from('profit_share_settings').insert({
    effective_from: input.effectiveFrom,
    distribution_pct: values.distributionPct, capital_share_pct: values.capitalSharePct, reserve_pct: values.reservePct,
    reconciliation_tolerance_inr: values.toleranceInr, ad_prepaid_block_days: values.adPrepaidBlockDays,
    passthrough_warn_days: values.passthroughWarnDays,
    // The device policy carries over unchanged.
    device_policy: current?.devicePolicy ?? null,
    device_policy_approved_by: current?.devicePolicyApprovedBy ?? null,
    device_policy_approved_at: current?.devicePolicyApprovedAt ?? null,
    note: text(input.note), created_by: g.actor,
  })
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'settings', entityId: input.effectiveFrom, action: 'version_added', detail: values }).catch(() => {})
  done()
  return { ok: true }
}

/** Save a device policy draft, or approve it (D11). Both add a settings version. */
export async function saveDevicePolicy(policy: DevicePolicy, approve: boolean, note: string | null): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  const errors = validateDevicePolicy(policy)
  if (errors.length) return { ok: false, error: errors.join('. ') }
  const admin = createAdminClient()
  const state = await loadModuleState(admin).catch(e => e as Error)
  if (state instanceof Error) return fail(state)
  const latest = state.settings.at(-1)
  if (!latest) return { ok: false, error: 'No settings version exists yet.' }
  const now = new Date().toISOString()
  const { error } = await admin.from('profit_share_settings').insert({
    effective_from: latest.effectiveFrom,
    distribution_pct: latest.distributionPct, capital_share_pct: latest.capitalSharePct, reserve_pct: latest.reservePct,
    reconciliation_tolerance_inr: latest.toleranceInr, ad_prepaid_block_days: latest.adPrepaidBlockDays,
    passthrough_warn_days: latest.passthroughWarnDays,
    device_policy: policy,
    device_policy_approved_by: approve ? g.actor : null,
    device_policy_approved_at: approve ? now : null,
    note: text(note) ?? (approve ? 'Device policy approved' : 'Device policy draft'),
    created_by: g.actor,
  })
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'device_policy', entityId: null, action: approve ? 'approved' : 'drafted', detail: policy }).catch(() => {})
  done()
  return { ok: true }
}

// ═══ Profit periods ═════════════════════════════════════════════════════════

export async function createRun(input: { startMonth: string; endMonth: string }): Promise<Result<{ id: string }>> {
  const g = await guard('manage')
  if (!g.ok) return g
  const start = `${input.startMonth}-01`
  const end = monthEnd(`${input.endMonth}-01`)
  if (!isDate(start) || !isDate(end) || end <= start) return { ok: false, error: 'Choose a start month and a later or equal end month.' }
  const admin = createAdminClient()
  const state = await loadModuleState(admin).catch(e => e as Error)
  if (state instanceof Error) return fail(state)
  const lastConfirmed = state.runs.filter(r => r.status === 'confirmed').map(r => r.periodEnd).sort().at(-1)
  if (lastConfirmed && start !== addDays(lastConfirmed, 1)) {
    return { ok: false, error: `The next period must start on ${addDays(lastConfirmed, 1)}.` }
  }
  const { data, error } = await admin.from('profit_share_runs').insert({
    period_start: start, period_end: end, status: 'draft', created_by: g.actor,
  }).select('id').single()
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'run', entityId: data.id, action: 'created', detail: { start, end } }).catch(() => {})
  done()
  return { ok: true, data: { id: data.id } }
}

/** D7: the first period's opening accumulated loss is entered, never derived. */
export async function setOpeningLoss(runId: string, amountInr: number): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const amount = money(amountInr)
  if (!(amount >= 0)) return { ok: false, error: 'Enter zero or a positive accumulated loss.' }
  const admin = createAdminClient()
  const state = await loadModuleState(admin).catch(e => e as Error)
  if (state instanceof Error) return fail(state)
  if (state.runs.some(r => r.status === 'confirmed')) return { ok: false, error: 'Only the first period takes an entered opening loss.' }
  const { error } = await admin.from('profit_share_runs').update({
    opening_loss_inr: amount, opening_loss_entered: true, status: 'draft', reviewed_by: null, reviewed_at: null,
  }).eq('id', runId).in('status', ['draft', 'calculated', 'reviewed'])
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'run', entityId: runId, action: 'opening_loss_set', detail: { amount } }).catch(() => {})
  done()
  return { ok: true }
}

async function compute(admin: Admin, state: ModuleState, run: RunRow): Promise<RunComputation> {
  const input = await loadRunInput(admin, state, run)
  return computeRun(input)
}

/** What is stored on the run for display: everything except the frozen-input list. */
function summaryOf(c: RunComputation) {
  return { ...c, frozenInputs: undefined, frozenInputCount: c.frozenInputs.length }
}

export async function calculateRun(runId: string): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const admin = createAdminClient()
  try {
    const state = await loadModuleState(admin)
    const run = state.runs.find(r => r.id === runId)
    if (!run) return { ok: false, error: 'Period not found.' }
    if (!['draft', 'calculated', 'reviewed'].includes(run.status)) return { ok: false, error: 'This period is already final.' }
    const c = await compute(admin, state, run)
    const settings = settingsOn(state.settings, run.periodStart)
    const { error } = await admin.from('profit_share_runs').update({
      status: 'calculated',
      settings_id: settings?.id ?? null,
      settings_snapshot: settings ?? null,
      own_revenue_inr: c.profit.ownRevenueInr,
      operating_payments_inr: c.profit.operatingPaymentsInr,
      remuneration_inr: round2(c.profit.remunerationInr + c.profit.extraPayInr),
      device_costs_inr: c.profit.deviceCostsInr,
      passthrough_writeoffs_inr: round2(c.profit.passthroughWriteoffsInr + c.profit.adWriteoffsInr),
      profit_inr: c.profit.profitInr,
      loss_offset_inr: c.loss.lossOffsetInr,
      closing_loss_inr: c.loss.closingLossInr,
      eligible_profit_inr: c.loss.eligibleProfitInr,
      pool_inr: c.distribution.poolInr,
      capital_share_inr: c.distribution.capitalShareInr,
      reserve_inr: c.distribution.reserveInr,
      retained_outside_inr: c.distribution.retainedOutsideInr,
      total_retained_inr: c.distribution.totalRetainedInr,
      unallocated_capital_share_inr: c.capital.unallocatedInr,
      cash_opening_inr: c.cash.openingInr,
      cash_closing_inr: c.cash.closingInr,
      free_cash_inr: c.freeCash.freeCashInr,
      cash_available_inr: c.freeCash.cashAvailableInr,
      summary: summaryOf(c),
      fingerprint: c.fingerprint,
      calculated_by: g.actor,
      calculated_at: new Date().toISOString(),
      reviewed_by: null, reviewed_at: null, cash_ack_text: null, cash_ack_by: null, cash_ack_at: null,
    }).eq('id', runId)
    if (error) return fail(error)
    await recordEvent(admin, { actorId: g.actor, entity: 'run', entityId: runId, action: 'calculated', detail: { profit: c.profit.profitInr, fingerprint: c.fingerprint } })
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

/** Recompute and compare: confirmation always acts on the books as they are now. */
async function freshOrStale(admin: Admin, runId: string) {
  const state = await loadModuleState(admin)
  const run = state.runs.find(r => r.id === runId)
  if (!run) throw new Error('Period not found.')
  const c = await compute(admin, state, run)
  return { state, run, c, stale: c.fingerprint !== run.fingerprint }
}

export async function markReviewed(runId: string): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const admin = createAdminClient()
  try {
    const { run, stale } = await freshOrStale(admin, runId)
    if (run.status !== 'calculated') return { ok: false, error: 'Calculate the period before marking it reviewed.' }
    if (stale) return { ok: false, error: 'The books changed since this period was calculated. Recalculate first.' }
    const { error } = await admin.from('profit_share_runs').update({
      status: 'reviewed', reviewed_by: g.actor, reviewed_at: new Date().toISOString(),
    }).eq('id', runId).eq('status', 'calculated')
    if (error) return fail(error)
    await recordEvent(admin, { actorId: g.actor, entity: 'run', entityId: runId, action: 'reviewed' })
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

/** D13: confirmation with a shortfall needs a written acknowledgement. D16: one Admin may confirm. */
export async function confirmRun(runId: string, cashAck: string | null): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  const admin = createAdminClient()
  try {
    const { run, c, stale } = await freshOrStale(admin, runId)
    if (run.status !== 'reviewed') return { ok: false, error: 'Mark the period reviewed before confirming it.' }
    if (stale) return { ok: false, error: 'The books changed since this period was calculated. Recalculate and review again.' }
    if (isBlocked(c.gates)) return { ok: false, error: 'Resolve every blocking check before confirming.' }
    const ack = text(cashAck)
    if (c.freeCash.capitalShareExceedsCash && !ack) {
      return { ok: false, error: 'The Capital Share is more than the cash available. Record a written acknowledgement to confirm.' }
    }
    if (ack) {
      const { error } = await admin.from('profit_share_runs').update({
        cash_ack_text: ack, cash_ack_by: g.actor, cash_ack_at: new Date().toISOString(),
      }).eq('id', runId).eq('status', 'reviewed')
      if (error) return fail(error)
    }
    const { error } = await admin.rpc('profit_share_confirm_run', {
      p_run_id: runId,
      p_actor: g.actor,
      p_result: {
        fingerprint: c.fingerprint,
        opening_loss_inr: c.loss.openingLossInr,
        profit_inr: c.profit.profitInr,
        eligible_profit_inr: c.loss.eligibleProfitInr,
        pool_inr: c.distribution.poolInr,
        capital_share_inr: c.distribution.capitalShareInr,
        reserve_inr: c.distribution.reserveInr,
        closing_loss_inr: c.loss.closingLossInr,
        cash_available_inr: c.freeCash.cashAvailableInr,
        cash_ack: ack,
      },
      p_entitlements: c.capital.entitlements.map(e => ({
        member_id: e.memberId, capital_days: e.capitalDays, share: e.share, amount_inr: e.amountInr,
        workings: { openingBalance: e.openingBalanceInr, closingBalance: e.closingBalanceInr, totalCapitalDays: c.capital.totalCapitalDays },
      })),
      p_inputs: c.frozenInputs,
    })
    if (error) return fail(error)
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

export async function voidRun(runId: string, reason: string): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  if (!text(reason)) return { ok: false, error: 'Voiding a confirmed period needs a reason.' }
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_runs').update({
    status: 'void', voided_by: g.actor, voided_at: new Date().toISOString(), void_reason: text(reason),
  }).eq('id', runId).eq('status', 'confirmed')
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'run', entityId: runId, action: 'voided', detail: { reason } }).catch(() => {})
  done()
  return { ok: true }
}

export async function deleteDraftRun(runId: string): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_runs').delete().eq('id', runId).in('status', ['draft', 'calculated', 'reviewed'])
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'run', entityId: runId, action: 'deleted' }).catch(() => {})
  done()
  return { ok: true }
}

// ═══ Settlements ════════════════════════════════════════════════════════════

/** Cash available right now (D13 recheck): the books up to today, every obligation, the reserve. */
async function cashAvailableNow(admin: Admin, state: ModuleState): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const input = await loadRunInput(admin, state, {
    id: 'now', periodStart: `${today.slice(0, 7)}-01`, periodEnd: today, openingLossInr: 0, openingLossEntered: true,
  })
  return computeRun(input).freeCash.cashAvailableInr
}

export async function settle(input: {
  entitlementId: string | null; deviceValuationId: string | null; kind: SettlementKind; amountInr: number
  settledOn: string; reason: string | null; reviewId: string | null; cashAck: string | null
  cash: { mode: 'create' | 'link'; bankAccountId: string | null; entryId: string | null } | null
}): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  if (!isDate(input.settledOn)) return { ok: false, error: 'Enter a valid date.' }
  if (!!input.entitlementId === !!input.deviceValuationId) return { ok: false, error: 'Choose what to settle.' }
  const admin = createAdminClient()
  try {
    const state = await loadModuleState(admin)
    const amount = money(input.amountInr)
    let pending = 0
    let description = 'Profit share settlement'
    let accountCode = 'excluded.profit_distribution'
    let isDevice = false
    let hasDeviceAgreement = false
    if (input.entitlementId) {
      pending = pendingByEntitlement(state.entitlements, state.settlements, state.runs).get(input.entitlementId) ?? 0
      const ent = state.entitlements.find(e => e.id === input.entitlementId)
      const run = state.runs.find(r => r.id === ent?.runId)
      // Neutral: no investor name or amount in the Cash Book text (D15).
      description = `Profit share payout — PS-${run?.periodStart.slice(0, 7) ?? ''}`
    } else {
      isDevice = true
      const v = state.valuations.find(x => x.id === input.deviceValuationId)
      if (!v) return { ok: false, error: 'Valuation not found.' }
      pending = pendingByValuation(state.valuations, state.settlements).get(v.id) ?? 0
      accountCode = 'opex.equipment'
      description = `Device settlement — DV-${v.id.slice(0, 8)}`
      const { data: device } = await admin.from('profit_share_devices').select('member_id').eq('id', v.deviceId).maybeSingle()
      hasDeviceAgreement = state.agreements.some(a => a.memberId === device?.member_id && a.kind === 'device_investment'
        && a.status === 'approved' && a.effectiveFrom <= input.settledOn && (!a.effectiveTo || a.effectiveTo >= input.settledOn))
    }
    let advanceLeft: number | undefined
    if (input.kind === 'advance_offset') {
      const r = state.reviews.find(x => x.id === input.reviewId)
      if (!r || r.classification !== 'advance_distribution') return { ok: false, error: 'Choose a withdrawal reviewed as an advance distribution.' }
      const used = state.settlements.filter(s => s.reviewId === r.id && s.kind === 'advance_offset').reduce((x, s) => x + s.amountInr, 0)
      advanceLeft = round2((r.amountInr ?? 0) - used)
    }
    const cashAvailable = input.kind === 'paid' ? await cashAvailableNow(admin, state) : undefined
    const refusal = settlementRefusal({
      kind: input.kind, amountInr: amount, pendingInr: pending, reason: input.reason, advanceLeftInr: advanceLeft,
      isDevice, hasDeviceAgreement, cashAvailableInr: cashAvailable, cashAck: input.cashAck,
    })
    if (refusal) return { ok: false, error: refusal }
    if (input.kind === 'paid' && !input.cash) return { ok: false, error: 'Choose how the payment is recorded in the Cash Book.' }

    const { error } = await admin.rpc('profit_share_settle', {
      p: {
        actor: g.actor, entitlement_id: input.entitlementId, device_valuation_id: input.deviceValuationId,
        kind: input.kind, amount_inr: amount, settled_on: input.settledOn, reason: text(input.reason),
        review_id: input.reviewId || null, cash_ack_text: text(input.cashAck),
        cash: input.kind === 'paid' && input.cash ? {
          mode: input.cash.mode, entry_id: input.cash.entryId || null, bank_account_id: input.cash.bankAccountId || null,
          account_code: accountCode, description,
        } : null,
      },
    })
    if (error) return fail(error)

    // A transfer valuation settled in full moves the device to Cirqle.
    if (isDevice) {
      const v = state.valuations.find(x => x.id === input.deviceValuationId)!
      if (v.kind === 'transfer' && round2(pending - amount) <= 0 && input.kind !== 'waived') {
        await admin.from('profit_share_devices').update({ ownership: 'transferred', updated_at: new Date().toISOString() }).eq('id', v.deviceId)
      }
    }
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

// ═══ Business Reserve (D9) ══════════════════════════════════════════════════

export async function releaseReserve(input: { amountInr: number; movedOn: string; reason: string }): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  const amount = money(input.amountInr)
  if (!(amount > 0)) return { ok: false, error: 'Enter an amount above zero.' }
  if (!isDate(input.movedOn)) return { ok: false, error: 'Enter a valid date.' }
  if (!text(input.reason)) return { ok: false, error: 'A reserve release needs a reason.' }
  const admin = createAdminClient()
  try {
    const state = await loadModuleState(admin)
    const balance = reserveBalance(state.reserve)
    if (amount > balance) return { ok: false, error: `The reserve holds only ₹${balance.toLocaleString('en-IN')}.` }
    const { data, error } = await admin.from('profit_share_reserve_movements').insert({
      kind: 'release', amount_inr: amount, moved_on: input.movedOn, reason: text(input.reason), approved_by: g.actor, created_by: g.actor,
    }).select('id').single()
    if (error) return fail(error)
    await recordEvent(admin, { actorId: g.actor, entity: 'reserve', entityId: data.id, action: 'released', detail: { amount, reason: input.reason } })
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

