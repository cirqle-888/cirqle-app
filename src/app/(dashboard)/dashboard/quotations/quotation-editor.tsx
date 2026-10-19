'use client'

/**
 * The quotation page: /dashboard/quotations/new and /dashboard/quotations/[id].
 *
 * One screen to write a quotation and see it as the client will: the form on
 * the left, the branded document (the invoice renderer, printed as a
 * quotation) on the right, updating as you type. Saving, numbering and the
 * edit's write order live in lib/quotations and are tested there.
 *
 * Draft and sent quotations are editable. Approved, rejected and converted
 * ones open read-only with the reason; only a draft can be deleted.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, Download, Link2, Lock,
  Printer, RefreshCw, Share2, Trash2, X,
} from 'lucide-react'
import Header from '@/components/layout/header'
import { RequestApprovalDialog } from '@/components/approvals/request-approval-dialog'
import { createClient } from '@/lib/supabase/client'
import { getStatusColor, getStatusLabel } from '@/lib/utils/invoice'
import { formatCurrency } from '@/lib/calculations/currency'
import type { Currency } from '@/types'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { usePermissions } from '@/contexts/permission-context'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { FormField, FormLabel, FormControl } from '@/components/ui/form'
import { daysFromTodayISO, todayISO } from '@/lib/utils/local-date'
import { useFormDraft } from '@/lib/drafts/use-form-draft'
import {
  IDLE, SAVING, failed, saved as savedState, canSubmit, submitLabel, missingRequired, requiredFieldMessage,
  type SubmitState,
} from '@/lib/forms/submit-state'
import { FormStatus } from '@/components/ui/form-status'
import { DraftRecoveryBanner, DraftSavedHint } from '@/components/ui/draft-recovery'
import { copyToClipboard } from '@/lib/clipboard'
import {
  canDeleteQuotation, normaliseQuotationLines, quotationLink, quotationLockReason,
  quotationToForm, quotationTotal, sortQuotationLines,
} from '@/lib/quotations/editing'
import { createQuotation, deleteDraftQuotation, updateQuotation } from '@/lib/quotations/save'
import { quotationDocument, renderQuotationHtml, type QuotationForRender } from '@/lib/quotations/render'
import {
  QUOTATION_STATUSES, convertQuotationToInvoice, setQuotationStatus, statusNeedsConfirm,
} from '@/lib/quotations/convert'
import { revalidateQuotations } from './actions'
import type { ClientRow, Quotation, QuotationItem } from './types'

const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']
const LIST_HREF = '/dashboard/quotations'
const BLANK_LINE: QuotationItem = { description: '', quantity: 1, unit_price: 0, total: 0 }

/**
 * A blank quotation form. It opens pre-filled (today's date, INR, standard
 * terms, one empty line), so "is there a draft worth keeping?" cannot be
 * answered by asking whether any field is non-empty — see quotationFormStarted.
 */
function emptyQuotationForm() {
  return {
    client_id: '',
    currency: 'INR' as Currency,
    issue_date: todayISO(),
    valid_until: daysFromTodayISO(30),
    notes: '',
    terms: 'Payment due within 7 days of approval.',
    items: [{ ...BLANK_LINE }] as QuotationItem[],
  }
}

type QuotationForm = ReturnType<typeof emptyQuotationForm>

/**
 * Has the user actually started a quotation? The dates are ignored: they are
 * derived from today, so a draft saved yesterday would otherwise always look
 * "edited" when reopened today.
 */
function quotationFormStarted(form: QuotationForm): boolean {
  const blank = emptyQuotationForm()
  if (form.client_id) return true
  if (form.notes.trim()) return true
  if (form.currency !== blank.currency) return true
  if (form.terms.trim() !== blank.terms) return true
  return form.items.some(i => i.description.trim() || i.unit_price > 0 || i.quantity !== 1)
}

function withSortedItems(q: Quotation): Quotation {
  return { ...q, items: sortQuotationLines(q.items) }
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

// A4 at the renderer's page width (800 × 297/210).
const PAGE_W = 800
const PAGE_H = 1131

/** The rendered document, scaled down to fit its column. */
function DocumentPreview({ html }: { html: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.6)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setScale(Math.min(1, entry.contentRect.width / PAGE_W)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={wrapRef} className="w-full overflow-hidden rounded-xl border border-border bg-white shadow-sm"
      style={{ height: Math.round(PAGE_H * scale) }}>
      <iframe
        srcDoc={html}
        title="Quotation preview"
        sandbox="allow-same-origin"
        style={{ width: PAGE_W, height: PAGE_H, border: 0, transform: `scale(${scale})`, transformOrigin: 'top left' }}
      />
    </div>
  )
}

interface Props {
  /** null on /new. */
  quotation: Quotation | null
  clients: ClientRow[]
  companySettings: Record<string, string>
}

export default function QuotationEditor({ quotation, clients: initialClients, companySettings }: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { can, user: permissionUser } = usePermissions()
  const canEdit = can('billing.edit') && !permissionUser.isViewAs

  // `current` is the quotation as saved; `form` is what is on screen.
  const [current, setCurrent] = useState<Quotation | null>(() => (quotation ? withSortedItems(quotation) : null))
  const isNew = !current
  const [form, setForm] = useState<QuotationForm>(() => (quotation ? quotationToForm(withSortedItems(quotation)) : emptyQuotationForm()))
  const [baseline, setBaseline] = useState(() => JSON.stringify(form))
  const dirty = JSON.stringify(form) !== baseline

  const lockReason = current ? quotationLockReason(current.status) : null
  const readOnly = !canEdit || !!lockReason

  const [clients, setClients] = useState<ClientRow[]>(initialClients)
  const [submit, setSubmit] = useState<SubmitState>(IDLE)
  const [toast, setToast] = useState<{ message: string; error?: boolean; invoicesLink?: boolean } | null>(null)
  function showToast(message: string, opts: { error?: boolean; invoicesLink?: boolean } = {}) {
    setToast({ message, ...opts })
    window.setTimeout(() => setToast(null), 4000)
  }

  // Unsent new quotations survive a refresh; an edit starts from the saved
  // quotation, so its unsaved changes are never offered back as a "new" draft.
  const draft = useFormDraft<QuotationForm>('quotation.new', form, {
    enabled: isNew && canEdit,
    isMeaningful: quotationFormStarted,
  })

  // Closing the tab with unsaved changes asks first.
  useEffect(() => {
    if (!dirty || readOnly) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, readOnly])

  const [leaveConfirm, setLeaveConfirm] = useState<string | null>(null)
  function leaveTo(href: string) {
    if (dirty && !readOnly) setLeaveConfirm(href)
    else router.push(href)
  }

  // ── Line items ───────────────────────────────────────────────────────────
  function updateItem(i: number, field: keyof QuotationItem, val: string | number) {
    setForm(prev => {
      const items = [...prev.items]
      items[i] = { ...items[i], [field]: val }
      if (field === 'quantity' || field === 'unit_price') items[i].total = items[i].quantity * items[i].unit_price
      return { ...prev, items }
    })
  }
  function removeItem(i: number) {
    setForm(prev => {
      const items = prev.items.filter((_, idx) => idx !== i)
      return { ...prev, items: items.length ? items : [{ ...BLANK_LINE }] }
    })
  }
  function moveItem(i: number, dir: -1 | 1) {
    setForm(prev => {
      const j = i + dir
      if (j < 0 || j >= prev.items.length) return prev
      const items = [...prev.items]
      ;[items[i], items[j]] = [items[j], items[i]]
      return { ...prev, items }
    })
  }
  const totalAmount = form.items.reduce((s, i) => s + (i.total || 0), 0)

  // ── Quick-add client ─────────────────────────────────────────────────────
  const [showNewClient, setShowNewClient] = useState(false)
  const [newClientSaving, setNewClientSaving] = useState(false)
  const [newClientError, setNewClientError] = useState('')
  const [newClient, setNewClient] = useState({ name: '', code: '', phone: '', email: '', default_currency: 'INR' as Currency })
  function resetNewClient() {
    setShowNewClient(false)
    setNewClientError('')
    setNewClient({ name: '', code: '', phone: '', email: '', default_currency: 'INR' })
  }
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
      .select('id, name, code, phone, email, address')
      .single()
    setNewClientSaving(false)
    if (error || !data) { setNewClientError(error?.message || 'Could not add the client.'); return }
    setClients(prev => [data as ClientRow, ...prev])
    setForm(p => ({ ...p, client_id: data.id }))
    resetNewClient()
  }

  // The page lists active clients only; a quotation for one since
  // deactivated must still show who it is for.
  const clientOptions = clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))
  if (current?.client && !clients.some(c => c.id === current.client!.id)) {
    clientOptions.unshift({ id: current.client.id, label: current.client.name, sub: current.client.code })
  }
  const clientById = (id: string) =>
    clients.find(c => c.id === id) ?? (current?.client?.id === id ? current.client : undefined)

  // ── Save ─────────────────────────────────────────────────────────────────
  const REQUIRED_FIELDS = [
    { key: 'client_id', label: 'Client' },
    { key: 'issue_date', label: 'Issue date' },
  ]

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (readOnly) return
    const missing = requiredFieldMessage(missingRequired(form, REQUIRED_FIELDS))
    if (missing) { setSubmit(failed(missing)); return }
    if (!form.items.some(i => i.description.trim())) {
      setSubmit(failed('Add at least one line with a description.'))
      return
    }

    setSubmit(SAVING)
    const clientCode = clientById(form.client_id)?.code || '001'
    const res = current
      ? await updateQuotation(supabase, current, form, clientCode)
      : await createQuotation(supabase, form, clientCode)
    if (!res.ok) { setSubmit(failed(res.error)); return }

    const saved = withSortedItems(res.value as unknown as Quotation)
    void revalidateQuotations()
    if (!current) {
      draft.clear() // the quotation exists now; the draft would only confuse
      setBaseline(JSON.stringify(form)) // nothing unsaved: leave without asking
      router.replace(`${LIST_HREF}/${saved.id}`)
      return
    }
    const nextForm = quotationToForm(saved)
    setCurrent(saved)
    setForm(nextForm)
    setBaseline(JSON.stringify(nextForm))
    setSubmit(savedState())
  }

  function discardChanges() {
    if (!current) return
    const f = quotationToForm(current)
    setForm(f)
    setSubmit(IDLE)
  }

  // ── Status, approval, convert, delete ────────────────────────────────────
  const [statusConfirm, setStatusConfirm] = useState<string | null>(null)
  const [convertConfirm, setConvertConfirm] = useState(false)
  const [converting, setConverting] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [approvalOpen, setApprovalOpen] = useState(false)

  async function applyStatus(status: string) {
    if (!current) return
    const err = await setQuotationStatus(supabase, current.id, status)
    if (err) { showToast(err, { error: true }); return }
    setCurrent({ ...current, status })
    void revalidateQuotations()
  }
  function requestStatus(status: string) {
    if (statusNeedsConfirm(status)) setStatusConfirm(status)
    else void applyStatus(status)
  }

  async function convert() {
    if (!current) return
    setConverting(true)
    try {
      await convertQuotationToInvoice(supabase, current)
      setCurrent({ ...current, status: 'converted' })
      void revalidateQuotations()
      showToast('Invoice created! Go to Invoices to review.', { invoicesLink: true })
    } catch (err) {
      console.error('Failed to convert quotation to invoice:', err)
      showToast('Failed to create invoice. Please try again.', { error: true })
    } finally {
      setConverting(false)
    }
  }

  async function deleteDraft() {
    if (!current) return
    const res = await deleteDraftQuotation(supabase, current.id)
    if (!res.ok) { showToast(res.error, { error: true }); return }
    await revalidateQuotations()
    router.push(LIST_HREF)
  }

  async function copyLink() {
    if (!current) return
    const ok = await copyToClipboard(quotationLink(window.location.origin, current.id))
    showToast(ok ? `Link to ${current.quotation_number} copied.` : 'Couldn’t copy the link.', { error: !ok })
  }

  // ── Preview, print, PDF, share ───────────────────────────────────────────
  // The preview follows the form, a moment behind typing so the document
  // isn't rebuilt on every keystroke.
  const [previewForm, setPreviewForm] = useState(form)
  useEffect(() => {
    const t = window.setTimeout(() => setPreviewForm(form), 300)
    return () => window.clearTimeout(t)
  }, [form])

  const previewDoc: QuotationForRender = useMemo(() => {
    const lines = normaliseQuotationLines(previewForm.items)
    return {
      quotation_number: current?.quotation_number ?? 'Assigned when saved',
      issue_date: previewForm.issue_date,
      valid_until: previewForm.valid_until || null,
      currency: previewForm.currency,
      total_amount: quotationTotal(lines),
      notes: previewForm.notes,
      terms: previewForm.terms,
      client: clientById(previewForm.client_id) ?? null,
      items: lines,
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- clientById reads `clients`/`current`, listed
  }, [previewForm, current, clients])
  const previewHtml = useMemo(() => renderQuotationHtml(previewDoc, companySettings), [previewDoc, companySettings])

  // Print / Download / Share send the SAVED quotation, so what the client
  // gets always matches the record. With unsaved edits they wait for a save.
  const exportBlocked = !current ? 'Save the quotation first.' : dirty ? 'Save your changes first.' : null
  const [pdfBusy, setPdfBusy] = useState<'download' | 'share' | null>(null)

  function printQuotation() {
    if (!current || exportBlocked) return
    const w = window.open('', '_blank', 'width=800,height=900')
    if (w) { w.document.write(renderQuotationHtml(current, companySettings, { autoprint: true })); w.document.close() }
  }
  async function downloadPdf() {
    if (!current || exportBlocked) return
    setPdfBusy('download')
    try {
      const { downloadInvoicePdf } = await import('@/lib/invoices/download-pdf')
      await downloadInvoicePdf(quotationDocument(current), companySettings, { kind: 'quotation' })
    } catch (e) {
      console.error('Quotation PDF download failed', e)
      showToast('Could not generate the PDF. Try Print instead.', { error: true })
    } finally {
      setPdfBusy(null)
    }
  }
  async function sharePdf() {
    if (!current || exportBlocked) return
    setPdfBusy('share')
    try {
      const { generateInvoicePdf } = await import('@/lib/invoices/download-pdf')
      const pdf = await generateInvoicePdf(quotationDocument(current), companySettings, { kind: 'quotation' })
      const file = new File([pdf.output('blob')], `${current.quotation_number}.pdf`, { type: 'application/pdf' })
      await navigator.share({
        files: [file],
        title: current.quotation_number,
        text: `Quotation ${current.quotation_number} from ${companySettings.company_name || 'Cirqle Works'}`,
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

  const toolButton = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15 disabled:opacity-50 disabled:cursor-not-allowed'

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div>
      <Header
        title={current ? current.quotation_number : 'New Quotation'}
        crumbLabel={current ? current.quotation_number : undefined}
        subtitle={current?.client?.name}
        actions={!readOnly && (
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit(submit, !!form.client_id) || (!!current && !dirty)}
            loading={submit.status === 'saving'}
            className="gradient-bg text-white"
          >
            {current
              ? submitLabel(submit, { idle: 'Save Changes', saving: 'Saving…' })
              : submitLabel(submit, { idle: 'Create Quotation', saving: 'Creating…' })}
          </Button>
        )}
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[400] flex items-center gap-3 bg-card text-foreground border border-foreground/15 rounded-2xl px-5 py-3 shadow-2xl text-sm font-medium animate-in fade-in slide-in-from-bottom-3">
          {toast.error
            ? <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            : <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
          <span>{toast.message}</span>
          {toast.invoicesLink && (
            <Link href="/dashboard/invoices" className="ml-2 flex items-center gap-1 text-violet-400 hover:text-violet-700 dark:text-violet-300 transition-colors">
              View Invoices <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      )}

      {/* ── Toolbar: back, status, sharing ──────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6 pt-4">
        <button type="button" onClick={() => leaveTo(LIST_HREF)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mr-2">
          <ArrowLeft className="w-4 h-4" /> Quotations
        </button>

        {current && (
          <>
            <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${getStatusColor(current.status)}`}>
              {getStatusLabel(current.status)}
            </span>
            {canEdit && (
              <AppSelect
                value={current.status}
                onChange={e => requestStatus(e.target.value)}
                disabled={dirty}
                title={dirty ? 'Save or discard your changes first' : 'Change status'}
                aria-label="Change status"
                className="text-xs py-1.5 rounded-md h-8"
                wrapperClassName="w-[130px]"
              >
                {QUOTATION_STATUSES.map(s => <option key={s} value={s}>{getStatusLabel(s)}</option>)}
              </AppSelect>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {current && current.status !== 'approved' && current.status !== 'rejected' && current.status !== 'converted' && (
            <button type="button" onClick={() => setApprovalOpen(true)} className={toolButton}>
              <CheckCircle2 className="w-3.5 h-3.5" />Request approval
            </button>
          )}
          {current?.status === 'approved' && canEdit && (
            <button type="button" onClick={() => setConvertConfirm(true)} disabled={converting} className={toolButton}>
              {converting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              Convert to invoice
            </button>
          )}
          {current && (
            <button type="button" onClick={() => void copyLink()} className={toolButton}
              title="A link to this quotation in the app, for your team (the client can't open it)">
              <Link2 className="w-3.5 h-3.5" />Copy link
            </button>
          )}
          <button type="button" onClick={printQuotation} disabled={!!exportBlocked} title={exportBlocked ?? undefined} className={toolButton}>
            <Printer className="w-3.5 h-3.5" />Print
          </button>
          <button type="button" onClick={() => void downloadPdf()} disabled={!!exportBlocked || pdfBusy !== null}
            title={exportBlocked ?? undefined} className={toolButton}>
            {pdfBusy === 'download' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}PDF
          </button>
          {current && canShareFiles() && (
            <button type="button" onClick={() => void sharePdf()} disabled={!!exportBlocked || pdfBusy !== null}
              title={exportBlocked ?? 'Send the PDF through WhatsApp, Mail or any app on this device'} className={toolButton}>
              {pdfBusy === 'share' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}Share
            </button>
          )}
          {current && canEdit && canDeleteQuotation(current.status) && (
            <button type="button" onClick={() => setDeleteConfirm(true)}
              className={`${toolButton} text-destructive hover:text-destructive`}>
              <Trash2 className="w-3.5 h-3.5" />Delete draft
            </button>
          )}
        </div>
      </div>

      {(lockReason || !canEdit) && (
        <p className="mx-4 md:mx-6 mt-3 flex items-start gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2 text-sm text-muted-foreground">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Read-only. {lockReason ?? 'Your role can view quotations but not change them.'}
          </span>
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 p-4 md:p-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
        {/* ── Form ─────────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="min-w-0 bg-card border border-border rounded-2xl p-4 md:p-6 space-y-6">
          {isNew && canEdit && <DraftRecoveryBanner draft={draft} onRestore={setForm} label="Unsent quotation" />}
          {current?.status === 'sent' && !readOnly && (
            <p className="text-xs text-muted-foreground bg-secondary/30 border border-border/50 rounded-lg px-3 py-2">
              Already sent to the client. It keeps the number {current.quotation_number}; send them the updated PDF after saving.
            </p>
          )}

          <fieldset disabled={readOnly} className="space-y-6 min-w-0">
            {/* Client + Currency */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Client" required>
                <Combobox
                  sortKey="clients"
                  placeholder="Select client…"
                  options={clientOptions}
                  value={form.client_id}
                  onChange={id => setForm(p => ({ ...p, client_id: id }))}
                  disabled={readOnly}
                  required
                />
                {!readOnly && (!showNewClient ? (
                  <button type="button" onClick={() => setShowNewClient(true)}
                    className="mt-1.5 text-xs text-violet-400 hover:text-violet-700 dark:text-violet-300 transition-colors">
                    + New Client
                  </button>
                ) : (
                  <div className="mt-2 bg-secondary/30 border border-border/50 rounded-xl p-4 space-y-4">
                    <span className="text-xs font-medium text-foreground">Quick-Add Client</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field label="Name" required>
                        <Input value={newClient.name} placeholder="Client name"
                          onChange={e => {
                            const name = e.target.value
                            setNewClient(prev => ({ ...prev, name, code: prev.code || name.slice(0, 3).toUpperCase() }))
                          }} />
                      </Field>
                      <Field label="Code">
                        <Input value={newClient.code} placeholder="e.g. ABC" maxLength={6}
                          onChange={e => setNewClient(p => ({ ...p, code: e.target.value.toUpperCase() }))} />
                      </Field>
                      <Field label="Phone">
                        <Input value={newClient.phone} placeholder="Phone"
                          onChange={e => setNewClient(p => ({ ...p, phone: e.target.value }))} />
                      </Field>
                      <Field label="Email">
                        <Input type="email" value={newClient.email} placeholder="Email"
                          onChange={e => setNewClient(p => ({ ...p, email: e.target.value }))} />
                      </Field>
                    </div>
                    <Field label="Currency">
                      <AppSelect value={newClient.default_currency}
                        onChange={e => setNewClient(p => ({ ...p, default_currency: e.target.value as Currency }))}>
                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </AppSelect>
                    </Field>
                    {newClientError && <p className="text-xs text-destructive">{newClientError}</p>}
                    <div className="flex gap-3">
                      <Button type="button" variant="outline" onClick={resetNewClient} className="flex-1">Cancel</Button>
                      <Button type="button" onClick={handleSaveNewClient} disabled={!newClient.name.trim() || newClientSaving}
                        loading={newClientSaving} className="flex-1">
                        Save Client
                      </Button>
                    </div>
                  </div>
                ))}
              </Field>

              <Field label="Currency">
                <AppSelect value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value as Currency }))}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </AppSelect>
              </Field>
            </div>

            {/* Dates */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Issue Date" required>
                <Input type="date" value={form.issue_date} onChange={e => setForm(p => ({ ...p, issue_date: e.target.value }))} />
              </Field>
              <Field label="Valid Until">
                <Input type="date" value={form.valid_until} onChange={e => setForm(p => ({ ...p, valid_until: e.target.value }))} />
              </Field>
            </div>

            {/* Line items */}
            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Line Items</Label>
              {form.items.map((item, i) => (
                <div key={i} className="rounded-xl border border-border/60 bg-secondary/10 p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-2 w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                    <Textarea
                      rows={1}
                      placeholder="Description"
                      value={item.description}
                      onChange={e => updateItem(i, 'description', e.target.value)}
                      aria-label={`Line ${i + 1} description`}
                      className="resize-y min-h-9 flex-1"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-7">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Qty
                      <Input type="number" min="1" className="w-20 text-center" value={item.quantity}
                        aria-label={`Line ${i + 1} quantity`}
                        onChange={e => updateItem(i, 'quantity', parseFloat(e.target.value) || 1)} />
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Rate
                      <Input type="number" min="0" step="0.01" placeholder="0" className="w-28" value={item.unit_price || ''}
                        aria-label={`Line ${i + 1} rate`}
                        onChange={e => updateItem(i, 'unit_price', parseFloat(e.target.value) || 0)} />
                    </label>
                    <span className="ml-auto text-sm font-semibold tabular-nums text-foreground">
                      {item.total > 0 ? formatCurrency(item.total, form.currency) : '—'}
                    </span>
                    {!readOnly && (
                      <div className="flex gap-0.5">
                        <button type="button" onClick={() => moveItem(i, -1)} disabled={i === 0}
                          aria-label={`Move line ${i + 1} up`} title="Move up"
                          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] disabled:opacity-30 transition-colors">
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" onClick={() => moveItem(i, 1)} disabled={i === form.items.length - 1}
                          aria-label={`Move line ${i + 1} down`} title="Move down"
                          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] disabled:opacity-30 transition-colors">
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" onClick={() => removeItem(i)}
                          disabled={form.items.length === 1 && !item.description && !item.unit_price}
                          aria-label={`Remove line ${i + 1}`} title="Remove line"
                          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between p-3 bg-secondary/10 rounded-xl border border-border/50">
                {!readOnly ? (
                  <button type="button" onClick={() => setForm(p => ({ ...p, items: [...p.items, { ...BLANK_LINE }] }))}
                    className="text-xs text-violet-400 hover:text-violet-700 dark:text-violet-300 transition-colors font-medium">
                    + Add line
                  </button>
                ) : <span />}
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  Total: {formatCurrency(totalAmount, form.currency)}
                </div>
              </div>
            </div>

            <Field label="Notes">
              <Textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                rows={3} placeholder="Optional notes for the client…" className="resize-y" />
            </Field>

            <Field label="Terms">
              <Textarea value={form.terms} onChange={e => setForm(p => ({ ...p, terms: e.target.value }))}
                rows={3} className="resize-y" />
            </Field>
          </fieldset>

          {!readOnly && (
            <div className="pt-4 border-t border-border space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <FormStatus state={submit} />
                {isNew && <DraftSavedHint draft={draft} />}
                {current && dirty && submit.status !== 'saving' && (
                  <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">Unsaved changes</span>
                )}
              </div>
              <div className="flex gap-3">
                <Button type="button" variant="outline" className="flex-1"
                  onClick={() => (current ? discardChanges() : leaveTo(LIST_HREF))}
                  disabled={!!current && !dirty}>
                  {current ? 'Discard changes' : 'Cancel'}
                </Button>
                <Button type="submit" className="flex-1 gradient-bg text-white"
                  disabled={!canSubmit(submit, !!form.client_id) || (!!current && !dirty)}
                  loading={submit.status === 'saving'}>
                  {current
                    ? submitLabel(submit, { idle: 'Save Changes', saving: 'Saving…' })
                    : submitLabel(submit, { idle: 'Create Quotation', saving: 'Creating…' })}
                </Button>
              </div>
            </div>
          )}
        </form>

        {/* ── Client-facing preview ────────────────────────────────────── */}
        <section className="min-w-0 xl:sticky xl:top-4 space-y-2" aria-label="Client preview">
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <span className="uppercase tracking-wider font-semibold">What the client sees</span>
            {exportBlocked && current && <span>Print and PDF use the saved version.</span>}
          </div>
          <DocumentPreview html={previewHtml} />
        </section>
      </div>

      {approvalOpen && current && (
        <RequestApprovalDialog
          defaults={{ entityType: 'quotation', entityId: current.id, title: `Approve quotation ${current.quotation_number}` }}
          onClose={() => setApprovalOpen(false)}
          onCreated={() => setApprovalOpen(false)}
        />
      )}

      {statusConfirm && current && (
        <ConfirmDialog
          title={statusConfirm === 'approved'
            ? `Approve quotation ${current.quotation_number}?`
            : `Reject quotation ${current.quotation_number}?`}
          body={statusConfirm === 'approved'
            ? 'Marks the quote accepted by the client and unlocks "Convert to Invoice". No invoice is created yet. It becomes read-only.'
            : 'Closes this quote as not going ahead. It stays on record, read-only, and can be set back to Sent later.'}
          confirmLabel={statusConfirm === 'approved' ? 'Approve' : 'Reject'}
          danger={statusConfirm === 'rejected'}
          onConfirm={() => { const s = statusConfirm; setStatusConfirm(null); void applyStatus(s) }}
          onCancel={() => setStatusConfirm(null)}
        />
      )}

      {convertConfirm && current && (
        <ConfirmDialog
          title={`Create invoice for ${current.client?.name ?? 'this client'}?`}
          body={`A draft invoice for ${formatCurrency(current.total_amount, current.currency)} is created from quotation ${current.quotation_number}'s items, and the quotation moves to Converted. You can still edit the draft before sending it.`}
          confirmLabel="Create draft invoice"
          onConfirm={() => { setConvertConfirm(false); void convert() }}
          onCancel={() => setConvertConfirm(false)}
        />
      )}

      {deleteConfirm && current && (
        <ConfirmDialog
          title={`Delete draft ${current.quotation_number}?`}
          body={`The draft for ${current.client?.name ?? 'this client'} (${formatCurrency(current.total_amount || 0, current.currency)}) and its lines are removed for good. Only drafts can be deleted.`}
          confirmLabel="Delete draft"
          danger
          onConfirm={() => { setDeleteConfirm(false); void deleteDraft() }}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}

      {leaveConfirm && (
        <ConfirmDialog
          title="Leave without saving?"
          body="Your changes to this quotation haven't been saved and will be lost."
          confirmLabel="Leave"
          danger
          onConfirm={() => { const href = leaveConfirm; setLeaveConfirm(null); setBaseline(JSON.stringify(form)); router.push(href) }}
          onCancel={() => setLeaveConfirm(null)}
        />
      )}
    </div>
  )
}
