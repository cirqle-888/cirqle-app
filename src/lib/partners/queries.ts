/**
 * Business Partner read queries.
 *
 * Every query here is a plain SELECT — this module never writes to
 * `invoices`, `invoice_items`, `payments`, or `cashbook_entries`. It reads
 * those tables only to roll up figures for a partner's linked clients.
 */
import { createAdminClient } from '@/lib/supabase/server'

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
  outstanding: number
  pendingInvoices: number
  lastPayment: string | null
  lastInvoice: string | null
}

export interface PartnerDashboardData {
  totalClients: number
  pendingCollection: number
  collectedAmount: number
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
  issue_date: string
  payments: RawPayment[] | null
}

interface RawClientWithInvoices {
  id: string
  name: string
  code: string
  invoices: RawInvoice[] | null
}

export async function listPartners(): Promise<BusinessPartner[]> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('business_partners')
    .select('*')
    .order('name')
  return (data ?? []) as BusinessPartner[]
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
  const { data } = await supabase
    .from('clients')
    .select(`
      id, name, code,
      invoices(
        id, invoice_number, status, total_amount, paid_amount, issue_date,
        payments(amount, payment_date)
      )
    `)
    .eq('business_partner_id', partnerId)
    .order('name')
  return (data ?? []) as unknown as RawClientWithInvoices[]
}

export async function getPartnerDashboard(partnerId: string): Promise<PartnerDashboardData> {
  const supabase = createAdminClient()
  const clients = await loadLinkedClientsWithInvoices(supabase, partnerId)

  let pendingCollection = 0
  let collectedAmount = 0
  let lastCollection: string | null = null

  const clientRows: PartnerClientRow[] = clients.map(client => {
    const invoices = client.invoices ?? []
    let outstanding = 0
    let pendingInvoices = 0
    let lastInvoice: string | null = null
    let lastPayment: string | null = null

    for (const inv of invoices) {
      const total = Number(inv.total_amount) || 0
      const paid = Number(inv.paid_amount) || 0
      collectedAmount += paid

      if (!OUTSTANDING_EXCLUDED_STATUSES.includes(inv.status)) {
        const due = total - paid
        outstanding += due
        if (due > 0) pendingInvoices++
      }

      if (!lastInvoice || inv.issue_date > lastInvoice) lastInvoice = inv.issue_date

      for (const pmt of inv.payments ?? []) {
        if (!lastPayment || pmt.payment_date > lastPayment) lastPayment = pmt.payment_date
        if (!lastCollection || pmt.payment_date > lastCollection) lastCollection = pmt.payment_date
      }
    }

    pendingCollection += outstanding

    return {
      id: client.id,
      name: client.name,
      code: client.code,
      outstanding,
      pendingInvoices,
      lastPayment,
      lastInvoice,
    }
  })

  return {
    totalClients: clients.length,
    pendingCollection,
    collectedAmount,
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
      if (OUTSTANDING_EXCLUDED_STATUSES.includes(inv.status)) continue
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
    statementDate: new Date().toISOString().slice(0, 10),
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
