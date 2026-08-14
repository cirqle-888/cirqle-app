/**
 * Business Partner read queries.
 *
 * Every query here is a plain SELECT — this module never writes to
 * `invoices`, `invoice_items`, `payments`, or `cashbook_entries`. It reads
 * those tables only to roll up figures for a partner's linked clients.
 */
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { buildClientProfitability } from '@/lib/finance/client-profitability'
import { BAD_DEBT_STATUS, badDebtLoss } from '@/lib/finance/invoice-revenue'
import type { ClientProfitabilityInput, ClientProfitabilityRow } from '@/lib/finance/types'
import { todayISO } from '@/lib/utils/local-date'

export interface BusinessPartner {
  id: string
  partner_code: string
  name: string
  company: string | null
  phone: string | null
  email: string | null
  commission_type: 'percentage' | 'flat' | null
  commission_value: number | null
  notes: string | null
  status: 'active' | 'inactive'
  created_at: string
  updated_at: string
}

export interface PartnerClientRow {
  id: string
  name: string
  code: string
  /** Collectible only — what the client has actually been billed for. */
  outstanding: number
  pendingInvoices: number
  /** Drafts sitting on this client, never shown to the partner. */
  draftAmount: number
  draftInvoices: number
  /** Handover date — only invoices issued on/after it count as the partner's. */
  partnerSince: string | null
  /** Finance-Engine contribution margin on the invoices attributed to this partner. */
  profitInr: number
  /** Margin ÷ invoiced, as a percentage (0 when nothing was invoiced). */
  marginPct: number
  // ── Commission-planner inputs (attributed invoices only) ──────────────────
  /** Billed on the partner's invoices, pass-through spend included. */
  invoicedInr: number
  /** Of that, already paid. */
  collectedInr: number
  /** Pass-through spend inside those invoices (ad spend + rebilled expense originals). */
  directCostsInr: number
  /** Written off as unrecoverable — a loss, already subtracted from profitInr. */
  badDebtInr: number
  lastPayment: string | null
  lastInvoice: string | null
}

export interface PartnerDashboardData {
  totalClients: number
  /**
   * What the partner can actually chase — sent/partial/overdue only, so it ties
   * to the statement they get. Unsent drafts are counted separately below.
   */
  pendingCollection: number
  draftAmount: number
  draftInvoices: number
  collectedAmount: number
  /**
   * Contribution margin across every client this partner brought — what the
   * business actually keeps after direct costs and attributed labor. Revenue is
   * invoiced (not collected), so this is profit *earned*, not profit banked.
   */
  totalProfit: number
  /** Total margin ÷ total invoiced across the partner's clients. */
  totalMarginPct: number
  /** Written off across this partner's clients — the loss, already inside totalProfit. */
  totalBadDebt: number
  lastCollection: string | null
  clients: PartnerClientRow[]
}

export interface PartnerStatementInvoiceRow {
  clientName: string
  invoiceNumber: string
  amount: number
  pending: number
  status: string
}

export interface PartnerStatementData {
  partner: BusinessPartner
  statementDate: string
  rows: PartnerStatementInvoiceRow[]
  totalOutstanding: number
}

const OUTSTANDING_EXCLUDED_STATUSES = ['cancelled', 'bad_debt']

/**
 * A statement is what the partner chases the client with, so it only lists
 * invoices the client has actually received. Drafts (and reviewed-but-unsent
 * invoices) are internal — they belong in Follow-ups → "Needs to be sent",
 * never in a partner's collection statement.
 */
const STATEMENT_EXCLUDED_STATUSES = [...OUTSTANDING_EXCLUDED_STATUSES, 'draft', 'reviewed']

// Bad-debt policy (recognise only what a write-off collected; report the rest as
// a loss) lives in the Finance Engine — lib/finance/invoice-revenue.ts — so this
// module, the Client Profitability report, the dashboard and Business Health all
// share one definition instead of four.

interface RawPayment {
  amount: number
  payment_date: string
}

interface RawInvoice {
  id: string
  invoice_number: string
  status: string
  total_amount: number
  paid_amount: number
  total_amount_inr: number | null
  paid_amount_inr: number | null
  issue_date: string
  payments: RawPayment[] | null
}

interface RawClientWithInvoices {
  id: string
  name: string
  code: string
  /** Date the partner took this client over; null = the whole history is theirs. */
  partner_since: string | null
  invoices: RawInvoice[] | null
}

interface ScoreWithTask {
  earnings_inr: number | null
  task: { client_id: string | null; task_date: string | null; deleted_at: string | null } | null
}

/**
 * Is this invoice the partner's? Only invoices issued on or after the handover
 * date count — a client's pre-partner billing history is ours, not theirs.
 */
function attributedToPartner(inv: RawInvoice, partnerSince: string | null): boolean {
  if (!partnerSince) return true
  return !!inv.issue_date && inv.issue_date >= partnerSince
}

export async function listPartners(): Promise<BusinessPartner[]> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('business_partners')
    .select('*')
    .order('name')
  return (data ?? []) as BusinessPartner[]
}

export interface PartnerSummary {
  totalClients: number
  /** Collectible outstanding (sent/partial/overdue), inside the handover window. */
  pendingCollection: number
  /** Unsent drafts — internal only, never on the partner's statement. */
  draftAmount: number
  collectedAmount: number
  /** Written off as unrecoverable — a loss, not something the partner can chase. */
  badDebtInr: number
  lastCollection: string | null
}

/**
 * Headline figures for every partner at once, for the partner list cards.
 *
 * One query over all linked clients rather than N dashboard loads — the list is
 * a scan surface, so it deliberately skips the expensive margin rollup that the
 * detail page does.
 */
export async function listPartnerSummaries(): Promise<Record<string, PartnerSummary>> {
  const supabase = createAdminClient()

  const select = (withSince: boolean) => supabase
    .from('clients')
    .select(`
      id, business_partner_id${withSince ? ', partner_since' : ''},
      invoices(status, total_amount, paid_amount, total_amount_inr, paid_amount_inr, issue_date,
        payments(payment_date))
    `)
    .not('business_partner_id', 'is', null)

  const first = await select(true)
  // Pre-migration DBs have no partner_since column — retry without it.
  const { data } = first.error ? await select(false) : first

  const out: Record<string, PartnerSummary> = {}
  type Row = { business_partner_id: string; partner_since?: string | null; invoices: (RawInvoice & { payments: { payment_date: string }[] | null })[] | null }

  for (const client of (data ?? []) as unknown as Row[]) {
    const partnerId = client.business_partner_id
    const s = out[partnerId] ??= {
      totalClients: 0, pendingCollection: 0, draftAmount: 0, collectedAmount: 0, badDebtInr: 0, lastCollection: null,
    }
    s.totalClients++

    for (const inv of client.invoices ?? []) {
      if (!attributedToPartner(inv, client.partner_since ?? null)) continue

      if (inv.status === BAD_DEBT_STATUS) s.badDebtInr += badDebtLoss(inv)
      if (OUTSTANDING_EXCLUDED_STATUSES.includes(inv.status)) continue

      const total = Number(inv.total_amount_inr ?? inv.total_amount ?? 0)
      const paid  = Number(inv.paid_amount_inr ?? inv.paid_amount ?? 0)
      const due   = total - paid
      s.collectedAmount += paid

      if (STATEMENT_EXCLUDED_STATUSES.includes(inv.status)) {
        if (due > 0) s.draftAmount += due
      } else {
        s.pendingCollection += due
      }

      for (const pmt of inv.payments ?? []) {
        if (!s.lastCollection || pmt.payment_date > s.lastCollection) s.lastCollection = pmt.payment_date
      }
    }
  }

  return out
}

export interface CommissionPayment {
  id: string
  amount_inr: number
  paid_on: string
  method: string | null
  reference: string | null
  percent: number | null
  basis: string | null
  period_from: string | null
  period_to: string | null
  notes: string | null
  created_at: string
}

/**
 * Commission actually paid to a partner, newest first.
 *
 * Returns [] (rather than throwing) when the register table hasn't been migrated
 * yet, so the partner page keeps working — the panel just shows nothing paid.
 */
export async function listCommissionPayments(partnerId: string): Promise<CommissionPayment[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('partner_commission_payments')
    .select('id, amount_inr, paid_on, method, reference, percent, basis, period_from, period_to, notes, created_at')
    .eq('partner_id', partnerId)
    .is('deleted_at', null)
    .order('paid_on', { ascending: false })
    .returns<CommissionPayment[]>()

  if (error) return []
  return data ?? []
}

export async function getPartner(id: string): Promise<BusinessPartner | null> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('business_partners')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  return (data as BusinessPartner) ?? null
}

/** Clients linked to a partner, with their invoices/payments for rollups. */
async function loadLinkedClientsWithInvoices(supabase: ReturnType<typeof createAdminClient>, partnerId: string): Promise<RawClientWithInvoices[]> {
  const invoiceSelect = `
      invoices(
        id, invoice_number, status, total_amount, paid_amount,
        total_amount_inr, paid_amount_inr, issue_date,
        payments(amount, payment_date)
      )`

  const { data, error } = await supabase
    .from('clients')
    .select(`id, name, code, partner_since,${invoiceSelect}`)
    .eq('business_partner_id', partnerId)
    .order('name')

  // `partner_since` arrives with migration 20260714170000. Until it's applied,
  // fall back to the old shape — every invoice is then attributed to the
  // partner, which is exactly the pre-migration behaviour.
  if (error) {
    const { data: legacy } = await supabase
      .from('clients')
      .select(`id, name, code,${invoiceSelect}`)
      .eq('business_partner_id', partnerId)
      .order('name')
    return ((legacy ?? []) as unknown as RawClientWithInvoices[])
      .map(c => ({ ...c, partner_since: null }))
  }

  return (data ?? []) as unknown as RawClientWithInvoices[]
}

/**
 * Contribution margin for each of a partner's clients, restricted to the
 * invoices the handover window attributes to them.
 *
 * The arithmetic is the Finance Engine's (`buildClientProfitability`) — this
 * function only gathers the inputs, so the partner page and the Client
 * Profitability report can never drift on what "margin" means:
 *
 *   margin = invoiced − direct costs − attributed labor + rebilling markup
 *
 * Rebilled expenses hang off the attributed invoices. Labor and ad spend don't,
 * so they're windowed by their own dates (`tasks.task_date` — what payroll uses
 * — and the ledger's `created_at`). Every source is optional: a missing table
 * just zeroes that cost component, it never breaks the page.
 */
async function loadPartnerClientMargins(
  supabase: ReturnType<typeof createAdminClient>,
  clients: RawClientWithInvoices[],
): Promise<Map<string, ClientProfitabilityRow>> {
  const inputs: ClientProfitabilityInput[] = []
  const invoiceIds: string[] = []
  const clientOfInvoice = new Map<string, string>()
  const sinceOf = new Map(clients.map(c => [c.id, c.partner_since]))

  for (const client of clients) {
    const attributed = (client.invoices ?? []).filter(inv => attributedToPartner(inv, client.partner_since))
    const billed   = attributed.filter(inv => !STATEMENT_EXCLUDED_STATUSES.includes(inv.status))
    const writtenOff = attributed.filter(inv => inv.status === BAD_DEBT_STATUS)

    // Costs are gathered for BOTH: a written-off job still consumed ad spend,
    // rebilled expenses and staff time.
    for (const inv of [...billed, ...writtenOff]) {
      invoiceIds.push(inv.id)
      clientOfInvoice.set(inv.id, client.id)
    }

    const paidOn = (list: RawInvoice[]) =>
      list.reduce((s, i) => s + Number(i.paid_amount_inr ?? i.paid_amount ?? 0), 0)

    inputs.push({
      clientId: client.id,
      clientName: client.name,
      // Written-off invoices contribute only what was actually collected on
      // them — the unpaid remainder is never recognised as revenue, so the loss
      // falls straight out of the margin.
      invoicedInr:  billed.reduce((s, i) => s + Number(i.total_amount_inr ?? i.total_amount ?? 0), 0)
                    + paidOn(writtenOff),
      collectedInr: paidOn(billed) + paidOn(writtenOff),
      directCostsInr: 0,
      attributedLaborInr: 0,
      markupRevenueInr: 0,
    })
  }

  const byClient = new Map(inputs.map(i => [i.clientId, i]))

  if (invoiceIds.length) {
    // Rebilled client expenses: original = our cost, billed − original = markup.
    const { data: expenses } = await supabase
      .from('invoice_expense_items')
      .select('invoice_id, amount_inr, original_amount_inr')
      .in('invoice_id', invoiceIds)
      .returns<{ invoice_id: string; amount_inr: number | null; original_amount_inr: number | null }[]>()

    for (const e of expenses ?? []) {
      const row = byClient.get(clientOfInvoice.get(e.invoice_id) ?? '')
      if (!row) continue
      const original = Number(e.original_amount_inr ?? e.amount_inr ?? 0)
      const billed = Number(e.amount_inr ?? original)
      row.directCostsInr += original
      row.markupRevenueInr = (row.markupRevenueInr ?? 0) + Math.max(0, billed - original)
    }

  }

  // Attributed labor: commission earned on the client's tasks, exactly as the
  // Client Profitability report attributes it (via tasks.client_id — invoices
  // often don't link their tasks, so joining through invoice_items silently
  // returns zero labor and reports a 100% margin). Windowed by `task_date`, the
  // same date payroll uses.
  const { data: scores } = await fetchAll(
    supabase
      .from('contribution_scores')
      .select('earnings_inr, task:tasks(client_id, task_date, deleted_at)')
      .returns<ScoreWithTask[]>(),
  )

  for (const s of (scores ?? []) as ScoreWithTask[]) {
    const task = s.task
    if (!task?.client_id || task.deleted_at) continue
    const row = byClient.get(task.client_id)
    if (!row) continue
    const since = sinceOf.get(task.client_id)
    if (since && (!task.task_date || task.task_date < since)) continue
    row.attributedLaborInr += Number(s.earnings_inr || 0)
  }

  // Ad spend allocated to the client's campaigns (GST-inclusive money paid).
  // Not invoice-linked, so it's windowed by the handover date directly.
  const { data: walletDebits } = await supabase
    .from('ad_wallet_ledger')
    .select('client_id, amount_inr, created_at')
    .in('client_id', clients.map(c => c.id))
    .eq('direction', 'debit')
    .eq('kind', 'campaign_allocation')
    .is('deleted_at', null)
    .returns<{ client_id: string; amount_inr: number | null; created_at: string }[]>()

  for (const d of walletDebits ?? []) {
    const row = byClient.get(d.client_id)
    if (!row) continue
    const since = sinceOf.get(d.client_id)
    if (since && d.created_at.slice(0, 10) < since) continue
    row.directCostsInr += Number(d.amount_inr || 0)
  }

  const { rows } = buildClientProfitability(inputs)
  return new Map(rows.map(r => [r.clientId, r]))
}

export async function getPartnerDashboard(partnerId: string): Promise<PartnerDashboardData> {
  const supabase = createAdminClient()
  const clients = await loadLinkedClientsWithInvoices(supabase, partnerId)
  const margins = await loadPartnerClientMargins(supabase, clients)

  let pendingCollection = 0
  let draftAmount = 0
  let draftInvoices = 0
  let collectedAmount = 0
  let totalBadDebt = 0
  let lastCollection: string | null = null

  const clientRows: PartnerClientRow[] = clients.map(client => {
    const invoices = client.invoices ?? []
    let outstanding = 0
    let pendingInvoices = 0
    let clientDraftAmount = 0
    let clientDraftInvoices = 0
    let clientBadDebt = 0
    let lastInvoice: string | null = null
    let lastPayment: string | null = null

    for (const inv of invoices) {
      // Billed before this partner took the client over → not their business at all.
      if (!attributedToPartner(inv, client.partner_since)) continue

      const total = Number(inv.total_amount) || 0
      const paid = Number(inv.paid_amount) || 0
      collectedAmount += paid

      // Written off: not collectible, not on the statement — but reported as a loss.
      if (inv.status === BAD_DEBT_STATUS) clientBadDebt += badDebtLoss(inv)

      if (!OUTSTANDING_EXCLUDED_STATUSES.includes(inv.status)) {
        const due = total - paid
        // Drafts are ours to send, not the partner's to chase — they're kept out
        // of `outstanding` so the KPI ties to the statement, and totalled apart.
        if (STATEMENT_EXCLUDED_STATUSES.includes(inv.status)) {
          if (due > 0) { clientDraftAmount += due; clientDraftInvoices++ }
        } else {
          outstanding += due
          if (due > 0) pendingInvoices++
        }
      }

      if (!lastInvoice || inv.issue_date > lastInvoice) lastInvoice = inv.issue_date

      for (const pmt of inv.payments ?? []) {
        if (!lastPayment || pmt.payment_date > lastPayment) lastPayment = pmt.payment_date
        if (!lastCollection || pmt.payment_date > lastCollection) lastCollection = pmt.payment_date
      }
    }

    pendingCollection += outstanding
    draftAmount += clientDraftAmount
    draftInvoices += clientDraftInvoices
    totalBadDebt += clientBadDebt

    return {
      id: client.id,
      name: client.name,
      code: client.code,
      outstanding,
      pendingInvoices,
      draftAmount: clientDraftAmount,
      draftInvoices: clientDraftInvoices,
      partnerSince: client.partner_since,
      profitInr: margins.get(client.id)?.contributionMarginInr ?? 0,
      marginPct: margins.get(client.id)?.marginPct ?? 0,
      invoicedInr: margins.get(client.id)?.invoicedInr ?? 0,
      collectedInr: margins.get(client.id)?.collectedInr ?? 0,
      directCostsInr: margins.get(client.id)?.directCostsInr ?? 0,
      badDebtInr: clientBadDebt,
      lastPayment,
      lastInvoice,
    }
  })

  const totalProfit = [...margins.values()].reduce((s, m) => s + m.contributionMarginInr, 0)
  const totalInvoiced = [...margins.values()].reduce((s, m) => s + m.invoicedInr, 0)

  return {
    totalClients: clients.length,
    pendingCollection,
    draftAmount,
    draftInvoices,
    collectedAmount,
    totalProfit: Math.round((totalProfit + Number.EPSILON) * 100) / 100,
    totalMarginPct: totalInvoiced > 0 ? Math.round((totalProfit / totalInvoiced) * 1000) / 10 : 0,
    totalBadDebt: Math.round((totalBadDebt + Number.EPSILON) * 100) / 100,
    lastCollection,
    clients: clientRows,
  }
}

export async function getPartnerStatementData(partnerId: string): Promise<PartnerStatementData | null> {
  const supabase = createAdminClient()
  const partner = await getPartner(partnerId)
  if (!partner) return null

  const clients = await loadLinkedClientsWithInvoices(supabase, partnerId)

  const rows: PartnerStatementInvoiceRow[] = []
  let totalOutstanding = 0

  for (const client of clients) {
    for (const inv of client.invoices ?? []) {
      if (!attributedToPartner(inv, client.partner_since)) continue
      if (STATEMENT_EXCLUDED_STATUSES.includes(inv.status)) continue
      const total = Number(inv.total_amount) || 0
      const paid = Number(inv.paid_amount) || 0
      const pending = total - paid
      if (pending <= 0) continue
      totalOutstanding += pending
      rows.push({
        clientName: client.name,
        invoiceNumber: inv.invoice_number,
        amount: total,
        pending,
        status: inv.status,
      })
    }
  }

  return {
    partner,
    statementDate: todayISO(),
    rows,
    totalOutstanding,
  }
}

/** Clients not yet linked to any partner (for the "link client" picker). */
export async function listUnlinkedClients(): Promise<{ id: string; name: string; code: string }[]> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('clients')
    .select('id, name, code')
    .is('business_partner_id', null)
    .eq('is_active', true)
    .order('name')
  return (data ?? []) as { id: string; name: string; code: string }[]
}
