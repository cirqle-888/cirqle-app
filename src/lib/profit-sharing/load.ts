/**
 * Profit Sharing — the ONLY module here that touches the database.
 *
 * Server-only: every caller has already checked profit_sharing.* AND isAdmin.
 * Reads never degrade silently: a failed page throws, because a profit figure
 * computed from a partial ledger is worse than no figure (contrast fetchAll,
 * which is fine for display lists). The one tolerated gap is a column added by
 * a migration production may not have yet (reversal_of, released_by_entry_id).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { round2 } from '@/lib/calculations/currency'
import { addDays } from './capital'
import { monthEnd, monthsOf, type BankAccountCheck, type RunInput } from './engine'
import type {
  CapitalMovement, CashLink, CreditRow, CreditType, DeviceCost, InvoiceAllocation, InvoiceRaw, LedgerEntry,
  PayrollAllocation, PayrollRow, Review, ReviewCategory, Section, SettlementRef, Settings, WalletCredit,
} from './types'
import { DEFAULT_SETTINGS } from './types'
import type { DevicePolicy } from './device'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Admin = SupabaseClient<any, any, any>

const PAGE = 1000

function isMissing(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false
  return ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code ?? '')
    || /does not exist|could not find|schema cache/i.test(error.message ?? '')
}

/** Every row of a query, paged in stable id order. Throws on any error. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAll(build: (from: number, to: number) => any, label: string): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1)
    if (error) throw Object.assign(new Error(`[profit-sharing] ${label}: ${error.message}`), { code: error.code })
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return out
}

/** Read with an optional column; if the column is missing, read again without it. */
async function readWithOptional(
  admin: Admin, table: string, columns: string, optional: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (q: any) => any, label: string,
) {
  try {
    return await readAll((f, t) => apply(admin.from(table).select(`${columns}, ${optional}`)).order('id').range(f, t), label)
  } catch (e) {
    if (!isMissing(e as { code?: string; message?: string })) throw e
    return readAll((f, t) => apply(admin.from(table).select(columns)).order('id').range(f, t), label)
  }
}

const num = (v: unknown) => Number(v ?? 0) || 0
const day = (v: unknown) => (v ? String(v).slice(0, 10) : '')

// ── Installation ─────────────────────────────────────────────────────────────

/** False until the migration is applied — every screen then shows a setup notice. */
export async function isInstalled(admin: Admin): Promise<boolean> {
  const { error } = await admin.from('profit_share_settings').select('id').limit(1)
  return !error
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface SettingsVersion extends Settings {
  id: string
  effectiveFrom: string
  devicePolicy: DevicePolicy | null
  devicePolicyApprovedAt: string | null
  devicePolicyApprovedBy: string | null
  note: string | null
  createdAt: string
}

export async function loadSettingsVersions(admin: Admin): Promise<SettingsVersion[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_settings').select('*').order('effective_from').range(f, t), 'settings')
  return rows.map(r => ({
    id: r.id,
    effectiveFrom: day(r.effective_from),
    distributionPct: num(r.distribution_pct),
    capitalSharePct: num(r.capital_share_pct),
    reservePct: num(r.reserve_pct),
    toleranceInr: num(r.reconciliation_tolerance_inr),
    adPrepaidBlockDays: num(r.ad_prepaid_block_days),
    passthroughWarnDays: num(r.passthrough_warn_days),
    devicePolicy: (r.device_policy as DevicePolicy) ?? null,
    devicePolicyApprovedAt: r.device_policy_approved_at ?? null,
    devicePolicyApprovedBy: r.device_policy_approved_by ?? null,
    note: r.note ?? null,
    createdAt: r.created_at,
  }))
}

/** The version in force on a date: the latest effective_from on or before it (ties → newest). */
export function settingsOn(versions: SettingsVersion[], date: string): SettingsVersion | null {
  return versions
    .filter(v => v.effectiveFrom <= date)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.localeCompare(b.createdAt))
    .at(-1) ?? null
}

/** The newest version with an approved device policy, if any. */
export function approvedDevicePolicy(versions: SettingsVersion[]): SettingsVersion | null {
  return versions.filter(v => v.devicePolicyApprovedAt && v.devicePolicy)
    .sort((a, b) => (a.devicePolicyApprovedAt ?? '').localeCompare(b.devicePolicyApprovedAt ?? '')).at(-1) ?? null
}

// ── Members, capital, agreements ─────────────────────────────────────────────

export interface Member {
  id: string
  employeeId: string | null
  cqid: string | null
  label: string
  roles: string[]
  joinedOn: string | null
  exitedOn: string | null
  employeeJoined: string | null
  employeeArchivedAt: string | null
  notes: string | null
}

export async function loadMembers(admin: Admin): Promise<Member[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_members')
    .select('*, employee:employees!employee_id(cqid, joined_date, archived_at)').order('created_at').range(f, t), 'members')
  return rows.map(r => ({
    id: r.id,
    employeeId: r.employee_id ?? null,
    cqid: r.employee?.cqid ?? null,
    // CQID for employees (names are private); the label for external investors.
    label: r.employee?.cqid ?? r.display_label ?? 'Investor',
    roles: r.roles ?? [],
    joinedOn: r.joined_on ?? null,
    exitedOn: r.exited_on ?? null,
    employeeJoined: r.employee?.joined_date ?? null,
    employeeArchivedAt: r.employee?.archived_at ? day(r.employee.archived_at) : null,
    notes: r.notes ?? null,
  }))
}

export interface CapitalRow extends CapitalMovement {
  kind: string
  receivedOn: string
  agreementId: string | null
  settlementId: string | null
  reviewId: string | null
  approvedAt: string | null
  reason: string | null
  notes: string | null
  createdAt: string
}

export async function loadCapital(admin: Admin): Promise<CapitalRow[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_capital').select('*').order('effective_on').order('id').range(f, t), 'capital')
  return rows.map(r => ({
    id: r.id, memberId: r.member_id, kind: r.kind, direction: r.direction, amountInr: num(r.amount_inr),
    weight: num(r.weight) || 1, effectiveOn: day(r.effective_on), receivedOn: day(r.received_on), status: r.status,
    agreementId: r.agreement_id ?? null, settlementId: r.settlement_id ?? null, reviewId: r.review_id ?? null,
    approvedAt: r.approved_at ?? null, reason: r.reason ?? null, notes: r.notes ?? null, createdAt: r.created_at,
  }))
}

export interface Agreement {
  id: string
  memberId: string
  kind: 'capital_investment' | 'device_investment'
  title: string
  terms: string | null
  repaymentTerms: string | null
  entitlementsSurviveExit: boolean | null
  deviceCapitalWeight: number | null
  deviceCapitalFixed: boolean | null
  buybackTerms: string | null
  effectiveFrom: string
  effectiveTo: string | null
  documentUrl: string | null
  professionalReviewNote: string | null
  status: 'draft' | 'approved' | 'ended'
  approvedAt: string | null
}

export async function loadAgreements(admin: Admin): Promise<Agreement[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_agreements').select('*').order('created_at').range(f, t), 'agreements')
  return rows.map(r => ({
    id: r.id, memberId: r.member_id, kind: r.kind, title: r.title, terms: r.terms ?? null,
    repaymentTerms: r.repayment_terms ?? null, entitlementsSurviveExit: r.entitlements_survive_exit ?? null,
    deviceCapitalWeight: r.device_capital_weight != null ? num(r.device_capital_weight) : null,
    deviceCapitalFixed: r.device_capital_fixed ?? null, buybackTerms: r.buyback_terms ?? null,
    effectiveFrom: day(r.effective_from), effectiveTo: r.effective_to ? day(r.effective_to) : null,
    documentUrl: r.document_url ?? null, professionalReviewNote: r.professional_review_note ?? null,
    status: r.status, approvedAt: r.approved_at ?? null,
  }))
}

// ── Runs, entitlements, settlements, reserve ─────────────────────────────────

export interface RunRow {
  id: string
  periodStart: string
  periodEnd: string
  status: 'draft' | 'calculated' | 'reviewed' | 'confirmed' | 'void'
  openingLossInr: number | null
  openingLossEntered: boolean
  profitInr: number | null
  eligibleProfitInr: number | null
  poolInr: number | null
  capitalShareInr: number | null
  reserveInr: number | null
  closingLossInr: number | null
  totalRetainedInr: number | null
  cashAvailableInr: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary: any
  fingerprint: string | null
  calculatedAt: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  cashAckText: string | null
  voidReason: string | null
  createdAt: string
}

const optNum = (v: unknown) => (v == null ? null : num(v))

export async function loadRuns(admin: Admin): Promise<RunRow[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_runs').select('*').order('period_start').order('id').range(f, t), 'runs')
  return rows.map(r => ({
    id: r.id, periodStart: day(r.period_start), periodEnd: day(r.period_end), status: r.status,
    openingLossInr: optNum(r.opening_loss_inr), openingLossEntered: !!r.opening_loss_entered,
    profitInr: optNum(r.profit_inr), eligibleProfitInr: optNum(r.eligible_profit_inr), poolInr: optNum(r.pool_inr),
    capitalShareInr: optNum(r.capital_share_inr), reserveInr: optNum(r.reserve_inr), closingLossInr: optNum(r.closing_loss_inr),
    totalRetainedInr: optNum(r.total_retained_inr), cashAvailableInr: optNum(r.cash_available_inr),
    summary: r.summary ?? null, fingerprint: r.fingerprint ?? null, calculatedAt: r.calculated_at ?? null,
    reviewedAt: r.reviewed_at ?? null, reviewedBy: r.reviewed_by ?? null, confirmedAt: r.confirmed_at ?? null,
    confirmedBy: r.confirmed_by ?? null, cashAckText: r.cash_ack_text ?? null, voidReason: r.void_reason ?? null,
    createdAt: r.created_at,
  }))
}

export interface EntitlementRow {
  id: string
  runId: string
  memberId: string
  capitalDays: number
  share: number
  amountInr: number
}

export async function loadEntitlements(admin: Admin): Promise<EntitlementRow[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_entitlements').select('id, run_id, member_id, capital_days, share, amount_inr').order('id').range(f, t), 'entitlements')
  return rows.map(r => ({ id: r.id, runId: r.run_id, memberId: r.member_id, capitalDays: num(r.capital_days), share: num(r.share), amountInr: num(r.amount_inr) }))
}

export interface SettlementRow extends SettlementRef {
  settledOn: string
  reviewId: string | null
  reason: string | null
  cashAckText: string | null
  createdAt: string
}

export async function loadSettlements(admin: Admin): Promise<SettlementRow[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_settlements')
    .select('*, valuation:profit_share_device_valuations!device_valuation_id(kind)').order('created_at').order('id').range(f, t), 'settlements')
  return rows.map(r => ({
    id: r.id, kind: r.kind, entitlementId: r.entitlement_id ?? null, deviceValuationId: r.device_valuation_id ?? null,
    deviceKind: r.valuation?.kind ?? null, amountInr: num(r.amount_inr), settledOn: day(r.settled_on),
    reviewId: r.review_id ?? null, reason: r.reason ?? null, cashAckText: r.cash_ack_text ?? null, createdAt: r.created_at,
  }))
}

export async function loadCashLinks(admin: Admin): Promise<CashLink[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_cash_links').select('cashbook_entry_id, owner_kind, owner_id').order('cashbook_entry_id').range(f, t), 'cash links')
  return rows.map(r => ({ entryId: r.cashbook_entry_id, ownerKind: r.owner_kind, ownerId: r.owner_id }))
}

export interface ReserveMovement { id: string; runId: string | null; kind: 'allocation' | 'release' | 'reversal'; amountInr: number; movedOn: string; reason: string | null }

export async function loadReserve(admin: Admin): Promise<ReserveMovement[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_reserve_movements').select('*').order('moved_on').order('id').range(f, t), 'reserve')
  return rows.map(r => ({ id: r.id, runId: r.run_id ?? null, kind: r.kind, amountInr: num(r.amount_inr), movedOn: day(r.moved_on), reason: r.reason ?? null }))
}

/** Allocations and reversals of a release add; releases subtract. */
export const reserveBalance = (m: ReserveMovement[]) =>
  round2(m.reduce((s, x) => s + (x.kind === 'release' ? -x.amountInr : x.amountInr), 0))

export async function loadReviews(admin: Admin): Promise<(Review & { note: string | null })[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_reviews').select('*').order('reviewed_at').order('id').range(f, t), 'reviews')
  return rows.map(r => ({
    id: r.id, sourceTable: r.source_table, sourceId: r.source_id, category: r.category as ReviewCategory,
    classification: r.classification, memberId: r.member_id ?? null, amountInr: optNum(r.amount_inr),
    reviewedOn: day(r.reviewed_at), detail: r.detail ?? null, note: r.note ?? null,
  }))
}

// ── Devices ─────────────────────────────────────────────────────────────────

export interface DeviceRow {
  id: string
  memberId: string
  ownership: 'employee_owned' | 'company_owned' | 'transferred'
  category: string
  brand: string | null
  model: string | null
  specs: string | null
  serialNumber: string | null
  purchaseDate: string | null
  purchasePriceInr: number | null
  priceIsEstimated: boolean
  condition: string | null
  usageStart: string | null
  usageEnd: string | null
  notes: string | null
}

export async function loadDevices(admin: Admin): Promise<DeviceRow[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_devices').select('*').order('created_at').order('id').range(f, t), 'devices')
  return rows.map(r => ({
    id: r.id, memberId: r.member_id, ownership: r.ownership, category: r.category, brand: r.brand ?? null,
    model: r.model ?? null, specs: r.specs ?? null, serialNumber: r.serial_number ?? null,
    purchaseDate: r.purchase_date ? day(r.purchase_date) : null, purchasePriceInr: optNum(r.purchase_price_inr),
    priceIsEstimated: !!r.price_is_estimated, condition: r.condition ?? null,
    usageStart: r.usage_start ? day(r.usage_start) : null, usageEnd: r.usage_end ? day(r.usage_end) : null, notes: r.notes ?? null,
  }))
}

export interface DeviceEventRow { id: string; deviceId: string; kind: string; eventDate: string; costInr: number | null; paidBy: string | null; notes: string | null }

export async function loadDeviceEvents(admin: Admin): Promise<DeviceEventRow[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_device_events').select('*').order('event_date').order('id').range(f, t), 'device events')
  return rows.map(r => ({ id: r.id, deviceId: r.device_id, kind: r.kind, eventDate: day(r.event_date), costInr: optNum(r.cost_inr), paidBy: r.paid_by ?? null, notes: r.notes ?? null }))
}

export interface ValuationRow {
  id: string
  deviceId: string
  kind: 'usage' | 'transfer'
  windowStart: string | null
  windowEnd: string | null
  asOf: string | null
  status: string
  settingsId: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputs: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evidence: any
  usageBasis: string | null
  verifiedShare: number | null
  verifiedReason: string | null
  businessShare: number | null
  proposedInr: number | null
  adjustedInr: number | null
  adjustmentReason: string | null
  outcome: string | null
  confirmedAt: string | null
  createdAt: string
}

export async function loadValuations(admin: Admin): Promise<ValuationRow[]> {
  const rows = await readAll((f, t) => admin.from('profit_share_device_valuations').select('*').order('created_at').order('id').range(f, t), 'valuations')
  return rows.map(r => ({
    id: r.id, deviceId: r.device_id, kind: r.kind, windowStart: r.window_start ? day(r.window_start) : null,
    windowEnd: r.window_end ? day(r.window_end) : null, asOf: r.as_of ? day(r.as_of) : null, status: r.status,
    settingsId: r.settings_id ?? null, inputs: r.inputs ?? null, evidence: r.evidence ?? null,
    usageBasis: r.usage_basis ?? null, verifiedShare: optNum(r.verified_share), verifiedReason: r.verified_reason ?? null,
    businessShare: optNum(r.business_share), proposedInr: optNum(r.proposed_inr), adjustedInr: optNum(r.adjusted_inr),
    adjustmentReason: r.adjustment_reason ?? null, outcome: r.outcome ?? null,
    confirmedAt: r.confirmed_at ? day(r.confirmed_at) : null, createdAt: r.created_at,
  }))
}

export const valuationAmount = (v: Pick<ValuationRow, 'adjustedInr' | 'proposedInr'>) => v.adjustedInr ?? v.proposedInr ?? 0

export interface EventRow { id: number; at: string; actorId: string | null; entity: string; entityId: string | null; action: string; detail: unknown }

export async function loadEvents(admin: Admin, limit = 300): Promise<EventRow[]> {
  const { data, error } = await admin.from('profit_share_events').select('*').order('id', { ascending: false }).limit(limit)
  if (error) throw new Error(`[profit-sharing] events: ${error.message}`)
  return (data ?? []).map(r => ({ id: r.id, at: r.at, actorId: r.actor_id ?? null, entity: r.entity, entityId: r.entity_id ?? null, action: r.action, detail: r.detail }))
}

/** Append an audit event. Never logActivity: the activity feed is visible to non-admins. */
export async function recordEvent(admin: Admin, e: { actorId: string | null; entity: string; entityId: string | null; action: string; detail?: unknown }) {
  const { error } = await admin.from('profit_share_events').insert({
    actor_id: e.actorId, entity: e.entity, entity_id: e.entityId, action: e.action, detail: e.detail ?? null,
  })
  if (error) throw new Error(`[profit-sharing] audit: ${error.message}`)
}

// ── Obligations ──────────────────────────────────────────────────────────────

export function pendingByEntitlement(entitlements: EntitlementRow[], settlements: SettlementRow[], runs: RunRow[]) {
  const confirmed = new Set(runs.filter(r => r.status === 'confirmed').map(r => r.id))
  const out = new Map<string, number>()
  for (const e of entitlements) {
    if (!confirmed.has(e.runId)) continue
    const used = settlements.filter(s => s.entitlementId === e.id).reduce((x, s) => x + s.amountInr, 0)
    out.set(e.id, round2(e.amountInr - used))
  }
  return out
}

export function pendingByValuation(valuations: ValuationRow[], settlements: SettlementRow[]) {
  const out = new Map<string, number>()
  for (const v of valuations) {
    if (v.status !== 'confirmed') continue
    const used = settlements.filter(s => s.deviceValuationId === v.id).reduce((x, s) => x + s.amountInr, 0)
    out.set(v.id, round2(valuationAmount(v) - used))
  }
  return out
}

/**
 * Confirmed device usage costs as profit events (D14): the confirmed amount on
 * the confirmation date; a later waiver gives back what was waived, on its date.
 */
export function deviceCostsFrom(valuations: ValuationRow[], settlements: SettlementRow[]): DeviceCost[] {
  const out: DeviceCost[] = []
  for (const v of valuations) {
    if (v.kind !== 'usage' || !v.confirmedAt || !['confirmed', 'settled', 'reinvested', 'waived'].includes(v.status)) continue
    out.push({ valuationId: v.id, confirmedOn: v.confirmedAt, amountInr: valuationAmount(v) })
    for (const s of settlements.filter(x => x.deviceValuationId === v.id && x.kind === 'waived')) {
      out.push({ valuationId: `${v.id}:waiver:${s.id}`, confirmedOn: s.settledOn, amountInr: -s.amountInr })
    }
  }
  return out
}

// ── Cash available right now (D13 recheck at settlement) ─────────────────────

export async function cashBookBalanceNow(admin: Admin): Promise<number> {
  const [accounts, entries] = await Promise.all([
    readAll((f, t) => admin.from('bank_accounts').select('id, opening_balance').order('id').range(f, t), 'bank accounts'),
    readAll((f, t) => admin.from('cashbook_entries').select('id, type, amount_inr').is('deleted_at', null).order('id').range(f, t), 'cash book'),
  ])
  return round2(accounts.reduce((s, a) => s + num(a.opening_balance), 0)
    + entries.reduce((s, e) => s + (e.type === 'inflow' ? num(e.amount_inr) : -num(e.amount_inr)), 0))
}

// ── Everything one period needs ──────────────────────────────────────────────

export interface ModuleState {
  settings: SettingsVersion[]
  members: Member[]
  capital: CapitalRow[]
  agreements: Agreement[]
  runs: RunRow[]
  entitlements: EntitlementRow[]
  settlements: SettlementRow[]
  cashLinks: CashLink[]
  reserve: ReserveMovement[]
  reviews: (Review & { note: string | null })[]
  valuations: ValuationRow[]
}

export async function loadModuleState(admin: Admin): Promise<ModuleState> {
  const [settings, members, capital, agreements, runs, entitlements, settlements, cashLinks, reserve, reviews, valuations] = await Promise.all([
    loadSettingsVersions(admin), loadMembers(admin), loadCapital(admin), loadAgreements(admin), loadRuns(admin),
    loadEntitlements(admin), loadSettlements(admin), loadCashLinks(admin), loadReserve(admin), loadReviews(admin),
    loadValuations(admin),
  ])
  return { settings, members, capital, agreements, runs, entitlements, settlements, cashLinks, reserve, reviews, valuations }
}

/**
 * Build the engine's input for [start, end].
 *
 * `excludeRunId` keeps a run's own reserve allocation out of the reserve
 * balance it is compared against (relevant once it is confirmed).
 */
export async function loadRunInput(admin: Admin, state: ModuleState, run: Pick<RunRow, 'id' | 'periodStart' | 'periodEnd' | 'openingLossInr' | 'openingLossEntered'>): Promise<RunInput> {
  const start = run.periodStart
  const end = run.periodEnd
  const endYear = Number(end.slice(0, 4))

  const [
    categories, accounts, entryRows, allocRows, invoiceRows, itemRows, expenseRows, adRows, walletRows,
    payrollRows, payrollAllocRows, creditRows, lockRows,
  ] = await Promise.all([
    readAll((f, t) => admin.from('cashbook_categories').select('id, name, statement_section, account_code').order('id').range(f, t), 'categories'),
    readAll((f, t) => admin.from('bank_accounts').select('id, name, opening_balance, reconcile_from, is_active').order('id').range(f, t), 'bank accounts'),
    readWithOptional(admin, 'cashbook_entries',
      'id, entry_date, type, amount_inr, category_id, client_id, employee_id, invoice_id, bank_account_id, transfer_ref, reference, is_billable',
      'reversal_of', q => q.is('deleted_at', null).lte('entry_date', end), 'cash book'),
    readWithOptional(admin, 'cashbook_invoice_allocations',
      'id, cashbook_entry_id, invoice_id, allocated_amount, created_at, deleted_at',
      'released_by_entry_id', q => q, 'invoice allocations'),
    readAll((f, t) => admin.from('invoices')
      .select('id, client_id, status, exchange_rate, total_amount, total_amount_inr, tax_amount, discount_amount, previous_balance, updated_at')
      .order('id').range(f, t), 'invoices'),
    readAll((f, t) => admin.from('invoice_items').select('id, invoice_id, total').order('id').range(f, t), 'invoice items'),
    readAll((f, t) => admin.from('invoice_expense_items').select('id, invoice_id, markup_amount, original_amount_inr, cashbook_entry_id').order('id').range(f, t), 'invoice expense items'),
    readAll((f, t) => admin.from('invoice_ad_spend_items').select('id, invoice_id, amount_inr').order('id').range(f, t), 'invoice ad spend items'),
    readAll((f, t) => admin.from('ad_wallet_ledger').select('id, cashbook_entry_id, client_id, amount_inr')
      .eq('direction', 'credit').is('deleted_at', null).not('cashbook_entry_id', 'is', null).order('id').range(f, t), 'ad wallet'),
    readAll((f, t) => admin.from('payroll')
      .select('id, employee_id, month, year, base_salary, commission_earned, bonus, adjustment_earned, ownership_earned, advances_deducted, other_deductions, net_salary, status')
      .lte('year', endYear).order('id').range(f, t), 'payroll'),
    readAll((f, t) => admin.from('cashbook_payroll_allocations').select('id, cashbook_entry_id, payroll_id, allocated_amount')
      .is('deleted_at', null).order('id').range(f, t), 'payroll allocations'),
    readAll((f, t) => admin.from('credit_ledger').select('id, credit_type, amount, credit_date, entity_id').order('id').range(f, t), 'credit ledger'),
    readAll((f, t) => admin.from('period_locks').select('id, month, year').order('id').range(f, t), 'period locks').catch(() => []),
  ])

  const cat = new Map(categories.map(c => [c.id, c]))
  const entries: LedgerEntry[] = entryRows.map(r => {
    const c = r.category_id ? cat.get(r.category_id) : null
    return {
      id: r.id, date: day(r.entry_date), type: r.type === 'inflow' ? 'inflow' : 'outflow', amountInr: Math.abs(num(r.amount_inr)),
      categoryId: r.category_id ?? null, categoryName: c?.name ?? null, section: (c?.statement_section as Section) ?? null,
      accountCode: c?.account_code ?? null, clientId: r.client_id ?? null, employeeId: r.employee_id ?? null,
      invoiceId: r.invoice_id ?? null, bankAccountId: r.bank_account_id ?? null, transferRef: r.transfer_ref ?? null,
      reversalOf: r.reversal_of ?? null, isBillable: !!r.is_billable, reference: r.reference ?? null,
    }
  })
  const liveEntryIds = new Set(entries.map(e => e.id))

  // Live allocations, plus allocations a reversal released: the reversal
  // undoes their effect on its own date, so dropping them would rewrite history.
  const allocations: InvoiceAllocation[] = allocRows
    .filter(a => liveEntryIds.has(a.cashbook_entry_id) && (!a.deleted_at || a.released_by_entry_id))
    .map(a => ({ entryId: a.cashbook_entry_id, invoiceId: a.invoice_id, amountInr: num(a.allocated_amount), allocatedOn: day(a.created_at) }))

  const sumBy = <T>(rows: T[], key: (r: T) => string, val: (r: T) => number) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r))
    return m
  }
  const items = sumBy(itemRows, r => r.invoice_id, r => num(r.total))
  const markup = sumBy(expenseRows, r => r.invoice_id, r => num(r.markup_amount))
  const originals = sumBy(expenseRows, r => r.invoice_id, r => num(r.original_amount_inr))
  const adSpend = sumBy(adRows, r => r.invoice_id, r => num(r.amount_inr))
  const invoices: InvoiceRaw[] = invoiceRows.map(r => ({
    id: r.id, clientId: r.client_id ?? null, status: r.status ?? '', exchangeRate: num(r.exchange_rate) || 1,
    totalAmount: num(r.total_amount), totalAmountInr: r.total_amount_inr == null ? null : num(r.total_amount_inr),
    taxAmount: num(r.tax_amount), discountAmount: num(r.discount_amount), previousBalance: num(r.previous_balance),
    updatedOn: r.updated_at ? day(r.updated_at) : null, itemsTotal: items.get(r.id) ?? 0, markupTotal: markup.get(r.id) ?? 0,
    adSpendInr: adSpend.get(r.id) ?? 0, expenseOriginalInr: originals.get(r.id) ?? 0,
  }))

  const walletCredits: WalletCredit[] = walletRows.map(w => ({ entryId: w.cashbook_entry_id, clientId: w.client_id ?? null, amountInr: num(w.amount_inr) }))
  const rebilledEntryIds = new Set<string>(expenseRows.filter(r => r.cashbook_entry_id).map(r => r.cashbook_entry_id))

  const payroll: PayrollRow[] = payrollRows.map(r => ({
    id: r.id, employeeId: r.employee_id ?? null, month: num(r.month), year: num(r.year), base: num(r.base_salary),
    commission: num(r.commission_earned), bonus: num(r.bonus), adjustment: num(r.adjustment_earned), ownership: num(r.ownership_earned),
    advancesDeducted: num(r.advances_deducted), otherDeductions: num(r.other_deductions),
    storedNet: r.net_salary == null ? null : num(r.net_salary), status: r.status ?? null,
  }))
  const payrollAllocations: PayrollAllocation[] = payrollAllocRows
    .filter(a => liveEntryIds.has(a.cashbook_entry_id))
    .map(a => ({ entryId: a.cashbook_entry_id, payrollId: a.payroll_id, amountInr: num(a.allocated_amount) }))

  const known: CreditType[] = ['given', 'returned', 'converted_drawings', 'converted_salary']
  const credits: CreditRow[] = creditRows
    .filter(c => known.includes(c.credit_type))
    .map(c => ({ id: c.id, type: c.credit_type, employeeId: c.entity_id ?? null, amountInr: Math.abs(num(c.amount)), date: day(c.credit_date) }))

  // A month is closed by an explicit lock or by paid payroll — isMonthFinalized's two signals.
  const finalizedMonths = new Set<string>()
  for (const l of lockRows) finalizedMonths.add(`${l.year}-${String(l.month).padStart(2, '0')}-01`)
  for (const p of payroll) if (p.status === 'paid') finalizedMonths.add(`${p.year}-${String(p.month).padStart(2, '0')}-01`)

  const banks = await bankChecks(admin, accounts, entries, start, end)

  // Obligations already on the books, excluding this run's own figures.
  const pendingEnt = [...pendingByEntitlement(state.entitlements, state.settlements, state.runs).values()].reduce((s, v) => s + v, 0)
  const pendingDev = [...pendingByValuation(state.valuations, state.settlements).values()].reduce((s, v) => s + v, 0)
  const reserve = reserveBalance(state.reserve.filter(m => m.runId !== run.id))

  const confirmed = state.runs.filter(r => r.status === 'confirmed' && r.id !== run.id)
  const previous = confirmed.filter(r => r.periodEnd < start).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1) ?? null
  const isFirst = confirmed.length === 0
  const openingLoss = isFirst ? (run.openingLossEntered ? run.openingLossInr : null) : (previous?.closingLossInr ?? 0)

  const settings = settingsOn(state.settings, start) ?? { ...DEFAULT_SETTINGS }

  return {
    periodStart: start,
    periodEnd: end,
    settings,
    openingLossInr: openingLoss,
    openingLossEntered: isFirst ? run.openingLossEntered : true,
    previousConfirmedEnd: confirmed.length ? confirmed.map(r => r.periodEnd).sort().at(-1)! : null,
    confirmedRanges: confirmed.map(r => ({ start: r.periodStart, end: r.periodEnd })),
    entries,
    accountOpeningBalancesInr: round2(accounts.reduce((s, a) => s + num(a.opening_balance), 0)),
    allocations,
    invoices,
    walletCredits,
    rebilledEntryIds,
    payrollAllocations,
    payrollRows: payroll,
    credits,
    reviews: state.reviews,
    cashLinks: state.cashLinks,
    settlements: state.settlements,
    deviceCosts: deviceCostsFrom(state.valuations, state.settlements),
    capital: state.capital,
    memberIds: state.members.map(m => m.id),
    finalizedMonths,
    banks,
    obligations: { pendingEntitlementsInr: round2(pendingEnt), unpaidDeviceInr: round2(pendingDev), reserveBalanceInr: reserve },
  }
}

/** Bank reconciliation state per account for the period end (D6). */
async function bankChecks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: Admin, accounts: any[], entries: LedgerEntry[], start: string, end: string,
): Promise<BankAccountCheck[]> {
  const under = accounts.filter(a => a.reconcile_from)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let statements: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lines: any[] = []
  if (under.length) {
    statements = await readAll((f, t) => admin.from('bank_statements')
      .select('id, bank_account_id, period_start, period_end, status, closing_balance')
      .in('bank_account_id', under.map(a => a.id)).order('id').range(f, t), 'bank statements').catch(() => [])
    lines = await readAll((f, t) => admin.from('bank_statement_lines').select('id, statement_id, txn_date, status')
      .eq('status', 'unmatched').gte('txn_date', start).lte('txn_date', end).order('id').range(f, t), 'statement lines').catch(() => [])
  }
  return accounts.map(a => {
    const hadEntries = entries.some(e => e.bankAccountId === a.id && e.date >= start && e.date <= end)
    if (!a.reconcile_from) {
      return { id: a.id, name: a.name, underReconciliation: false, covered: false, unmatchedInPeriod: 0, differenceInr: null, hadEntriesInPeriod: hadEntries }
    }
    const mine = statements.filter(s => s.bank_account_id === a.id)
    const covering = mine
      .filter(s => s.status === 'closed' && day(s.period_start) <= end && day(s.period_end) >= end)
      .sort((x, y) => day(x.period_end).localeCompare(day(y.period_end))).at(-1)
    const statementIds = new Set(mine.map(s => s.id))
    let difference: number | null = null
    if (covering && covering.closing_balance != null) {
      const at = day(covering.period_end)
      const book = num(a.opening_balance) + entries
        .filter(e => e.bankAccountId === a.id && e.date <= at)
        .reduce((s, e) => s + (e.type === 'inflow' ? e.amountInr : -e.amountInr), 0)
      difference = round2(num(covering.closing_balance) - book)
    }
    return {
      id: a.id, name: a.name, underReconciliation: true, covered: !!covering,
      unmatchedInPeriod: lines.filter(l => statementIds.has(l.statement_id)).length,
      differenceInr: difference, hadEntriesInPeriod: hadEntries,
    }
  })
}

/** Months a new period can start on: the day after the last confirmed period, or any month for the first one. */
export function nextPeriodStart(runs: RunRow[]): string | null {
  const last = runs.filter(r => r.status === 'confirmed').map(r => r.periodEnd).sort().at(-1)
  return last ? addDays(last, 1) : null
}

export { monthsOf, monthEnd }
