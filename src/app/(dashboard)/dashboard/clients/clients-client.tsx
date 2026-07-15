'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient as createSupabaseClient } from '@/lib/supabase/client'
import Header from '@/components/layout/header'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import AppSelect from '@/components/ui/app-select'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  Plus, Search, X, Edit2, Archive, ArchiveRestore, ChevronRight,
  Users2, Award, IndianRupee, AlertTriangle, Settings2,
} from 'lucide-react'
import { createClient, updateClient, deactivateClient, reactivateClient } from '@/app/(dashboard)/dashboard/settings/actions'
import type { Currency } from '@/types'

const CURRENCIES: Currency[] = ['AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

interface ClientRow {
  id: string
  name: string
  code: string
  contact_name: string | null
  email: string | null
  phone: string | null
  country: string | null
  default_currency: string | null
  is_active: boolean | null
  pricing_pending: boolean
  business_partner_id: string | null
  created_at: string | null
}

interface ClientStats {
  billed: number; paid: number; outstanding: number
  invoices: number; tasks: number; activeTasks: number; services: number
}

interface Props {
  clients: ClientRow[]
  stats: Record<string, ClientStats>
  services: { id: string; name: string }[]
  showAmounts: boolean
  canCreate: boolean
  canEdit: boolean
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

export default function ClientsClient({ clients: initialClients, stats, showAmounts, canCreate, canEdit }: Props) {
  const router = useRouter()
  const toast = useToast()
  const { ds } = usePrivacy()
  const [clients, setClients] = useState(initialClients)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active')
  const [sort, setSort] = useState<'name' | 'outstanding' | 'tasks'>('name')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState<ClientRow | null>(null)

  const filtered = useMemo(() => {
    let pool = clients
    if (filter === 'active')   pool = pool.filter(c => c.is_active !== false)
    if (filter === 'archived') pool = pool.filter(c => c.is_active === false)
    if (search) {
      const q = search.toLowerCase()
      pool = pool.filter(c =>
        c.name?.toLowerCase().includes(q) || c.code?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) || c.contact_name?.toLowerCase().includes(q))
    }
    return [...pool].sort((a, b) => {
      if (sort === 'outstanding') return (stats[b.id]?.outstanding || 0) - (stats[a.id]?.outstanding || 0)
      if (sort === 'tasks')       return (stats[b.id]?.tasks || 0) - (stats[a.id]?.tasks || 0)
      return (a.name || '').localeCompare(b.name || '')
    })
  }, [clients, search, filter, sort, stats])

  // Portfolio totals for the KPI strip (active clients only).
  const totals = useMemo(() => {
    const active = clients.filter(c => c.is_active !== false)
    let outstanding = 0, pendingPricing = 0
    for (const c of active) {
      outstanding += stats[c.id]?.outstanding || 0
      if (c.pricing_pending) pendingPricing += 1
    }
    return { count: active.length, outstanding, pendingPricing }
  }, [clients, stats])

  async function openForm(client?: ClientRow) {
    setEditingId(client?.id ?? null)
    if (client) {
      setForm({ ...client })
    } else {
      // Auto-suggest the next client code, same scheme the Settings form uses.
      let code = ''
      try {
        const supabase = createSupabaseClient()
        const { data } = await supabase.from('clients').select('code').order('code', { ascending: false }).limit(1)
        code = String((parseInt(data?.[0]?.code || '0') || 0) + 1).padStart(3, '0')
      } catch { /* offline — leave blank */ }
      setForm({ is_active: true, code, country: 'India', default_currency: 'INR' })
    }
    setShowForm(true)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const res = editingId ? await updateClient(editingId, form) : await createClient(form)
    setSaving(false)
    if (!res.ok) { toast.error('Failed to save client', res.error); return }
    if (editingId) {
      setClients(prev => prev.map(c => c.id === editingId ? { ...c, ...res.data } : c))
      toast.success('Client updated')
    } else if (res.data) {
      setClients(prev => [...prev, res.data])
      toast.success('Client created', `${res.data.name} · code ${res.data.code}`)
    }
    setShowForm(false)
  }

  async function archive(client: ClientRow) {
    const res = await deactivateClient(client.id)
    if (!res.ok) { toast.error('Failed to archive', res.error); return }
    setClients(prev => prev.map(c => c.id === client.id ? { ...c, is_active: false } : c))
    toast.success('Client archived', 'Find it under the Archived filter to restore.')
  }

  async function restore(client: ClientRow) {
    const res = await reactivateClient(client.id)
    if (!res.ok) { toast.error('Failed to restore', res.error); return }
    setClients(prev => prev.map(c => c.id === client.id ? { ...c, is_active: true } : c))
    toast.success('Client restored')
  }

  const inputCls = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground'

  return (
    <>
      <Header
        title="Clients"
        subtitle={`${totals.count} active client${totals.count === 1 ? '' : 's'}`}
        actions={
          <>
            <Link href="/dashboard/clients/ranking"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
              <Award className="w-4 h-4" /> Ranking
            </Link>
            {canEdit && (
              <Link href="/dashboard/settings?tab=pricing-matrix"
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                <Settings2 className="w-4 h-4" /> Pricing Matrix
              </Link>
            )}
            {canCreate && (
              <button onClick={() => openForm()}
                className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                <Plus className="w-4 h-4" /> Add Client
              </button>
            )}
          </>
        }
      />

      <div className="p-4 md:p-6 space-y-4">
        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="bg-card border border-border rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><Users2 className="w-3.5 h-3.5" /> Active clients</div>
            <p className="text-xl font-bold">{totals.count}</p>
          </div>
          {showAmounts && (
            <div className="bg-card border border-border rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><IndianRupee className="w-3.5 h-3.5" /> Total outstanding</div>
              <p className={`text-xl font-bold ${totals.outstanding > 0 ? 'text-amber-400' : ''}`}>{inr(totals.outstanding)}</p>
            </div>
          )}
          <div className="bg-card border border-border rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><AlertTriangle className="w-3.5 h-3.5" /> Needs pricing</div>
            <p className={`text-xl font-bold ${totals.pendingPricing > 0 ? 'text-amber-400' : ''}`}>{totals.pendingPricing}</p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-secondary/30 border border-border/50 rounded-lg p-0.5 shrink-0">
            {(['active', 'archived', 'all'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-[13px] font-medium rounded-md transition-all ${
                  filter === f ? 'bg-background text-foreground shadow-sm ring-1 ring-border/50' : 'text-muted-foreground hover:text-foreground'
                }`}>
                {f === 'active' ? 'Active' : f === 'archived' ? 'Archived' : 'All'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 bg-secondary border border-border/0 hover:border-border rounded-lg px-2.5 py-1.5 flex-1 min-w-[180px] focus-within:border-primary/50 transition-colors">
            <Search className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, code, email…"
              className="bg-transparent text-sm outline-none flex-1 placeholder:text-muted-foreground/40" />
            {search && <button onClick={() => setSearch('')} className="text-muted-foreground/50 hover:text-foreground"><X className="w-3 h-3" /></button>}
          </div>
          <AppSelect value={sort} onChange={e => setSort(e.target.value as any)} className="w-40 shrink-0">
            <option value="name">Sort: Name</option>
            {showAmounts && <option value="outstanding">Sort: Outstanding</option>}
            <option value="tasks">Sort: Most tasks</option>
          </AppSelect>
        </div>

        {/* List */}
        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-14 border border-dashed border-border/60 rounded-2xl bg-secondary/10">
              <Users2 className="w-8 h-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-medium">No clients found</p>
              <p className="text-xs text-muted-foreground mt-1">
                {search ? 'Try a different search.' : filter === 'archived' ? 'No archived clients.' : 'Add your first client to get started.'}
              </p>
            </div>
          )}
          {filtered.map(client => {
            const s = stats[client.id]
            return (
              <div key={client.id}
                className="group bg-card border border-border/60 rounded-2xl px-4 md:px-5 py-3.5 flex items-center gap-3 hover:border-primary/25 hover:shadow-sm transition-all cursor-pointer"
                onClick={() => router.push(`/dashboard/clients/${client.id}`)}>
                {/* Identity */}
                <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {client.code || client.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-sm truncate">{client.name}</p>
                    {client.pricing_pending && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25 shrink-0">Needs pricing</span>
                    )}
                    {client.is_active === false && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">Archived</span>
                    )}
                    {client.business_partner_id && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">Partner-referred</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {[client.contact_name, ds(client.email, '••••@••••'), client.country].filter(Boolean).join(' · ') || '—'}
                  </p>
                </div>
                {/* Stats */}
                <div className="hidden sm:flex items-center gap-5 shrink-0 text-right">
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Tasks</p>
                    <p className="text-sm font-semibold">{s?.tasks || 0}{(s?.activeTasks || 0) > 0 && <span className="text-blue-400 text-xs font-medium ml-1">({s!.activeTasks} open)</span>}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Services</p>
                    <p className="text-sm font-semibold">{s?.services || 0}</p>
                  </div>
                  {showAmounts && (
                    <div className="w-24">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Outstanding</p>
                      <p className={`text-sm font-semibold ${(s?.outstanding || 0) > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>{inr(s?.outstanding || 0)}</p>
                    </div>
                  )}
                </div>
                {/* Row actions */}
                <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                  {canEdit && (
                    <button onClick={() => openForm(client)} title="Edit client"
                      className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                      <Edit2 className="w-4 h-4" />
                    </button>
                  )}
                  {canEdit && (client.is_active === false ? (
                    <button onClick={() => restore(client)} title="Restore client"
                      className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity">
                      <ArchiveRestore className="w-4 h-4" />
                    </button>
                  ) : (
                    <button onClick={() => setConfirmArchive(client)} title="Archive client"
                      className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Archive className="w-4 h-4" />
                    </button>
                  ))}
                  <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Add / Edit modal — essential fields; service pricing lives on the
          detail page + Pricing Matrix, so the form stays quick. */}
      {showForm && (
        <ModalOverlay onClose={() => setShowForm(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl">
              <h2 className="font-semibold">{editingId ? 'Edit' : 'Add'} Client</h2>
              <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={save} className="p-6 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Client Name *</label>
                  <input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Code</label>
                  <div className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm font-mono font-bold text-primary">{form.code || '—'}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Contact Person</label>
                  <input value={form.contact_name || ''} onChange={e => setForm(p => ({ ...p, contact_name: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Phone</label>
                  <input value={form.phone || ''} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} className={inputCls} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Email</label>
                <input type="email" value={form.email || ''} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Address</label>
                <textarea value={form.address || ''} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} rows={2} className={inputCls + ' resize-none'} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Country</label>
                  <input value={form.country || ''} onChange={e => setForm(p => ({ ...p, country: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Currency</label>
                  <AppSelect value={form.default_currency || 'INR'} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))}>
                    <option value="INR">INR</option>
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </AppSelect>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">GSTIN</label>
                  <input value={form.gstin || ''} onChange={e => setForm(p => ({ ...p, gstin: e.target.value }))} className={inputCls} placeholder="Optional" />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Service pricing for this client is managed on their dashboard and in Settings → Pricing Matrix.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="gradient-bg text-white text-sm font-medium px-5 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
                  {saving ? 'Saving…' : 'Save Client'}
                </button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {/* Archive confirm */}
      {confirmArchive && (
        <ModalOverlay onClose={() => setConfirmArchive(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl p-6">
            <h2 className="font-semibold mb-1.5">Archive {confirmArchive.name}?</h2>
            <p className="text-sm text-muted-foreground mb-5">
              The client is hidden from lists and forms but nothing is deleted — tasks and invoices keep their history, and you can restore any time from the Archived filter.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmArchive(null)} className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">Cancel</button>
              <button onClick={() => { archive(confirmArchive); setConfirmArchive(null) }}
                className="px-4 py-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 text-sm font-medium hover:bg-amber-500/25 transition-colors">
                Archive
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}
