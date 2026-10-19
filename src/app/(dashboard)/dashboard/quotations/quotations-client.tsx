'use client'

import React from 'react'

import { useState, useEffect, useMemo } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { RequestApprovalDialog } from '@/components/approvals/request-approval-dialog'
import { createClient } from '@/lib/supabase/client'
import { getStatusColor, getStatusLabel } from '@/lib/utils/invoice'
import { formatCurrency } from '@/lib/calculations/currency'
import { Plus, X, ChevronDown, ChevronRight, ExternalLink, FileText, ArrowRight, CheckCircle2, Pencil, Trash2, Eye, Link2, Lock, Printer, Download, Share2, RefreshCw, AlertCircle } from 'lucide-react'
import {
  canDeleteQuotation, isQuotationEditable, quotationLink, quotationLockReason, quotationToForm, sortQuotationLines,
} from '@/lib/quotations/editing'
import { createQuotation, deleteDraftQuotation, updateQuotation } from '@/lib/quotations/save'
import { quotationDocument, renderQuotationHtml } from '@/lib/quotations/render'
import { copyToClipboard } from '@/lib/clipboard'
import type { Currency } from '@/types'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { seedFromTasks } from '@/lib/hooks/use-smart-sort'
import { useRole } from '@/contexts/role-context'
import { usePermissions } from '@/contexts/permission-context'
import { useCreateShortcut } from '@/lib/hooks/use-create-shortcut'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { FormField, FormLabel, FormControl } from '@/components/ui/form'
import dynamic from 'next/dynamic'
import { daysFromTodayISO, todayISO } from '@/lib/utils/local-date'
import { useFormDraft } from '@/lib/drafts/use-form-draft'
import { useScrollRestore } from '@/lib/lists/use-scroll-restore'
import {
  IDLE, SAVING, failed, canSubmit, submitLabel, missingRequired, requiredFieldMessage,
  type SubmitState,
} from '@/lib/forms/submit-state'
import { FormStatus } from '@/components/ui/form-status'
import { DraftRecoveryBanner, DraftSavedHint } from '@/components/ui/draft-recovery'

const ClientEditModal = dynamic(() => import('@/components/ui/client-edit-modal').then(mod => mod.ClientEditModal), { ssr: false })

/**
 * A blank quotation form.
 *
 * Extracted from the two places that built it inline so the draft layer has
 * something to compare against: the form opens pre-filled (today's date,
 * INR, standard terms, one empty line), so "is there a draft worth keeping?"
 * cannot be answered by asking whether any field is non-empty.
 */
function emptyQuotationForm() {
  return {
    client_id: '',
    currency: 'INR' as Currency,
    issue_date: todayISO(),
    valid_until: daysFromTodayISO(30),
    notes: '',
    terms: 'Payment due within 7 days of approval.',
    items: [{ description: '', quantity: 1, unit_price: 0, total: 0 }] as QuotationItem[],
  }
}

type QuotationForm = ReturnType<typeof emptyQuotationForm>

/**
 * Has the user actually started a quotation?
 *
 * The dates are ignored: they are derived from today, so a draft saved
 * yesterday would otherwise always look "edited" when reopened today, and an
 * untouched form would autosave itself on the stroke of midnight.
 */
function quotationFormStarted(form: QuotationForm): boolean {
  const blank = emptyQuotationForm()
  if (form.client_id) return true
  if (form.notes.trim()) return true
  if (form.currency !== blank.currency) return true
  if (form.terms.trim() !== blank.terms) return true
  return form.items.some(i => i.description.trim() || i.unit_price > 0 || i.quantity !== 1)
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <FormField>
      <FormLabel className="text-xs uppercase tracking-wider font-semibold">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </FormLabel>
      {React.isValidElement(children) ? <FormControl>{children}</FormControl> : children}
    </FormField>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuotationItem {
  description: string
  quantity: number
  unit_price: number
  total: number
  display_order?: number | null
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
  client?: { id: string; name: string; code: string; phone?: string | null; email?: string | null; address?: string | null }
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
  /** company_settings map — branding for the client-facing preview / PDF. */
  companySettings: Record<string, string>
}

/** Whether this browser can hand a PDF to the system share sheet. */
function canShareFiles(): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator.canShare) return false
    return navigator.canShare({ files: [new File([''], 'quotation.pdf', { type: 'application/pdf' })] })
  } catch {
    return false
  }
}

/** A saved row as the page shows it: lines in the order they were entered. */
function withSortedItems(q: Quotation): Quotation {
  return { ...q, items: sortQuotationLines(q.items) }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']
const QUO_STATUSES = ['draft', 'sent', 'approved', 'rejected', 'converted']

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

export default function QuotationsClient({ initialQuotations, clients: initialClients, companySettings }: Props) {
  // Coming back from a record lands where the list was left, not at the top.
  // See lib/lists/scroll-restore for the rules.
  useScrollRestore('quotations')

  const { role } = useRole()
  const { can, user: permissionUser } = usePermissions()
  const isSuperAdmin = role === 'super_admin'
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [editClientId, setEditClientId] = useState<string | null>(null)
  const [approvalQuote, setApprovalQuote] = useState<{ id: string; quotation_number: string } | null>(null)
  const [quotations, setQuotations] = useState<Quotation[]>(() => initialQuotations.map(withSortedItems))
  const [clients, setClients] = useState<ClientRow[]>(initialClients)
  const [showForm, setShowForm] = useState(false)
  // The quotation the modal is editing; null while it creates a new one.
  const [editing, setEditing] = useState<Quotation | null>(null)
  const canEdit = can('billing.edit') && !permissionUser.isViewAs
  useCreateShortcut(canEdit, () => openCreate())
  // ?id=<quotation id> opens that quotation (⌘K, Copy link, the activity feed).
  const idFromUrl = searchParams.get('id')
  const [expanded, setExpanded] = useState<string | null>(idFromUrl)
  // Shared save/pending/error vocabulary — see lib/forms/submit-state. This
  // form previously tracked a bare `saving` boolean and, on a failed insert,
  // showed the user nothing at all.
  const [submit, setSubmit] = useState<SubmitState>(IDLE)
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
  const [toast, setToast] = useState<{ message: string; show: boolean; invoicesLink?: boolean; error?: boolean }>({ message: '', show: false })

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

  const [form, setForm] = useState<QuotationForm>(emptyQuotationForm)

  // Unsent quotation drafts survive a refresh or an interrupted session.
  // Autosave runs only while the modal is open, and submission is unchanged —
  // a restored draft still goes through the same insert and the same checks.
  const draft = useFormDraft<QuotationForm>('quotation.new', form, {
    // New quotations only: an edit starts from the saved quotation, and its
    // unsaved changes must never resurface as a "new quotation" draft.
    enabled: showForm && !editing,
    isMeaningful: quotationFormStarted,
  })

  const supabase = createClient()

  // ── Toast helper ──────────────────────────────────────────────────────────
  function showToast(message: string, opts: { invoicesLink?: boolean; error?: boolean } = {}) {
    setToast({ message, show: true, ...opts })
    setTimeout(() => setToast({ message: '', show: false }), 4000)
  }

  // ── Open by link ──────────────────────────────────────────────────────────
  // Expanding a row writes ?id= so the address bar is always a link to what
  // is open. A link arriving from elsewhere expands that row and scrolls to
  // it — the same contract as /dashboard/invoices?id=. `handledLinkId` is the
  // last id acted on; our own writes set it first, so expanding a row by hand
  // doesn't also scroll the page. (The link itself is handled during render,
  // below the search code it depends on.)
  const [handledLinkId, setHandledLinkId] = useState<string | null>(null)
  const [linkMissing, setLinkMissing] = useState(false)
  // A new object per request, so opening the same link twice scrolls twice.
  const [scrollRequest, setScrollRequest] = useState<{ id: string } | null>(null)

  function toggleExpanded(id: string) {
    const next = expanded === id ? null : id
    setExpanded(next)
    setHandledLinkId(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next) params.set('id', next); else params.delete('id')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  useEffect(() => {
    if (!scrollRequest) return
    // After the row has expanded and any scroll restore has run.
    const t = window.setTimeout(() => {
      // Not getElementById: the router keeps the previous visit of this page
      // in the DOM, hidden, so the same row id can exist twice.
      const rows = document.querySelectorAll<HTMLElement>(`[data-quotation-row="${CSS.escape(scrollRequest.id)}"]`)
      Array.from(rows).find(el => el.offsetParent !== null)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 150)
    return () => window.clearTimeout(t)
  }, [scrollRequest])

  async function copyLink(quo: Quotation) {
    const ok = await copyToClipboard(quotationLink(window.location.origin, quo.id))
    showToast(ok ? `Link to ${quo.quotation_number} copied.` : 'Couldn’t copy the link.', { error: !ok })
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

  function removeItem(i: number) {
    setForm(prev => {
      const items = prev.items.filter((_, idx) => idx !== i)
      return { ...prev, items: items.length ? items : [{ description: '', quantity: 1, unit_price: 0, total: 0 }] }
    })
  }

  const totalAmount = form.items.reduce((s, i) => s + (i.total || 0), 0)

  // ── Open / close the modal ───────────────────────────────────────────────
  function openCreate() {
    // Coming from an edit, the form still holds that quotation.
    if (editing) { setEditing(null); setForm(emptyQuotationForm()) }
    setSubmit(IDLE)
    setShowForm(true)
  }

  function openEdit(quo: Quotation) {
    if (!canEdit || !isQuotationEditable(quo.status)) return
    setEditing(quo)
    setForm(quotationToForm(quo))
    setShowNewClient(false)
    setSubmit(IDLE)
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    if (editing) { setEditing(null); setForm(emptyQuotationForm()) }
  }

  // ── Submit new quotation ─────────────────────────────────────────────────
  /** Named so the message can quote the labels the form itself uses. */
  const REQUIRED_FIELDS = [
    { key: 'client_id', label: 'Client' },
    { key: 'issue_date', label: 'Issue date' },
  ]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const missing = requiredFieldMessage(missingRequired(form, REQUIRED_FIELDS))
    if (missing) { setSubmit(failed(missing)); return }
    if (!form.items.some(i => i.description.trim())) {
      setSubmit(failed('Add at least one line with a description.'))
      return
    }

    setSubmit(SAVING)
    // An inactive client is missing from `clients`, but its quotations can still be edited.
    const client = clients.find(c => c.id === form.client_id)
      ?? (editing?.client?.id === form.client_id ? editing.client : undefined)
    const clientCode = client?.code || '001'

    // Numbering, line clean-up and the edit's write order live in
    // lib/quotations/save (tested there).
    const res = editing
      ? await updateQuotation(supabase, editing, form, clientCode)
      : await createQuotation(supabase, form, clientCode)

    // Previously a failed save was a silent no-op: the modal stayed open with
    // no indication that anything had failed.
    if (!res.ok) { setSubmit(failed(res.error)); return }

    const saved = withSortedItems(res.value as unknown as Quotation)
    if (editing) {
      setQuotations(prev => prev.map(q => (q.id === saved.id ? saved : q)))
      setEditing(null)
      showToast(`Saved ${saved.quotation_number}.`)
    } else {
      setQuotations(prev => [saved, ...prev])
      draft.clear() // the quotation exists now; the draft would only confuse
    }
    setShowForm(false)
    setForm(emptyQuotationForm())
    setSubmit(IDLE)
  }

  // ── Delete (drafts only) ─────────────────────────────────────────────────
  const [deleteConfirm, setDeleteConfirm] = useState<Quotation | null>(null)

  async function deleteQuotation(quo: Quotation) {
    const res = await deleteDraftQuotation(supabase, quo.id)
    if (!res.ok) { showToast(res.error, { error: true }); return }
    setQuotations(prev => prev.filter(q => q.id !== quo.id))
    if (expanded === quo.id) toggleExpanded(quo.id) // collapses it and drops ?id=
    showToast(`Deleted ${quo.quotation_number}.`)
  }

  // ── Client-facing preview / print / PDF / share ──────────────────────────
  // The invoice document renderer, printed as a quotation (lib/quotations/render).
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewQuo = previewId ? quotations.find(q => q.id === previewId) ?? null : null
  const [pdfBusy, setPdfBusy] = useState<'download' | 'share' | null>(null)

  function printQuotation(quo: Quotation) {
    const html = renderQuotationHtml(quo, companySettings, { autoprint: true })
    const w = window.open('', '_blank', 'width=800,height=900')
    if (w) { w.document.write(html); w.document.close() }
  }

  async function downloadQuotationPdf(quo: Quotation) {
    setPdfBusy('download')
    try {
      const { downloadInvoicePdf } = await import('@/lib/invoices/download-pdf')
      await downloadInvoicePdf(quotationDocument(quo), companySettings, { kind: 'quotation' })
    } catch (e) {
      console.error('Quotation PDF download failed', e)
      showToast('Could not generate the PDF. Try Print instead.', { error: true })
    } finally {
      setPdfBusy(null)
    }
  }

  /** The system share sheet with the PDF attached (phones, Safari, the desktop app). */
  async function shareQuotationPdf(quo: Quotation) {
    setPdfBusy('share')
    try {
      const { generateInvoicePdf } = await import('@/lib/invoices/download-pdf')
      const pdf = await generateInvoicePdf(quotationDocument(quo), companySettings, { kind: 'quotation' })
      const file = new File([pdf.output('blob')], `${quo.quotation_number}.pdf`, { type: 'application/pdf' })
      await navigator.share({
        files: [file],
        title: quo.quotation_number,
        text: `Quotation ${quo.quotation_number} from ${companySettings.company_name || 'Cirqle Works'}`,
      })
    } catch (e) {
      // Closing the share sheet is not an error.
      if ((e as Error)?.name !== 'AbortError') {
        console.error('Quotation share failed', e)
        showToast('Could not share the PDF. Download it instead.', { error: true })
      }
    } finally {
      setPdfBusy(null)
    }
  }

  // Approving or rejecting is an outcome, not a step: Approved unlocks
  // "Convert to Invoice", Rejected closes the quote. A stray scroll over the
  // row's dropdown used to commit either instantly, so those two confirm.
  const [statusConfirm, setStatusConfirm] = useState<{ quo: Quotation; status: string } | null>(null)

  function requestStatus(quo: Quotation, status: string) {
    if (status !== 'approved' && status !== 'rejected') { void updateStatus(quo.id, status); return }
    setStatusConfirm({ quo, status })
  }

  // ── Status update ────────────────────────────────────────────────────────
  async function updateStatus(id: string, status: string) {
    await supabase.from('quotations').update({ status }).eq('id', id)
    setQuotations(prev => prev.map(q => (q.id === id ? { ...q, status } : q)))
  }

  // Converting writes a real invoice + line items and moves the quotation to
  // Converted — far too consequential for a bare icon click, so it always
  // routes through this confirmation first.
  const [convertConfirm, setConvertConfirm] = useState<Quotation | null>(null)

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
      const issueDate = todayISO()
      const dueDate = daysFromTodayISO(14)
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
      showToast('Invoice created! Go to Invoices to review.', { invoicesLink: true })
    } catch (err) {
      console.error('Failed to convert quotation to invoice:', err)
      showToast('Failed to create invoice. Please try again.', { error: true })
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

  // A link that arrived from elsewhere: adjust state while rendering, React's
  // pattern for following an input that changed, rather than an effect.
  if (idFromUrl && idFromUrl !== handledLinkId) {
    setHandledLinkId(idFromUrl)
    const target = quotations.find(q => q.id === idFromUrl)
    setLinkMissing(!target)
    if (target) {
      setExpanded(idFromUrl)
      setScrollRequest({ id: idFromUrl })
      // A search that hides the linked quotation would make the link look broken.
      if (activeFacets.length && !recordMatchesFacets(activeFacets, target, QUOTE_FIELDS, quoteGeneric)) {
        setSearchFacets([])
        setSearchDraft('')
      }
    }
  }

  // ── Client combobox options ──────────────────────────────────────────────
  const clientOptions = clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))
  // The page lists active clients only; a quotation for one since deactivated
  // must still show who it is for while it is being edited.
  if (editing?.client && !clients.some(c => c.id === editing.client!.id)) {
    clientOptions.unshift({ id: editing.client.id, label: editing.client.name, sub: editing.client.code })
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div>
      <Header
        title="Quotations"
        subtitle={`${quotations.length} quotation${quotations.length !== 1 ? 's' : ''}`}
        actions={
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            <Plus className="w-4 h-4 shrink-0" />
            New Quotation
          </button>
        }
      />

      {/* ── Toast notification ────────────────────────────────────────────── */}
      {toast.show && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[400] flex items-center gap-3 bg-card text-foreground border border-foreground/15 rounded-2xl px-5 py-3 shadow-2xl text-sm font-medium animate-in fade-in slide-in-from-bottom-3">
          {toast.error
            ? <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            : <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
          <span>{toast.message}</span>
          {toast.invoicesLink && (
            <button
              onClick={() => router.push('/dashboard/invoices')}
              className="ml-2 flex items-center gap-1 text-violet-400 hover:text-violet-700 dark:text-violet-300 transition-colors"
            >
              View Invoices <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
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
      <div className="flex-1 bg-card md:rounded-t-xl md:border-t md:border-x border-border/50">
        <div className="w-full">
          {/* Table Header (Desktop Only) */}
          <div className="hidden md:grid grid-cols-[auto_1fr_2fr_1fr_1.5fr_auto] gap-4 px-6 py-3 border-b border-border bg-card/80 backdrop-blur-md sticky top-0 z-10 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <div className="w-6"></div>
            <div>Quotation</div>
            <div>Client</div>
            <div>Date</div>
            <div className="text-right">Amount</div>
            <div className="w-[236px] text-right">Actions</div>
          </div>

          {linkMissing && (
            <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-border text-sm text-muted-foreground bg-amber-500/10">
              <span className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                That quotation link doesn’t match any quotation here. It may have been deleted.
              </span>
              <button onClick={() => setLinkMissing(false)} aria-label="Dismiss"
                className="p-1 rounded text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {filteredQuotations.length === 0 && activeFacets.length > 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
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
                onClick={openCreate}
                className="mt-4 flex items-center gap-2 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-xl hover:opacity-90"
              >
                <Plus className="w-4 h-4" /> New Quotation
              </button>
            </div>
          )}

          <div className="flex flex-col gap-3 p-4 md:p-0 md:divide-y md:divide-border/50 md:block">
            {filteredQuotations.map(quo => (
              <div key={quo.id} data-quotation-row={quo.id} className="group flex flex-col bg-card border border-border md:border-none rounded-xl md:rounded-none md:hover:bg-secondary/20 transition-colors scroll-mt-16">
                
                {/* ─── DESKTOP ROW ─── */}
                <div
                  className={`hidden md:grid grid-cols-[auto_1fr_2fr_1fr_1.5fr_auto] gap-4 px-6 py-3 items-center cursor-pointer ${expanded === quo.id ? 'bg-secondary/30' : ''}`}
                  onClick={() => toggleExpanded(quo.id)}
                >
                  {/* Left: chevron */}
                  <div className="w-6 flex justify-center text-muted-foreground/50 group-hover:text-foreground/70 transition-colors">
                    {expanded === quo.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </div>

                  {/* Quotation Number & Status */}
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-mono text-sm font-semibold text-foreground truncate">{quo.quotation_number}</span>
                    <span className={`w-fit text-[10px] px-1.5 py-0.5 rounded font-medium ${getStatusColor(quo.status)}`}>
                      {getStatusLabel(quo.status)}
                    </span>
                  </div>

                  {/* Client Info */}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{quo.client?.name}</span>
                    {quo.client?.code && (
                      <span className="text-xs text-muted-foreground truncate">{quo.client.code}</span>
                    )}
                  </div>

                  {/* Dates */}
                  <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                    <span className="truncate">{quo.issue_date}</span>
                    {quo.valid_until && <span className="truncate">Valid: {quo.valid_until}</span>}
                  </div>

                  {/* Amount */}
                  <div className="text-right flex flex-col gap-0.5 justify-center">
                    <span className="font-semibold text-sm tabular-nums text-foreground">
                      {formatCurrency(quo.total_amount || 0, quo.currency)}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="w-[236px] flex items-center justify-end gap-2" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setPreviewId(quo.id)}
                      title="Preview, print or download the PDF"
                      aria-label={`Preview ${quo.quotation_number}`}
                      className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    {canEdit && (isQuotationEditable(quo.status) ? (
                      <button
                        onClick={() => openEdit(quo)}
                        title="Edit quotation"
                        aria-label={`Edit ${quo.quotation_number}`}
                        className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    ) : (
                      <span
                        title={quotationLockReason(quo.status) ?? undefined}
                        aria-label={quotationLockReason(quo.status) ?? undefined}
                        className="flex items-center justify-center w-8 h-8 text-muted-foreground/40"
                      >
                        <Lock className="w-3.5 h-3.5" />
                      </span>
                    ))}
                    {quo.status === 'approved' && (
                      <button
                        onClick={() => setConvertConfirm(quo)}
                        disabled={convertingId === quo.id}
                        className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20 disabled:opacity-50 transition-all group/btn"
                        title="Convert to Invoice"
                      >
                        {convertingId === quo.id ? (
                          <span className="w-3.5 h-3.5 border-2 border-emerald-500/40 border-t-emerald-500 rounded-full animate-spin" />
                        ) : (
                          <ArrowRight className="w-4 h-4 group-hover/btn:translate-x-0.5 transition-transform" />
                        )}
                      </button>
                    )}

                    <AppSelect
                      value={quo.status}
                      onChange={e => requestStatus(quo, e.target.value)}
                      className="text-xs py-1.5 rounded-md h-8"
                      wrapperClassName="w-[120px]"
                    >
                      {QUO_STATUSES.map(s => (
                        <option key={s} value={s}>{getStatusLabel(s)}</option>
                      ))}
                    </AppSelect>
                    
                    {isSuperAdmin && (
                      <button
                        title="Edit client in Settings"
                        onClick={() => { if (quo.client?.id) setEditClientId(quo.client.id) }}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-violet-400 transition-all p-1.5 rounded hover:bg-violet-500/10"
                      >
                        <ExternalLink style={{ width: 12, height: 12 }} />
                      </button>
                    )}
                  </div>
                </div>

                {/* ─── MOBILE CARD ─── */}
                <div 
                  className="md:hidden flex flex-col p-4 cursor-pointer"
                  onClick={() => toggleExpanded(quo.id)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex flex-col gap-1 min-w-0 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-foreground truncate">{quo.quotation_number}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${getStatusColor(quo.status)} shrink-0`}>
                          {getStatusLabel(quo.status)}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-foreground truncate">{quo.client?.name}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="font-semibold text-sm tabular-nums text-foreground block">
                        {formatCurrency(quo.total_amount || 0, quo.currency)}
                      </span>
                      <span className="text-xs text-muted-foreground mt-0.5 block">{quo.issue_date}</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between mt-1 pt-3 border-t border-border/40">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {expanded === quo.id ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      {expanded === quo.id ? 'Hide details' : 'View details'}
                    </div>
                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      {canEdit && isQuotationEditable(quo.status) && (
                        <button
                          onClick={() => openEdit(quo)}
                          aria-label={`Edit ${quo.quotation_number}`}
                          className="flex items-center justify-center w-8 h-8 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <AppSelect
                        value={quo.status}
                        onChange={e => requestStatus(quo, e.target.value)}
                        className="text-xs py-1 rounded-md"
                        wrapperClassName="w-[110px]"
                      >
                        {QUO_STATUSES.map(s => (
                          <option key={s} value={s}>{getStatusLabel(s)}</option>
                        ))}
                      </AppSelect>
                    </div>
                  </div>
                </div>

                {/* Expanded items */}
                {expanded === quo.id && (
                  <div className="border-t border-border bg-secondary/10 px-0 md:px-6 py-4 space-y-4 shadow-inner">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 md:px-0">
                      {/* Status workflow */}
                      <div className="bg-card border border-border/50 rounded-xl p-4 flex flex-col justify-center">
                        <StatusWorkflow status={quo.status} />
                      </div>
                      
                      {/* Actions Box */}
                      <div className="flex flex-col justify-center gap-2">
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" size="sm" onClick={() => setPreviewId(quo.id)}>
                            <Eye className="w-3.5 h-3.5" /> Preview / PDF
                          </Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => void copyLink(quo)}>
                            <Link2 className="w-3.5 h-3.5" /> Copy link
                          </Button>
                          {canEdit && isQuotationEditable(quo.status) && (
                            <Button type="button" variant="outline" size="sm" onClick={() => openEdit(quo)}>
                              <Pencil className="w-3.5 h-3.5" /> Edit
                            </Button>
                          )}
                          {canEdit && canDeleteQuotation(quo.status) && (
                            <Button type="button" variant="outline" size="sm" onClick={() => setDeleteConfirm(quo)}
                              className="text-destructive hover:text-destructive">
                              <Trash2 className="w-3.5 h-3.5" /> Delete draft
                            </Button>
                          )}
                        </div>
                        {quotationLockReason(quo.status) && (
                          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <Lock className="w-3.5 h-3.5 mt-px shrink-0" />
                            <span>Read-only. {quotationLockReason(quo.status)}</span>
                          </p>
                        )}
                        {quo.status !== 'approved' && quo.status !== 'rejected' && (
                          <button
                            onClick={() => setApprovalQuote({ id: quo.id, quotation_number: quo.quotation_number })}
                            className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/30 text-sm font-medium transition-colors"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            Request Approval
                          </button>
                        )}
                        {quo.status === 'approved' && (
                          <button
                            onClick={() => setConvertConfirm(quo)}
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
                        )}
                      </div>
                    </div>

                    {quo.items && quo.items.length > 0 && (
                      <div className="mx-4 md:mx-0 overflow-hidden border border-border/50 rounded-xl bg-card">
                        {/* Phones: card list — 4 numeric columns needed horizontal
                            scroll to read at min-w-[500px]. */}
                        <div className="md:hidden divide-y divide-border/30">
                          {quo.items.map((item, i) => (
                            <div key={i} className="px-4 py-3">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="font-medium text-foreground text-sm truncate">{item.description}</span>
                                <span className="shrink-0 font-medium text-foreground text-sm">{formatCurrency(item.total, quo.currency)}</span>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Qty {item.quantity} × {formatCurrency(item.unit_price, quo.currency)}
                              </p>
                            </div>
                          ))}
                        </div>

                        <div className="hidden md:block overflow-x-auto">
                          <table className="w-full text-sm min-w-[500px]">
                            <thead>
                              <tr className="bg-secondary/40 border-b border-border/50">
                                <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-medium uppercase tracking-wider">Service Description</th>
                                <th className="text-center px-4 py-2.5 text-xs text-muted-foreground font-medium uppercase tracking-wider w-24">Qty</th>
                                <th className="text-right px-4 py-2.5 text-xs text-muted-foreground font-medium uppercase tracking-wider w-32">Rate</th>
                                <th className="text-right px-4 py-2.5 text-xs text-muted-foreground font-medium uppercase tracking-wider w-32">Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/30">
                              {quo.items.map((item, i) => (
                                <tr key={i} className="hover:bg-secondary/10 transition-colors">
                                  <td className="px-4 py-3 font-medium text-foreground">{item.description}</td>
                                  <td className="px-4 py-3 text-center text-muted-foreground">{item.quantity}</td>
                                  <td className="px-4 py-3 text-right text-muted-foreground">
                                    {formatCurrency(item.unit_price, quo.currency)}
                                  </td>
                                  <td className="px-4 py-3 text-right font-medium text-foreground">
                                    {formatCurrency(item.total, quo.currency)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    
                    {quo.notes && (
                      <div className="mx-4 md:mx-0 bg-secondary/30 border border-border/50 rounded-lg p-3 text-sm text-muted-foreground whitespace-pre-line">
                        <span className="font-semibold text-foreground text-xs uppercase tracking-wider block mb-1">Notes</span>
                        {quo.notes}
                      </div>
                    )}
                    {quo.terms && (
                      <div className="mx-4 md:mx-0 bg-secondary/30 border border-border/50 rounded-lg p-3 text-sm text-muted-foreground whitespace-pre-line">
                        <span className="font-semibold text-foreground text-xs uppercase tracking-wider block mb-1">Terms</span>
                        {quo.terms}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── New Quotation Modal ───────────────────────────────────────────── */}
      {showForm && (
        <ModalOverlay onClose={closeForm} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90dvh] overflow-y-auto">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
              <h2 className="font-semibold">
                {editing ? <>Edit Quotation <span className="font-mono text-muted-foreground">{editing.quotation_number}</span></> : 'New Quotation'}
              </h2>
              <button
                onClick={closeForm}
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-6">
              {!editing && <DraftRecoveryBanner draft={draft} onRestore={setForm} label="Unsent quotation" />}
              {editing?.status === 'sent' && (
                <p className="text-xs text-muted-foreground bg-secondary/30 border border-border/50 rounded-lg px-3 py-2">
                  Already sent to the client. It keeps the number {editing.quotation_number}; send them the updated PDF after saving.
                </p>
              )}

              {/* Client + Currency row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Client" required>
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
                      className="mt-1.5 text-xs text-violet-400 hover:text-violet-700 dark:text-violet-300 transition-colors"
                    >
                      + New Client
                    </button>
                  ) : (
                    <div className="mt-2 bg-secondary/30 border border-border/50 rounded-xl p-4 space-y-4">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-foreground">Quick-Add Client</span>
                        {newClientSuccess && (
                          <span className="text-xs text-emerald-400 font-medium">Client added!</span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Name" required>
                          <Input
                            value={newClient.name}
                            onChange={e => handleNewClientNameChange(e.target.value)}
                            placeholder="Client name"
                          />
                        </Field>
                        <Field label="Code">
                          <Input
                            value={newClient.code}
                            onChange={e => setNewClient(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                            placeholder="e.g. ABC"
                            maxLength={6}
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Phone">
                          <Input
                            value={newClient.phone}
                            onChange={e => setNewClient(p => ({ ...p, phone: e.target.value }))}
                            placeholder="Phone"
                          />
                        </Field>
                        <Field label="Email">
                          <Input
                            type="email"
                            value={newClient.email}
                            onChange={e => setNewClient(p => ({ ...p, email: e.target.value }))}
                            placeholder="Email"
                          />
                        </Field>
                      </div>
                      <Field label="Currency">
                        <AppSelect
                          value={newClient.default_currency}
                          onChange={e => setNewClient(p => ({ ...p, default_currency: e.target.value as Currency }))}
                        >
                          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </AppSelect>
                      </Field>
                      <div className="flex gap-3 pt-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => { setShowNewClient(false); setNewClient({ name: '', code: '', phone: '', email: '', default_currency: 'INR' }) }}
                          className="flex-1"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          onClick={handleSaveNewClient}
                          disabled={!newClient.name.trim() || newClientSaving}
                          loading={newClientSaving}
                          className="flex-1"
                        >
                          Save Client
                        </Button>
                      </div>
                    </div>
                  )}
                </Field>

                <Field label="Currency">
                  <AppSelect
                    value={form.currency}
                    onChange={e => setForm(p => ({ ...p, currency: e.target.value as Currency }))}
                  >
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </AppSelect>
                </Field>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Issue Date">
                  <Input
                    type="date"
                    value={form.issue_date}
                    onChange={e => setForm(p => ({ ...p, issue_date: e.target.value }))}
                  />
                </Field>
                <Field label="Valid Until">
                  <Input
                    type="date"
                    value={form.valid_until}
                    onChange={e => setForm(p => ({ ...p, valid_until: e.target.value }))}
                  />
                </Field>
              </div>

              {/* Line items */}
              <div className="space-y-3 pt-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Line Items</Label>
                <div className="space-y-3">
                  {form.items.map((item, i) => (
                    <div key={i} className="flex flex-col sm:grid sm:grid-cols-12 gap-3 sm:items-center p-3 sm:p-0 bg-secondary/10 sm:bg-transparent rounded-xl border border-border/50 sm:border-transparent">
                      <div className="sm:col-span-5">
                        <Input
                          placeholder="Description"
                          value={item.description}
                          onChange={e => updateItem(i, 'description', e.target.value)}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Input
                          type="number"
                          min="1"
                          placeholder="Qty"
                          className="sm:text-center"
                          value={item.quantity}
                          onChange={e => updateItem(i, 'quantity', parseFloat(e.target.value) || 1)}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Rate"
                          value={item.unit_price || ''}
                          onChange={e => updateItem(i, 'unit_price', parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div className="sm:col-span-2 text-sm font-medium sm:text-right px-1 tabular-nums mt-1 sm:mt-0">
                        {item.total > 0 ? item.total.toLocaleString('en-IN') : '—'}
                      </div>
                      <div className="sm:col-span-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() => removeItem(i)}
                          disabled={form.items.length === 1 && !item.description && !item.unit_price}
                          aria-label={`Remove line ${i + 1}`}
                          title="Remove line"
                          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                
                <div className="flex items-center justify-between mt-4 p-3 bg-secondary/10 rounded-xl border border-border/50">
                  <button
                    type="button"
                    onClick={() =>
                      setForm(p => ({
                        ...p,
                        items: [...p.items, { description: '', quantity: 1, unit_price: 0, total: 0 }],
                      }))
                    }
                    className="text-xs text-violet-400 hover:text-violet-700 dark:text-violet-300 transition-colors font-medium"
                  >
                    + Add line
                  </button>
                  <div className="text-sm font-semibold tabular-nums text-foreground">
                    Total: {formatCurrency(totalAmount, form.currency)}
                  </div>
                </div>
              </div>

              {/* Notes */}
              <Field label="Notes">
                <Textarea
                  value={form.notes}
                  onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                  rows={2}
                  placeholder="Optional notes for the client…"
                  className="resize-none"
                />
              </Field>

              {/* Terms */}
              <Field label="Terms">
                <Textarea
                  value={form.terms}
                  onChange={e => setForm(p => ({ ...p, terms: e.target.value }))}
                  rows={2}
                  className="resize-none"
                />
              </Field>

              {/* Actions */}
              <div className="pt-4 border-t border-border space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <FormStatus state={submit} />
                  {!editing && <DraftSavedHint draft={draft} />}
                </div>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeForm}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={!canSubmit(submit, !!form.client_id)}
                    loading={submit.status === 'saving'}
                    className="flex-1 gradient-bg text-white"
                  >
                    {editing
                      ? submitLabel(submit, { idle: 'Save Changes', saving: 'Saving…' })
                      : submitLabel(submit, { idle: 'Create Quotation', saving: 'Creating…' })}
                  </Button>
                </div>
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

      {statusConfirm && (
        <ConfirmDialog
          title={statusConfirm.status === 'approved'
            ? `Approve quotation ${statusConfirm.quo.quotation_number}?`
            : `Reject quotation ${statusConfirm.quo.quotation_number}?`}
          body={statusConfirm.status === 'approved'
            ? 'Marks the quote accepted by the client and unlocks "Convert to Invoice". No invoice is created yet.'
            : 'Closes this quote as not going ahead. It stays on record and can be set back to Sent later.'}
          confirmLabel={statusConfirm.status === 'approved' ? 'Approve' : 'Reject'}
          danger={statusConfirm.status === 'rejected'}
          onConfirm={() => { const c = statusConfirm; setStatusConfirm(null); void updateStatus(c.quo.id, c.status) }}
          onCancel={() => setStatusConfirm(null)}
        />
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title={`Delete draft ${deleteConfirm.quotation_number}?`}
          body={`The draft for ${deleteConfirm.client?.name ?? 'this client'} (${formatCurrency(deleteConfirm.total_amount || 0, deleteConfirm.currency)}) and its lines are removed for good. Only drafts can be deleted.`}
          confirmLabel="Delete draft"
          danger
          onConfirm={() => { const q = deleteConfirm; setDeleteConfirm(null); void deleteQuotation(q) }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* ── Client-facing preview (the invoice document, as a quotation) ───── */}
      {previewQuo && (
        <ModalOverlay onClose={() => setPreviewId(null)} zIndex="z-[300]">
          <div className="flex flex-col bg-secondary border border-foreground/15 rounded-2xl shadow-2xl overflow-hidden"
            style={{ width: 'min(860px, 96vw)', height: 'min(92vh, 900px)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-foreground/15 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <Eye className="w-4 h-4 text-violet-400 shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm font-mono truncate">{previewQuo.quotation_number}</h3>
                  <p className="text-[11px] text-muted-foreground truncate">{previewQuo.client?.name}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => void copyLink(previewQuo)}
                  title="Copy a link to this quotation in the app (for your team, not the client)"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15">
                  <Link2 className="w-3.5 h-3.5" />Copy link
                </button>
                <button onClick={() => printQuotation(previewQuo)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15">
                  <Printer className="w-3.5 h-3.5" />Print
                </button>
                <button onClick={() => void downloadQuotationPdf(previewQuo)} disabled={pdfBusy !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15 disabled:opacity-50">
                  {pdfBusy === 'download' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}Download
                </button>
                {canShareFiles() && (
                  <button onClick={() => void shareQuotationPdf(previewQuo)} disabled={pdfBusy !== null}
                    title="Send the PDF through WhatsApp, Mail or any app on this device"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15 disabled:opacity-50">
                    {pdfBusy === 'share' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}Share
                  </button>
                )}
                <button onClick={() => setPreviewId(null)} aria-label="Close preview"
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded-lg transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-[#f5f7fa] rounded-b-2xl" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
              <div style={{ minWidth: 680, height: '100%' }}>
                <iframe
                  key={previewQuo.id}
                  srcDoc={renderQuotationHtml(previewQuo, companySettings)}
                  className="w-full h-full border-0"
                  style={{ minHeight: 600 }}
                  title="Quotation Preview"
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {convertConfirm && (
        <ConfirmDialog
          title={`Create invoice for ${convertConfirm.client?.name ?? 'this client'}?`}
          body={`A draft invoice for ${formatCurrency(convertConfirm.total_amount, convertConfirm.currency)} is created from quotation ${convertConfirm.quotation_number}'s items, and the quotation moves to Converted. You can still edit the draft before sending it.`}
          confirmLabel="Create draft invoice"
          onConfirm={() => { const q = convertConfirm; setConvertConfirm(null); void convertToInvoice(q) }}
          onCancel={() => setConvertConfirm(null)}
        />
      )}
    </div>
  )
}
