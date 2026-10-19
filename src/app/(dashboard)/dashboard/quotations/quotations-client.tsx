'use client'

/**
 * The Quotations list. Each quotation opens on its own page
 * (/dashboard/quotations/[id], see quotation-editor), where it is edited,
 * previewed and printed; New Quotation opens /dashboard/quotations/new. The
 * row keeps the quick actions that don't need the page: status and
 * Convert to Invoice.
 */
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { getStatusColor, getStatusLabel } from '@/lib/utils/invoice'
import { formatCurrency } from '@/lib/calculations/currency'
import { Plus, ChevronRight, ExternalLink, FileText, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { seedFromTasks } from '@/lib/hooks/use-smart-sort'
import { useRole } from '@/contexts/role-context'
import { usePermissions } from '@/contexts/permission-context'
import { useCreateShortcut } from '@/lib/hooks/use-create-shortcut'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useScrollRestore } from '@/lib/lists/use-scroll-restore'
import { sortQuotationLines } from '@/lib/quotations/editing'
import {
  QUOTATION_STATUSES, convertQuotationToInvoice, setQuotationStatus, statusNeedsConfirm,
} from '@/lib/quotations/convert'
import { revalidateQuotations } from './actions'
import type { Quotation } from './types'

const ClientEditModal = dynamic(() => import('@/components/ui/client-edit-modal').then(mod => mod.ClientEditModal), { ssr: false })

const NEW_HREF = '/dashboard/quotations/new'
const quotationHref = (id: string) => `/dashboard/quotations/${encodeURIComponent(id)}`

interface Props {
  initialQuotations: Quotation[]
}

function withSortedItems(q: Quotation): Quotation {
  return { ...q, items: sortQuotationLines(q.items) }
}

export default function QuotationsClient({ initialQuotations }: Props) {
  // Coming back from a record lands where the list was left, not at the top.
  // See lib/lists/scroll-restore for the rules.
  useScrollRestore('quotations')

  const { role } = useRole()
  const { can, user: permissionUser } = usePermissions()
  const isSuperAdmin = role === 'super_admin'
  const canEdit = can('billing.edit') && !permissionUser.isViewAs
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const supabase = useMemo(() => createClient(), [])

  useCreateShortcut(canEdit, () => router.push(NEW_HREF))

  const [editClientId, setEditClientId] = useState<string | null>(null)
  const [quotations, setQuotations] = useState<Quotation[]>(() => initialQuotations.map(withSortedItems))
  // A save on a quotation page revalidates this route; take the fresh rows
  // when they arrive instead of keeping the ones from the first visit.
  const [prevInitial, setPrevInitial] = useState(initialQuotations)
  if (prevInitial !== initialQuotations) {
    setPrevInitial(initialQuotations)
    setQuotations(initialQuotations.map(withSortedItems))
  }

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
  const [toast, setToast] = useState<{ message: string; error?: boolean; invoicesLink?: boolean } | null>(null)
  function showToast(message: string, opts: { error?: boolean; invoicesLink?: boolean } = {}) {
    setToast({ message, ...opts })
    window.setTimeout(() => setToast(null), 4000)
  }

  // ── Seed smart sort on mount ──────────────────────────────────────────────
  useEffect(() => {
    seedFromTasks(quotations.map(q => ({ clientId: q.client_id, taskDate: q.issue_date })))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Status ───────────────────────────────────────────────────────────────
  // Approving or rejecting is an outcome, not a step: Approved unlocks
  // "Convert to Invoice", Rejected closes the quote. A stray scroll over the
  // row's dropdown used to commit either instantly, so those two confirm.
  const [statusConfirm, setStatusConfirm] = useState<{ quo: Quotation; status: string } | null>(null)

  function requestStatus(quo: Quotation, status: string) {
    if (statusNeedsConfirm(status)) setStatusConfirm({ quo, status })
    else void updateStatus(quo.id, status)
  }

  async function updateStatus(id: string, status: string) {
    const err = await setQuotationStatus(supabase, id, status)
    if (err) { showToast(err, { error: true }); return }
    setQuotations(prev => prev.map(q => (q.id === id ? { ...q, status } : q)))
    void revalidateQuotations()
  }

  // Converting writes a real invoice + line items and moves the quotation to
  // Converted — far too consequential for a bare icon click, so it always
  // routes through this confirmation first.
  const [convertConfirm, setConvertConfirm] = useState<Quotation | null>(null)

  async function convertToInvoice(quo: Quotation) {
    setConvertingId(quo.id)
    try {
      await convertQuotationToInvoice(supabase, quo)
      setQuotations(prev => prev.map(q => (q.id === quo.id ? { ...q, status: 'converted' } : q)))
      void revalidateQuotations()
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

  const newButton = canEdit && (
    <Link
      href={NEW_HREF}
      className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
    >
      <Plus className="w-4 h-4 shrink-0" />
      New Quotation
    </Link>
  )

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div>
      <Header
        title="Quotations"
        subtitle={`${quotations.length} quotation${quotations.length !== 1 ? 's' : ''}`}
        actions={newButton}
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
          <div className="hidden md:grid grid-cols-[1fr_2fr_1fr_1.5fr_auto] gap-4 px-6 py-3 border-b border-border bg-card/80 backdrop-blur-md sticky top-0 z-10 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <div>Quotation</div>
            <div>Client</div>
            <div>Date</div>
            <div className="text-right">Amount</div>
            <div className="w-[200px] text-right">Actions</div>
          </div>

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
              {canEdit && (
                <Link href={NEW_HREF}
                  className="mt-4 flex items-center gap-2 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-xl hover:opacity-90">
                  <Plus className="w-4 h-4" /> New Quotation
                </Link>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 p-4 md:p-0 md:divide-y md:divide-border/50 md:block">
            {filteredQuotations.map(quo => (
              <div key={quo.id} className="group relative flex flex-col bg-card border border-border md:border-none rounded-xl md:rounded-none md:hover:bg-secondary/20 transition-colors">
                {/* The whole row opens the quotation; the controls sit above the link. */}
                <Link href={quotationHref(quo.id)} aria-label={`Open ${quo.quotation_number}`}
                  className="absolute inset-0 z-0 rounded-xl md:rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30" />

                {/* ─── DESKTOP ROW ─── */}
                <div className="hidden md:grid grid-cols-[1fr_2fr_1fr_1.5fr_auto] gap-4 px-6 py-3 items-center pointer-events-none">
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-mono text-sm font-semibold text-foreground truncate">{quo.quotation_number}</span>
                    <span className={`w-fit text-[10px] px-1.5 py-0.5 rounded font-medium ${getStatusColor(quo.status)}`}>
                      {getStatusLabel(quo.status)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{quo.client?.name}</span>
                    {quo.client?.code && <span className="text-xs text-muted-foreground truncate">{quo.client.code}</span>}
                  </div>
                  <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                    <span className="truncate">{quo.issue_date}</span>
                    {quo.valid_until && <span className="truncate">Valid: {quo.valid_until}</span>}
                  </div>
                  <div className="text-right">
                    <span className="font-semibold text-sm tabular-nums text-foreground">
                      {formatCurrency(quo.total_amount || 0, quo.currency)}
                    </span>
                  </div>
                  <div className="w-[200px] flex items-center justify-end gap-2 relative z-10 pointer-events-auto">
                    {quo.status === 'approved' && canEdit && (
                      <button
                        onClick={() => setConvertConfirm(quo)}
                        disabled={convertingId === quo.id}
                        className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20 disabled:opacity-50 transition-all group/btn"
                        title="Convert to Invoice"
                      >
                        {convertingId === quo.id
                          ? <span className="w-3.5 h-3.5 border-2 border-emerald-500/40 border-t-emerald-500 rounded-full animate-spin" />
                          : <ArrowRight className="w-4 h-4 group-hover/btn:translate-x-0.5 transition-transform" />}
                      </button>
                    )}
                    {canEdit && (
                      <AppSelect
                        value={quo.status}
                        onChange={e => requestStatus(quo, e.target.value)}
                        aria-label={`Status of ${quo.quotation_number}`}
                        className="text-xs py-1.5 rounded-md h-8"
                        wrapperClassName="w-[120px]"
                      >
                        {QUOTATION_STATUSES.map(s => <option key={s} value={s}>{getStatusLabel(s)}</option>)}
                      </AppSelect>
                    )}
                    {isSuperAdmin && (
                      <button
                        title="Edit client in Settings"
                        onClick={() => { if (quo.client?.id) setEditClientId(quo.client.id) }}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-violet-400 transition-all p-1.5 rounded hover:bg-violet-500/10"
                      >
                        <ExternalLink style={{ width: 12, height: 12 }} />
                      </button>
                    )}
                    <ChevronRight className="w-4 h-4 text-muted-foreground/50" aria-hidden />
                  </div>
                </div>

                {/* ─── MOBILE CARD ─── */}
                <div className="md:hidden flex flex-col p-4 pointer-events-none">
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
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Open <ChevronRight className="w-3.5 h-3.5" />
                    </span>
                    {canEdit && (
                      <div className="relative z-10 pointer-events-auto">
                        <AppSelect
                          value={quo.status}
                          onChange={e => requestStatus(quo, e.target.value)}
                          aria-label={`Status of ${quo.quotation_number}`}
                          className="text-xs py-1 rounded-md"
                          wrapperClassName="w-[110px]"
                        >
                          {QUOTATION_STATUSES.map(s => <option key={s} value={s}>{getStatusLabel(s)}</option>)}
                        </AppSelect>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {editClientId && (
        <ClientEditModal clientId={editClientId} onClose={() => setEditClientId(null)} />
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
