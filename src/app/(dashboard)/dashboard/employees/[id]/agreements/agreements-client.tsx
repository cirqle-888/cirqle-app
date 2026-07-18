'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Combobox from '@/components/ui/combobox'
import { usePrivacy } from '@/contexts/privacy-context'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  ArrowLeft, Plus, Pencil, Trash2, Loader2, AlertTriangle, Check, X, Handshake, RefreshCw,
} from 'lucide-react'
import {
  saveAgreement, toggleAgreement, deleteAgreement, recomputeAgreementHistory,
  type AgreementInput,
} from '../../agreement-actions'

interface Client { id: string; name: string; code?: string }
interface Service { id: string; name: string }
interface Pricing { client_id: string; service_id: string; price: number | null; currency: string | null }
interface Agreement {
  id: string; employee_id: string; client_id: string | null; service_id: string | null
  agreement_type: 'fixed_per_task' | 'percentage_of_billing' | 'percentage_of_pool'
  agreement_value: number; effective_from: string; effective_to: string | null
  is_active: boolean; notes: string | null
}

const TYPE_LABEL: Record<string, string> = {
  fixed_per_task: 'Fixed per task',
  percentage_of_billing: '% of billing',
  percentage_of_pool: '% of pool',
}
const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

const emptyForm = (employeeId: string): AgreementInput & { id?: string } => ({
  employee_id: employeeId, client_id: null, service_id: null,
  agreement_type: 'fixed_per_task', agreement_value: 0,
  effective_from: new Date().toISOString().slice(0, 10), effective_to: null,
  is_active: true, notes: '',
})

export default function AgreementsClient({
  employee, clients, services, pricing, initialAgreements,
}: {
  employee: { id: string; cqid: string; name: string }
  clients: Client[]; services: Service[]; pricing: Pricing[]; initialAgreements: Agreement[]
}) {
  const router = useRouter()
  const { dn } = usePrivacy()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [rows, setRows] = useState<Agreement[]>(initialAgreements)
  const [form, setForm] = useState<(AgreementInput & { id?: string }) | null>(null)
  const [saving, setSaving] = useState(false)
  const [recomputing, setRecomputing] = useState(false)

  const clientName = useMemo(() => new Map(clients.map(c => [c.id, c.code ? `${c.name} · ${c.code}` : c.name])), [clients])
  const serviceName = useMemo(() => new Map(services.map(s => [s.id, s.name])), [services])
  const priceFor = (clientId: string | null, serviceId: string | null) =>
    (clientId && serviceId) ? (pricing.find(p => p.client_id === clientId && p.service_id === serviceId)?.price ?? null) : null

  // ── Validation warnings for the open form ─────────────────────────────────
  const warnings = useMemo(() => {
    if (!form) return [] as string[]
    const w: string[] = []
    const v = Number(form.agreement_value)
    if (!(v > 0)) w.push('Enter an agreement value greater than 0.')
    if ((form.agreement_type === 'percentage_of_billing' || form.agreement_type === 'percentage_of_pool') && v > 100)
      w.push('Percentage is over 100%.')
    if (form.agreement_type === 'fixed_per_task') {
      const price = priceFor(form.client_id, form.service_id)
      if (price != null && v > price)
        w.push(`Fixed amount ₹${v} exceeds the usual ₹${price} billing for this client + service.`)
    }
    if (form.effective_to && form.effective_from && form.effective_to < form.effective_from)
      w.push('Effective-to date is before the effective-from date.')
    return w
  }, [form, pricing])

  const isBlocking = (w: string[]) => w.some(x => x.startsWith('Enter an agreement') || x.startsWith('Effective-to'))

  async function handleSave() {
    if (!form) return
    if (isBlocking(warnings)) return
    setSaving(true)
    const res = await saveAgreement({ ...form, agreement_value: Number(form.agreement_value) })
    setSaving(false)
    if (res.ok && res.data) {
      setRows(prev => {
        const r = res.data!.row as Agreement
        const i = prev.findIndex(x => x.id === r.id)
        return i >= 0 ? prev.map(x => x.id === r.id ? r : x) : [r, ...prev]
      })
      setForm(null)
      success('Agreement saved', 'Affected tasks recalculated (pending payroll updated)')
      router.refresh()
    } else {
      toastError('Could not save', res.error)
    }
  }

  async function handleToggle(a: Agreement) {
    const res = await toggleAgreement(a.id, !a.is_active)
    if (res.ok) setRows(prev => prev.map(x => x.id === a.id ? { ...x, is_active: !a.is_active } : x))
    else toastError('Toggle failed', res.error)
  }

  async function handleDelete(a: Agreement) {
    if (!confirm('Delete this agreement? Affected tasks will revert to normal contribution earnings.')) return
    const res = await deleteAgreement(a.id)
    if (res.ok) { setRows(prev => prev.filter(x => x.id !== a.id)); success('Agreement deleted') }
    else toastError('Delete failed', res.error)
  }

  async function handleRecompute() {
    setRecomputing(true)
    const res = await recomputeAgreementHistory(employee.id)
    setRecomputing(false)
    if (res.ok) success('History recalculated', `${res.data?.tasks ?? 0} task(s) reprocessed`)
    else toastError('Recalculate failed', res.error)
  }

  const valueSuffix = form?.agreement_type === 'fixed_per_task' ? '₹' : '%'

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
      {/* Header */}
      <Link href="/dashboard/settings" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="w-4 h-4" /> Back to Settings
      </Link>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center"><Handshake className="w-4.5 h-4.5 text-primary" /></div>
          <div>
            <h1 className="text-lg font-bold">Commission Agreements</h1>
            <p className="text-xs text-muted-foreground">{dn(employee)} · {employee.cqid}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRecompute} disabled={recomputing}
            title="Recalculate all historical tasks for this employee (pending payroll only; paid is never changed)"
            className="text-xs px-3 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors flex items-center gap-1.5 disabled:opacity-50">
            {recomputing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Recalculate history
          </button>
          {!form && (
            <button onClick={() => setForm(emptyForm(employee.id))}
              className="text-sm px-3.5 py-2 rounded-lg gradient-bg text-white font-medium hover:opacity-90 transition-opacity flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> Add agreement
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-2 mb-5 leading-relaxed">
        An agreement <b>replaces</b> this employee's normal contribution earning on matching tasks — only when they
        actually contributed (have a score). Everyone else is unaffected. Leave Client or Service as
        <b> All</b> to apply broadly; the most specific agreement wins.
      </p>

      {/* Add / edit form */}
      {form && (
        <div className="bg-card border border-border rounded-2xl p-5 mb-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <p className="font-semibold text-sm">{form.id ? 'Edit agreement' : 'New agreement'}</p>
            <button onClick={() => setForm(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Client */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className={labelCls + ' !mb-0'}>Client</label>
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={form.client_id === null}
                    onChange={e => setForm(f => f && ({ ...f, client_id: e.target.checked ? null : (clients[0]?.id ?? null) }))} />
                  All clients
                </label>
              </div>
              {form.client_id !== null && (
                <Combobox options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                  value={form.client_id} onChange={id => setForm(f => f && ({ ...f, client_id: id || null }))}
                  placeholder="Search client…" sortKey="clients" />
              )}
              {form.client_id === null && <p className="text-xs text-muted-foreground/70 italic">Applies to all clients</p>}
            </div>

            {/* Service */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className={labelCls + ' !mb-0'}>Service</label>
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={form.service_id === null}
                    onChange={e => setForm(f => f && ({ ...f, service_id: e.target.checked ? null : (services[0]?.id ?? null) }))} />
                  All services
                </label>
              </div>
              {form.service_id !== null && (
                <Combobox options={services.map(s => ({ id: s.id, label: s.name }))}
                  value={form.service_id} onChange={id => setForm(f => f && ({ ...f, service_id: id || null }))}
                  placeholder="Search service…" sortKey="services" />
              )}
              {form.service_id === null && <p className="text-xs text-muted-foreground/70 italic">Applies to all services</p>}
            </div>

            {/* Type */}
            <div>
              <label className={labelCls}>Agreement type</label>
              <select value={form.agreement_type} onChange={e => setForm(f => f && ({ ...f, agreement_type: e.target.value as any }))} className={inputCls}>
                <option value="fixed_per_task">Fixed amount per task (₹)</option>
                <option value="percentage_of_billing">Percentage of billing (%)</option>
                <option value="percentage_of_pool">Percentage of commission pool (%)</option>
              </select>
            </div>

            {/* Value */}
            <div>
              <label className={labelCls}>Value ({valueSuffix})</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{valueSuffix}</span>
                <input type="number" min="0" step="any" value={form.agreement_value}
                  onChange={e => setForm(f => f && ({ ...f, agreement_value: parseFloat(e.target.value) || 0 }))}
                  className={inputCls + ' pl-7'} placeholder="0" />
              </div>
            </div>

            {/* Effective from / to */}
            <div>
              <label className={labelCls}>Effective from</label>
              <input type="date" value={form.effective_from} onChange={e => setForm(f => f && ({ ...f, effective_from: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Effective to <span className="text-muted-foreground/60">(optional)</span></label>
              <input type="date" value={form.effective_to || ''} onChange={e => setForm(f => f && ({ ...f, effective_to: e.target.value || null }))} className={inputCls} />
            </div>

            {/* Notes */}
            <div className="sm:col-span-2">
              <label className={labelCls}>Notes <span className="text-muted-foreground/60">(optional)</span></label>
              <input value={form.notes || ''} onChange={e => setForm(f => f && ({ ...f, notes: e.target.value }))} className={inputCls} placeholder="Agreement context…" />
            </div>

            {/* Active */}
            <label className="flex items-center gap-2 text-sm cursor-pointer sm:col-span-2">
              <input type="checkbox" checked={form.is_active ?? true} onChange={e => setForm(f => f && ({ ...f, is_active: e.target.checked }))} />
              Active
            </label>
          </div>

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-300/90">{w}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-3 mt-4">
            <button onClick={() => setForm(null)} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors">Cancel</button>
            <button onClick={handleSave} disabled={saving || isBlocking(warnings)}
              className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
              {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Check className="w-4 h-4" /> Save agreement</>}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {rows.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl px-6 py-12 text-center">
          <Handshake className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No commission agreements for {dn(employee)} yet.</p>
          <p className="text-xs text-muted-foreground/60 mt-1">They earn through the normal contribution system.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(a => {
            const scope = `${a.client_id ? clientName.get(a.client_id) : 'All clients'} · ${a.service_id ? serviceName.get(a.service_id) : 'All services'}`
            const value = a.agreement_type === 'fixed_per_task' ? `₹${a.agreement_value}` : `${a.agreement_value}%`
            return (
              <div key={a.id} className={`bg-card border rounded-xl px-4 py-3 flex items-center gap-3 ${a.is_active ? 'border-border' : 'border-border/50 opacity-60'}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{value}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/12 text-purple-300 border border-purple-500/25">{TYPE_LABEL[a.agreement_type]}</span>
                    {!a.is_active && <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">Inactive</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{scope}</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                    From {a.effective_from}{a.effective_to ? ` to ${a.effective_to}` : ''}{a.notes ? ` · ${a.notes}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => handleToggle(a)} title={a.is_active ? 'Deactivate' : 'Activate'}
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors text-xs px-2">
                    {a.is_active ? 'On' : 'Off'}
                  </button>
                  <button onClick={() => setForm({ ...a, notes: a.notes || '' })} title="Edit"
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => handleDelete(a)} title="Delete"
                    className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
