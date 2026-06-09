'use client'

import { useState } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Loader2, Building2, Briefcase, AlertTriangle } from 'lucide-react'
import {
  quickCreateClient, quickCreateService,
  type QuickClientInput, type QuickServiceInput,
} from '@/app/(dashboard)/dashboard/tasks/quick-create-actions'

const CURRENCIES = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']
const inputCls =
  'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

// ─── Quick-create CLIENT ────────────────────────────────────────────────────────

export function QuickCreateClientModal({
  initialName = '', canSeePricing, onClose, onCreated,
}: {
  initialName?: string
  canSeePricing: boolean
  onClose: () => void
  onCreated: (client: any, pricingPending: boolean) => void
}) {
  const [form, setForm] = useState<QuickClientInput>({
    name: initialName, phone: '', email: '', contact_name: '', default_currency: 'INR', country: 'India',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!form.name.trim()) { setError('Client name is required.'); return }
    setSaving(true); setError(null)
    const res = await quickCreateClient(form)
    setSaving(false)
    if (res.ok && res.data) onCreated(res.data.client, res.data.pricingPending)
    else setError(res.error || 'Could not create client.')
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><Building2 className="w-4 h-4 text-primary" /></div>
            <p className="font-semibold text-sm">Add Client</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-3.5">
          <div>
            <label className={labelCls}>Client name *</label>
            <input autoFocus value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className={inputCls} placeholder="e.g. Sea Star Supermarket" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Phone</label>
              <input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} className={inputCls} placeholder="+91…" />
            </div>
            <div>
              <label className={labelCls}>Currency</label>
              <select value={form.default_currency} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))} className={inputCls}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Contact name</label>
              <input value={form.contact_name} onChange={e => setForm(p => ({ ...p, contact_name: e.target.value }))} className={inputCls} placeholder="Optional" />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} className={inputCls} placeholder="Optional" />
            </div>
          </div>

          {!canSeePricing && (
            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-300/90">An admin will set this client's pricing — it'll be flagged <b>Needs pricing</b> until then.</p>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 pb-5">
          <button onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors">Cancel</button>
          <button onClick={submit} disabled={saving || !form.name.trim()} className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : 'Add Client'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ─── Quick-create SERVICE ───────────────────────────────────────────────────────

const PRICING_TYPES: { value: string; label: string }[] = [
  { value: 'fixed_per_creative', label: 'Fixed per creative' },
  { value: 'percentage_of_spend', label: '% of spend' },
  { value: 'retainer', label: 'Retainer' },
  { value: 'hourly', label: 'Hourly' },
]

export function QuickCreateServiceModal({
  initialName = '', canSeePricing, onClose, onCreated,
}: {
  initialName?: string
  canSeePricing: boolean
  onClose: () => void
  onCreated: (service: any, pricingPending: boolean) => void
}) {
  const [form, setForm] = useState<QuickServiceInput & { priceStr: string }>({
    name: initialName, pricing_type: 'fixed_per_creative', default_price: null, default_currency: 'INR', priceStr: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!form.name.trim()) { setError('Service name is required.'); return }
    setSaving(true); setError(null)
    const price = form.priceStr.trim() ? parseFloat(form.priceStr) : null
    const res = await quickCreateService({
      name: form.name, pricing_type: form.pricing_type,
      default_price: Number.isFinite(price as number) ? price : null,
      default_currency: form.default_currency,
    })
    setSaving(false)
    if (res.ok && res.data) onCreated(res.data.service, res.data.pricingPending)
    else setError(res.error || 'Could not create service.')
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><Briefcase className="w-4 h-4 text-primary" /></div>
            <p className="font-semibold text-sm">Add Service</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-3.5">
          <div>
            <label className={labelCls}>Service name *</label>
            <input autoFocus value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className={inputCls} placeholder="e.g. Offer Flyer" />
          </div>
          <div>
            <label className={labelCls}>Pricing type</label>
            <select value={form.pricing_type} onChange={e => setForm(p => ({ ...p, pricing_type: e.target.value }))} className={inputCls}>
              {PRICING_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          {canSeePricing ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Default price</label>
                <input value={form.priceStr} onChange={e => setForm(p => ({ ...p, priceStr: e.target.value }))} className={inputCls} placeholder="Optional" inputMode="decimal" />
              </div>
              <div>
                <label className={labelCls}>Currency</label>
                <select value={form.default_currency} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))} className={inputCls}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-300/90">An admin will set this service's pricing — it'll be flagged <b>Needs pricing</b> until then.</p>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 pb-5">
          <button onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors">Cancel</button>
          <button onClick={submit} disabled={saving || !form.name.trim()} className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : 'Add Service'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
