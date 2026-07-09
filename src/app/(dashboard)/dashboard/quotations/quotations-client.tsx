'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { RequestApprovalDialog } from '@/components/approvals/request-approval-dialog'
import { createClient } from '@/lib/supabase/client'
import { getStatusColor, getStatusLabel, generateQuotationNumber } from '@/lib/utils/invoice'
import { formatCurrency } from '@/lib/calculations/currency'
import { Plus, X, ChevronDown, ChevronRight, ExternalLink, Search, FileText, ArrowRight, CheckCircle2 } from 'lucide-react'
import type { Currency } from '@/types'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { seedFromTasks } from '@/lib/hooks/use-smart-sort'
import { useRole } from '@/contexts/role-context'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { cn, ROW_INTERACTIVE_CLASS, BRANDED_PILL_BASE_CLASS, BRANDED_PILL_SELECTED_CLASS, BRANDED_PILL_ACTIVE_CLASS } from "@/lib/utils"
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import dynamic from 'next/dynamic'

const ClientEditModal = dynamic(() => import('@/components/ui/client-edit-modal').then(mod => mod.ClientEditModal), { ssr: false })

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuotationItem {
  description: string
  quantity: number
  unit_price: number
  total: number
}

interface Quotation {
  id: string
  quotation_number: string
  client_id: string
  status: string
  issue_date: string
  valid_until?: string
  currency: Currency
  total_amount: number
  notes?: string
  terms?: string
  client?: { id: string; name: string; code: string }
  items?: QuotationItem[]
}

interface ClientRow {
  id: string
  name: string
  code: string
}

interface Props {
  initialQuotations: Quotation[]
  clients: ClientRow[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']
const QUO_STATUSES = ['draft', 'sent', 'approved', 'rejected', 'converted']

const INPUT_CLS =
  'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors'

// ─── Status workflow steps ────────────────────────────────────────────────────

const WORKFLOW_STEPS = ['draft', 'sent', 'approved', 'converted'] as const

const STEP_COLOR: Record<string, string> = {
  draft: 'bg-muted-foreground',
  sent: 'bg-blue-400',
  approved: 'bg-emerald-400',
  converted: 'bg-violet-400',
  rejected: 'bg-red-400',
}

function StatusWorkflow({ status }: { status: string }) {
  const isRejected = status === 'rejected'
  const steps = isRejected
    ? ['draft', 'sent', 'rejected']
    : [...WORKFLOW_STEPS]

  return (
    <div className="flex items-center gap-1 mb-4 px-1">
      {steps.map((step, i) => {
        const isCurrent = step === status
        const isPast =
          !isRejected && WORKFLOW_STEPS.indexOf(step as typeof WORKFLOW_STEPS[number]) <
            WORKFLOW_STEPS.indexOf(status as typeof WORKFLOW_STEPS[number])

        return (
          <div key={step} className="flex items-center gap-1">
            <div className="flex flex-col items-center gap-0.5">
              <div
                className={`w-2.5 h-2.5 rounded-full border-2 transition-all ${
                  isCurrent
                    ? `${STEP_COLOR[step]} border-transparent ring-2 ring-offset-1 ring-offset-card ring-current scale-110`
                    : isPast
                    ? `${STEP_COLOR[step]} border-transparent opacity-70`
                    : 'bg-transparent border-foreground/20'
                }`}
              />
              <span
                className={`text-[9px] font-medium capitalize whitespace-nowrap ${
                  isCurrent ? 'text-foreground' : isPast ? 'text-muted-foreground/70' : 'text-muted-foreground/40'
                }`}
              >
                {step}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`h-px w-6 mb-3 transition-all ${
                  isPast || isCurrent ? 'bg-foreground/20' : 'bg-foreground/10'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Generate invoice number ──────────────────────────────────────────────────

async function generateInvoiceNumber(
  supabase: ReturnType<typeof createClient>,
  clientCode: string,
  issueDate: string
): Promise<string> {
  const d = new Date(issueDate)
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const prefix = `INV-${yy}${mm}`

  const { data } = await supabase
    .from('invoices')
    .select('invoice_number')
    .like('invoice_number', `${prefix}%`)
    .order('invoice_number', { ascending: false })
    .limit(50)

  let seq = 1
  if (data && data.length > 0) {
    const nums = data
      .map((r: { invoice_number: string }) => {
        const parts = r.invoice_number.split('-')
        return parseInt(parts[parts.length - 1] || '0', 10)
      })
      .filter((n: number) => !isNaN(n))
    if (nums.length > 0) seq = Math.max(...nums) + 1
  }

  const code = (clientCode || '001').toUpperCase()
  return `${prefix}-${code}-${String(seq).padStart(3, '0')}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function QuotationsClient({ initialQuotations, clients: initialClients }: Props) {
  const { role } = useRole()
  const isSuperAdmin = role === 'super_admin'
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [editClientId, setEditClientId] = useState<string | null>(null)
  const [approvalQuote, setApprovalQuote] = useState<{ id: string; quotation_number: string } | null>(null)
  const [quotations, setQuotations] = useState<Quotation[]>(initialQuotations)
  const [clients, setClients] = useState<ClientRow[]>(initialClients)
  const [showForm, setShowForm] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Tokenized search facets (field-scoped + operators) + live draft.
  const [searchFacets, setSearchFacets] = useState<SearchFacet[]>(() => {
    try { const raw = searchParams.get('sf'); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [searchDraft, setSearchDraft] = useState('')
  const activeFacets = useMemo<SearchFacet[]>(
    () => searchDraft.trim() ? [...searchFacets, { field: 'any', op: 'contains' as const, text: searchDraft.trim() }] : searchFacets,
    [searchFacets, searchDraft],
  )

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())

    if (searchFacets.length) params.set('sf', JSON.stringify(searchFacets)); else params.delete('sf')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [searchFacets, pathname, router, searchParams])
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; show: boolean }>({ message: '', show: false })

  // New-client inline form state
  const [showNewClient, setShowNewClient] = useState(false)
  const [newClientSaving, setNewClientSaving] = useState(false)
  const [newClientSuccess, setNewClientSuccess] = useState(false)
  const [newClient, setNewClient] = useState({
    name: '',
    code: '',
    phone: '',
    email: '',
    default_currency: 'INR' as Currency,
  })

  const [form, setForm] = useState({
    client_id: '',
    currency: 'INR' as Currency,
    issue_date: new Date().toISOString().split('T')[0],
    valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    notes: '',
    terms: 'Payment due within 7 days of approval.',
    items: [{ description: '', quantity: 1, unit_price: 0, total: 0 }] as QuotationItem[],
  })

  const supabase = createClient()

  // ── Toast helper ──────────────────────────────────────────────────────────
  function showToast(message: string) {
    setToast({ message, show: true })
    setTimeout(() => setToast({ message: '', show: false }), 4000)
  }

  // ── Seed smart sort on mount ──────────────────────────────────────────────
  useEffect(() => {
    seedFromTasks(
      quotations.map(q => ({ clientId: q.client_id, taskDate: q.issue_date }))
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Auto-suggest client code from name ───────────────────────────────────
  function handleNewClientNameChange(name: string) {
    setNewClient(prev => ({
      ...prev,
      name,
      code: prev.code || name.slice(0, 3).toUpperCase(),
    }))
  }

  // ── Quick-add client ─────────────────────────────────────────────────────
  async function handleSaveNewClient() {
    if (!newClient.name.trim()) return
    setNewClientSaving(true)
    const { data, error } = await supabase
      .from('clients')
      .insert({
        name: newClient.name.trim(),
        code: newClient.code.trim() || newClient.name.slice(0, 3).toUpperCase(),
        phone: newClient.phone.trim() || null,
        email: newClient.email.trim() || null,
        default_currency: newClient.default_currency,
        is_active: true,
      })
      .select('id, name, code')
      .single()

    if (!error && data) {
      const created: ClientRow = { id: data.id, name: data.name, code: data.code }
      setClients(prev => [created, ...prev])
      setForm(p => ({ ...p, client_id: created.id }))
      setNewClientSuccess(true)
      setTimeout(() => {
        setNewClientSuccess(false)
        setShowNewClient(false)
        setNewClient({ name: '', code: '', phone: '', email: '', default_currency: 'INR' })
      }, 1200)
    }
    setNewClientSaving(false)
  }

  // ── Line item update ─────────────────────────────────────────────────────
  function updateItem(i: number, field: keyof QuotationItem, val: string | number) {
    setForm(prev => {
      const items = [...prev.items]
      items[i] = { ...items[i], [field]: val }
      if (field === 'quantity' || field === 'unit_price') {
        items[i].total = items[i].quantity * items[i].unit_price
      }
      return { ...prev, items }
    })
  }

  const totalAmount = form.items.reduce((s, i) => s + (i.total || 0), 0)

  // ── Submit new quotation ─────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const client = clients.find(c => c.id === form.client_id)
    const quotationNumber = generateQuotationNumber(new Date(form.issue_date), client?.code || '001')

    const { data: quo, error } = await supabase
      .from('quotations')
      .insert({
        quotation_number: quotationNumber,
        client_id: form.client_id,
        status: 'draft',
        issue_date: form.issue_date,
        valid_until: form.valid_until || null,
        currency: form.currency,
        total_amount: totalAmount,
        notes: form.notes,
        terms: form.terms,
      })
      .select('*, client:clients(id, name, code)')
      .single()

    if (!error && quo) {
      const itemInserts = form.items
        .filter(i => i.description)
        .map(item => ({
          quotation_id: quo.id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total: item.total,
          currency: form.currency,
        }))
      if (itemInserts.length) await supabase.from('quotation_items').insert(itemInserts)
      setQuotations(prev => [{ ...quo, items: form.items }, ...prev])
      setShowForm(false)
      setForm({
        client_id: '',
        currency: 'INR',
        issue_date: new Date().toISOString().split('T')[0],
        valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        notes: '',
        terms: 'Payment due within 7 days of approval.',
        items: [{ description: '', quantity: 1, unit_price: 0, total: 0 }],
      })
    }
    setSaving(false)
  }

  // ── Status update ────────────────────────────────────────────────────────
  async function updateStatus(id: string, status: string) {
    await supabase.from('quotations').update({ status }).eq('id', id)
    setQuotations(prev => prev.map(q => (q.id === id ? { ...q, status } : q)))
  }

  // ── Convert quotation to invoice ─────────────────────────────────────────
  async function convertToInvoice(quo: Quotation) {
    setConvertingId(quo.id)
    try {
      // 1. Fetch quotation items
      const { data: qItems, error: itemsError } = await supabase
        .from('quotation_items')
        .select('*')
        .eq('quotation_id', quo.id)

      if (itemsError) throw itemsError

      const items: QuotationItem[] = qItems || quo.items || []

      // 2. Generate invoice number
      const clientCode = quo.client?.code || '001'
      const issueDate = new Date().toISOString().split('T')[0]
      const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const invoiceNumber = await generateInvoiceNumber(supabase, clientCode, issueDate)

      // 3. Insert invoice
      const { data: inv, error: invError } = await supabase
        .from('invoices')
        .insert({
          invoice_number: invoiceNumber,
          client_id: quo.client_id,
          status: 'draft',
          issue_date: issueDate,
          due_date: dueDate,
          currency: quo.currency,
          total_amount: quo.total_amount,
          subtotal: quo.total_amount,
          tax_rate: 0,
          tax_amount: 0,
          discount_amount: 0,
          previous_balance: 0,
          notes: quo.notes || '',
        })
        .select('id')
        .single()

      if (invError) throw invError

      // 4. Insert invoice items
      if (items.length > 0) {
        const invItems = items.map((item, index) => ({
          invoice_id: inv.id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total: item.total,
          currency: quo.currency,
          display_order: index,
        }))
        const { error: invItemsError } = await supabase.from('invoice_items').insert(invItems)
        if (invItemsError) throw invItemsError
      }

      // 5. Update quotation status to 'converted'
      await supabase.from('quotations').update({ status: 'converted' }).eq('id', quo.id)
      setQuotations(prev => prev.map(q => (q.id === quo.id ? { ...q, status: 'converted' } : q)))

      // 6. Show success toast
      showToast('Invoice created! Go to Invoices to review.')
    } catch (err) {
      console.error('Failed to convert quotation to invoice:', err)
      showToast('Failed to create invoice. Please try again.')
    } finally {
      setConvertingId(null)
    }
  }

  // ── Tokenized facet search ───────────────────────────────────────────────
  const QUOTE_FIELDS: Record<string, FacetFieldDef> = useMemo(() => ({
    number:  { type: 'text',   get: (q: Quotation) => q.quotation_number },
    client:  { type: 'text',   get: (q: Quotation) => q.client?.name },
    amount:  { type: 'number', get: (q: Quotation) => q.total_amount },
  }), [])
  const quoteGeneric = (q: Quotation) =>
    `${q.quotation_number} ${q.client?.name || ''} ${q.client?.code || ''}`
  const filteredQuotations = activeFacets.length
    ? quotations.filter(q => recordMatchesFacets(activeFacets, q, QUOTE_FIELDS, quoteGeneric))
    : quotations

  // ── Client combobox options ──────────────────────────────────────────────
  const clientOptions = clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div>
      <Header
        title="Quotations"
        subtitle={`${quotations.length} quotation${quotations.length !== 1 ? 's' : ''}`}
        actions={
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            <Plus className="w-4 h-4 shrink-0" />
            New Quotation
          </button>
        }
      />

      {/* ── Toast notification ────────────────────────────────────────────── */}
      {toast.show && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-[#1a1f2e] border border-foreground/15 rounded-2xl px-5 py-3 shadow-2xl text-sm font-medium animate-in fade-in slide-in-from-bottom-3">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toast.message}</span>
          <button
            onClick={() => router.push('/dashboard/invoices')}
            className="ml-2 flex items-center gap-1 text-violet-400 hover:text-violet-300 transition-colors"
          >
            View Invoices <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Search bar (tokenized: Client / Quotation # / Amount + operators) ── */}
      <div className="px-6 pt-5 pb-2">
        <TokenizedSearch
          className="max-w-lg"
          facets={searchFacets}
          onFacetsChange={setSearchFacets}
          draft={searchDraft}
          onDraftChange={setSearchDraft}
          placeholder="Search by client or quotation number…"
          resultCount={filteredQuotations.length}
          resultNoun="quotation"
          fields={[
            { key: 'number', label: 'Quotation #', type: 'text' },
            { key: 'client', label: 'Client', type: 'text' },
            { key: 'amount', label: 'Amount ₹', type: 'number' },
          ]}
        />
      </div>

      {/* ── Quotation list ────────────────────────────────────────────────── */}
      <div className="p-6 space-y-2">
        {filteredQuotations.length === 0 && activeFacets.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
            No quotations match your search.
          </div>
        )}

        {filteredQuotations.length === 0 && activeFacets.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-foreground/[0.04] border border-foreground/15 flex items-center justify-center mb-4">
              <FileText className="w-7 h-7 text-muted-foreground/40" />
            </div>
            <h3 className="font-semibold text-foreground mb-1">No quotations yet</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              Create your first quotation to start sending professional price proposals to clients.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 flex items-center gap-2 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-xl hover:opacity-90"
            >
              <Plus className="w-4 h-4" /> New Quotation
            </button>
          </div>
        )}

        {filteredQuotations.map(quo => (
          <div key={quo.id} className="bg-card border border-border rounded-xl overflow-hidden">
            <div
              className="hover-gradient-card flex items-center justify-between px-5 py-4 rounded-t-xl border border-transparent"
              onClick={() => setExpanded(expanded === quo.id ? null : quo.id)}
            >
              {/* Left: chevron + info */}
              <div className="flex items-center gap-3 min-w-0">
                <div className="shrink-0">
                  {expanded === quo.id
                    ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex flex-col items-start gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-bold tracking-tight">{quo.quotation_number}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${getStatusColor(quo.status)}`}>
                      {getStatusLabel(quo.status)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-medium text-foreground">{quo.client?.name}</span>
                    {quo.client?.code && (
                      <span className="text-[10px] text-muted-foreground font-mono bg-foreground/5 px-1.5 py-0.5 rounded">
                        {quo.client.code}
                      </span>
                    )}
                    <span className="text-muted-foreground text-[10px]">·</span>
                    <span className="text-xs text-muted-foreground">{quo.issue_date}</span>
                    {quo.valid_until && (
                      <>
                        <span className="text-muted-foreground text-[10px]">·</span>
                        <span className="text-xs text-muted-foreground">Valid until: {quo.valid_until}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Right: amount + convert button + status select + admin link */}
              <div className="flex items-center gap-3 shrink-0" onClick={e => e.stopPropagation()}>
                <span className="font-semibold text-sm tabular-nums">
                  {formatCurrency(quo.total_amount || 0, quo.currency)}
                </span>

                {/* Convert to Invoice button (row level, approved only) */}
                {quo.status === 'approved' && (
                  <button
                    onClick={() => convertToInvoice(quo)}
                    disabled={convertingId === quo.id}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 disabled:opacity-50 transition-all"
                  >
                    {convertingId === quo.id ? (
                      <>
                        <span className="w-3.5 h-3.5 border-2 border-emerald-400/40 border-t-emerald-400 rounded-full animate-spin" />
                        Converting…
                      </>
                    ) : (
                      <>
                        Convert to Invoice
                        <ArrowRight className="w-3 h-3" />
                      </>
                    )}
                  </button>
                )}

                <AppSelect
                  value={quo.status}
                  onChange={e => updateStatus(quo.id, e.target.value)}
                  className="text-xs py-1.5 rounded-lg"
                  wrapperClassName="w-[120px]"
                >
                  {QUO_STATUSES.map(s => (
                    <option key={s} value={s}>{getStatusLabel(s)}</option>
                  ))}
                </AppSelect>
                {isSuperAdmin && (
                  <button
                    title="Edit client in Settings"
                    onClick={() => { if (form.client_id) setEditClientId(form.client_id) }}
                    className="text-muted-foreground hover:text-violet-400 transition-colors p-1 rounded hover:bg-violet-500/10"
                  >
                    <ExternalLink style={{ width: 10, height: 10 }} />
                  </button>
                )}
              </div>
            </div>

            {/* Expanded items */}
            {expanded === quo.id && (
              <div className="border-t border-border">
                {/* Status workflow */}
                <div className="px-5 pt-4">
                  <StatusWorkflow status={quo.status} />
                </div>

                {/* Request approval */}
                <div className="px-5 pt-3">
                  <button
                    onClick={() => setApprovalQuote({ id: quo.id, quotation_number: quo.quotation_number })}
                    className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/30 text-sm font-medium transition-colors"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Request Approval
                  </button>
                </div>

                {/* Convert to Invoice (expanded view, approved only) */}
                {quo.status === 'approved' && (
                  <div className="px-5 pb-4">
                    <button
                      onClick={() => convertToInvoice(quo)}
                      disabled={convertingId === quo.id}
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl gradient-bg text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-all"
                    >
                      {convertingId === quo.id ? (
                        <>
                          <span className="w-4 h-4 border-2 border-foreground/40 border-t-white rounded-full animate-spin" />
                          Creating Invoice…
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-4 h-4" />
                          Convert to Invoice
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </div>
                )}

                {quo.items && quo.items.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[500px]">
                      <thead>
                      <tr className="bg-secondary/40">
                        <th className="text-left px-5 py-2 text-xs text-muted-foreground font-medium">Description</th>
                        <th className="text-center px-4 py-2 text-xs text-muted-foreground font-medium">Qty</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Rate</th>
                        <th className="text-right px-5 py-2 text-xs text-muted-foreground font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {quo.items.map((item, i) => (
                        <tr key={i}>
                          <td className="px-5 py-2.5">{item.description}</td>
                          <td className="px-4 py-2.5 text-center text-muted-foreground">{item.quantity}</td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground">
                            {formatCurrency(item.unit_price, quo.currency)}
                          </td>
                          <td className="px-5 py-2.5 text-right font-medium">
                            {formatCurrency(item.total, quo.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
                {quo.notes && (
                  <div className="px-5 py-3 border-t border-border/50 text-xs text-muted-foreground">
                    {quo.notes}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── New Quotation Modal ───────────────────────────────────────────── */}
      {showForm && (
        <ModalOverlay onClose={() => setShowForm(false)} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90dvh] overflow-y-auto">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
              <h2 className="font-semibold">New Quotation</h2>
              <button
                onClick={() => setShowForm(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {/* Client + Currency row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Client *</label>
                  <Combobox
                    sortKey="clients"
                    placeholder="Select client…"
                    options={clientOptions}
                    value={form.client_id}
                    onChange={id => setForm(p => ({ ...p, client_id: id }))}
                    required
                  />

                  {/* Quick-add client toggle */}
                  {!showNewClient ? (
                    <button
                      type="button"
                      onClick={() => setShowNewClient(true)}
                      className="mt-1.5 text-xs text-violet-400 hover:text-violet-300 transition-colors"
                    >
                      + New Client
                    </button>
                  ) : (
                    <div className="mt-2 bg-secondary border border-foreground/15 rounded-xl p-3 space-y-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-muted-foreground">Quick-Add Client</span>
                        {newClientSuccess && (
                          <span className="text-xs text-emerald-400 font-medium">Client added!</span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-muted-foreground mb-1">Name *</label>
                          <input
                            value={newClient.name}
                            onChange={e => handleNewClientNameChange(e.target.value)}
                            placeholder="Client name"
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-muted-foreground mb-1">Code</label>
                          <input
                            value={newClient.code}
                            onChange={e => setNewClient(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                            placeholder="e.g. ABC"
                            maxLength={6}
                            className={INPUT_CLS}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-muted-foreground mb-1">Phone</label>
                          <input
                            value={newClient.phone}
                            onChange={e => setNewClient(p => ({ ...p, phone: e.target.value }))}
                            placeholder="Phone"
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-muted-foreground mb-1">Email</label>
                          <input
                            type="email"
                            value={newClient.email}
                            onChange={e => setNewClient(p => ({ ...p, email: e.target.value }))}
                            placeholder="Email"
                            className={INPUT_CLS}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] text-muted-foreground mb-1">Currency</label>
                        <AppSelect
                          value={newClient.default_currency}
                          onChange={e => setNewClient(p => ({ ...p, default_currency: e.target.value as Currency }))}
                        >
                          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </AppSelect>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => { setShowNewClient(false); setNewClient({ name: '', code: '', phone: '', email: '', default_currency: 'INR' }) }}
                          className="flex-1 text-xs bg-foreground/5 hover:bg-foreground/10 py-1.5 rounded-lg transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveNewClient}
                          disabled={!newClient.name.trim() || newClientSaving}
                          className="flex-1 text-xs gradient-bg text-white py-1.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                        >
                          {newClientSaving ? 'Saving…' : 'Save Client'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Currency</label>
                  <AppSelect
                    value={form.currency}
                    onChange={e => setForm(p => ({ ...p, currency: e.target.value as Currency }))}
                  >
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </AppSelect>
                </div>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Issue Date</label>
                  <input
                    type="date"
                    value={form.issue_date}
                    onChange={e => setForm(p => ({ ...p, issue_date: e.target.value }))}
                    className={INPUT_CLS}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Valid Until</label>
                  <input
                    type="date"
                    value={form.valid_until}
                    onChange={e => setForm(p => ({ ...p, valid_until: e.target.value }))}
                    className={INPUT_CLS}
                  />
                </div>
              </div>

              {/* Line items */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-2">Line Items</label>
                <div className="space-y-2">
                  {form.items.map((item, i) => (
                    <div key={i} className="flex flex-col sm:grid sm:grid-cols-12 gap-2 sm:items-center">
                      <input
                        className={`sm:col-span-5 ${INPUT_CLS}`}
                        placeholder="Description"
                        value={item.description}
                        onChange={e => updateItem(i, 'description', e.target.value)}
                      />
                      <input
                        type="number"
                        min="1"
                        className={`sm:col-span-2 ${INPUT_CLS} sm:text-center`}
                        placeholder="Qty"
                        value={item.quantity}
                        onChange={e => updateItem(i, 'quantity', parseFloat(e.target.value) || 1)}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className={`sm:col-span-3 ${INPUT_CLS}`}
                        placeholder="Rate"
                        value={item.unit_price || ''}
                        onChange={e => updateItem(i, 'unit_price', parseFloat(e.target.value) || 0)}
                      />
                      <div className="sm:col-span-2 text-sm font-medium sm:text-right pr-1 tabular-nums">
                        {item.total > 0 ? item.total.toLocaleString('en-IN') : '—'}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between mt-2">
                  <button
                    type="button"
                    onClick={() =>
                      setForm(p => ({
                        ...p,
                        items: [...p.items, { description: '', quantity: 1, unit_price: 0, total: 0 }],
                      }))
                    }
                    className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
                  >
                    + Add line
                  </button>
                  <div className="text-sm font-semibold tabular-nums">
                    Total: {formatCurrency(totalAmount, form.currency)}
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                  rows={2}
                  placeholder="Optional notes for the client…"
                  className={`${INPUT_CLS} resize-none`}
                />
              </div>

              {/* Terms */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Terms</label>
                <textarea
                  value={form.terms}
                  onChange={e => setForm(p => ({ ...p, terms: e.target.value }))}
                  rows={2}
                  className={`${INPUT_CLS} resize-none`}
                />
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !form.client_id}
                  className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {saving ? 'Creating…' : 'Create Quotation'}
                </button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {editClientId && (
        <ClientEditModal clientId={editClientId} onClose={() => setEditClientId(null)} />
      )}

      {approvalQuote && (
        <RequestApprovalDialog
          defaults={{ entityType: 'quotation', entityId: approvalQuote.id, title: `Approve quotation ${approvalQuote.quotation_number}` }}
          onClose={() => setApprovalQuote(null)}
          onCreated={() => setApprovalQuote(null)}
        />
      )}
    </div>
  )
}
