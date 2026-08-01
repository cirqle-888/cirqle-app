'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import Combobox from '@/components/ui/combobox'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { FileSignature, Plus, Search, Loader2, Check, X } from 'lucide-react'
import { AGREEMENT_STATUS_CHIP, STATUS_LABEL, STATUSES, RENEWAL_TYPES, type RenewalType } from '@/lib/agreements/types'
import { createAgreement } from './actions'


interface ClientRef { id: string; name: string; code: string }
interface AgreementRow {
  id: string
  agreement_number: string
  title: string
  status: string
  start_date: string
  end_date: string | null
  renewal_type: string
  client?: { id: string; name: string } | null
}

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

type CreateForm = {
  clientId: string
  title: string
  startDate: string
  endDate: string
  renewalType: RenewalType
  notes: string
}

const emptyForm = (): CreateForm => ({
  clientId: '',
  title: '',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  renewalType: 'manual',
  notes: '',
})

export default function AgreementsListClient({
  initialAgreements, clients, canManage, canViewPricing = false, errorMsg,
}: {
  initialAgreements: AgreementRow[]
  clients: ClientRef[]
  canManage: boolean
  canViewPricing?: boolean
  errorMsg: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [clientFilter, setClientFilter] = useState<string>('all')
  const [saving, setSaving] = useState(false)

  // Deep-link from the Client page "Create Agreement" button: ?newClient=<id>
  // preselects that client in the create modal on first render (lazy init, so
  // no effect/lint-disable and it never re-opens after the user closes it).
  const [form, setForm] = useState<CreateForm | null>(() => {
    const newClient = searchParams.get('newClient')
    if (canManage && newClient && clients.some(c => c.id === newClient)) {
      return { ...emptyForm(), clientId: newClient }
    }
    return null
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return initialAgreements.filter(a => {
      if (statusFilter !== 'all' && a.status !== statusFilter) return false
      if (clientFilter !== 'all' && a.client?.id !== clientFilter) return false
      if (!q) return true
      return (
        a.title.toLowerCase().includes(q) ||
        a.agreement_number.toLowerCase().includes(q) ||
        (a.client?.name || '').toLowerCase().includes(q)
      )
    })
  }, [initialAgreements, search, statusFilter, clientFilter])

  async function handleCreate() {
    if (!form) return
    setSaving(true)
    const res = await createAgreement({
      clientId: form.clientId,
      title: form.title,
      startDate: form.startDate,
      endDate: form.endDate || null,
      renewalType: form.renewalType,
      notes: form.notes,
    })
    setSaving(false)
    if (res.ok && res.data) {
      success('Agreement created', 'Add items and deliverables next')
      setForm(null)
      router.push(`/dashboard/agreements/${res.data}`)
    } else {
      toastError('Could not create agreement', res.ok ? undefined : res.error)
    }
  }

  const canSubmit = !!form && !!form.clientId && !!form.title.trim() && !!form.startDate

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-7xl mx-auto w-full">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <FileSignature className="w-6 h-6 text-muted-foreground" />
            Client Agreements
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage long-term commitments, retainers, and package deliverables.
          </p>
        </div>

        {canManage && (
          <button
            onClick={() => setForm(emptyForm())}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Agreement
          </button>
        )}
      </div>

      {/* Toolbar */}
      {!errorMsg && (
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search number, title or client…"
              className={inputCls + ' pl-9'}
            />
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={inputCls + ' sm:w-44'}>
            <option value="all">All statuses</option>
            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select value={clientFilter} onChange={e => setClientFilter(e.target.value)} className={inputCls + ' sm:w-52'}>
            <option value="all">All clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}

      {errorMsg ? (
        <div className="bg-destructive/10 text-destructive text-sm p-4 rounded-md border border-destructive/20">
          {errorMsg}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center border rounded-xl border-dashed bg-muted/30">
          <FileSignature className="w-12 h-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-medium text-foreground">
            {initialAgreements.length === 0 ? 'No agreements found' : 'No matches'}
          </h3>
          <p className="text-muted-foreground mt-2 max-w-sm">
            {initialAgreements.length === 0
              ? "You don't have any client agreements yet. Create one to start tracking retainers and packages."
              : 'Try clearing the search or filters.'}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/50 text-muted-foreground border-b text-xs uppercase">
                <tr>
                  <th className="px-6 py-3 font-medium">Agreement</th>
                  <th className="px-6 py-3 font-medium">Client</th>
                  <th className="px-6 py-3 font-medium">Term</th>
                  <th className="px-6 py-3 font-medium">Renewal</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((agr) => (
                  <tr key={agr.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4">
                      <Link href={`/dashboard/agreements/${agr.id}`} className="font-medium hover:underline">
                        {agr.title}
                      </Link>
                      <div className="text-xs text-muted-foreground mt-1">{agr.agreement_number}</div>
                    </td>
                    <td className="px-6 py-4">{agr.client?.name || 'Unknown'}</td>
                    <td className="px-6 py-4 text-muted-foreground">
                      {agr.start_date} &rarr; {agr.end_date || 'Ongoing'}
                    </td>
                    <td className="px-6 py-4 text-muted-foreground capitalize">{agr.renewal_type}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${AGREEMENT_STATUS_CHIP[agr.status]}`}>
                        {STATUS_LABEL[agr.status] || agr.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/dashboard/agreements/${agr.id}`}
                        className="text-primary hover:underline font-medium text-sm"
                      >
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create modal */}
      {form && (
        <ModalOverlay onClose={() => !saving && setForm(null)} sheetOnMobile>
          <div className="bg-card w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-border shadow-xl p-5 sm:p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <FileSignature className="w-5 h-5 text-muted-foreground" /> New Agreement
              </h2>
              <button onClick={() => setForm(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className={labelCls}>Client</label>
                <Combobox
                  options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                  value={form.clientId}
                  onChange={id => setForm(f => f && ({ ...f, clientId: id }))}
                  placeholder="Search client…"
                  sortKey="clients"
                  required
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Title</label>
                <input
                  value={form.title}
                  onChange={e => setForm(f => f && ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Social Media Management — Retainer"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Start date</label>
                <input type="date" value={form.startDate}
                  onChange={e => setForm(f => f && ({ ...f, startDate: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>End date <span className="text-muted-foreground/60">(optional)</span></label>
                <input type="date" value={form.endDate}
                  onChange={e => setForm(f => f && ({ ...f, endDate: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Renewal</label>
                <select value={form.renewalType}
                  onChange={e => setForm(f => f && ({ ...f, renewalType: e.target.value as RenewalType }))} className={inputCls}>
                  {RENEWAL_TYPES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes <span className="text-muted-foreground/60">(optional)</span></label>
                <input value={form.notes}
                  onChange={e => setForm(f => f && ({ ...f, notes: e.target.value }))}
                  placeholder="Context for this agreement…" className={inputCls} />
              </div>
            </div>

            <p className="text-xs text-muted-foreground mt-3">
              The agreement starts as a <b>Draft</b> — add items and deliverables, then activate it.
            </p>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setForm(null)} disabled={saving}
                className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button onClick={handleCreate} disabled={saving || !canSubmit}
                className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
                {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</> : <><Check className="w-4 h-4" /> Create agreement</>}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
