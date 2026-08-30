'use client'

import { useState } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Building2, Briefcase, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AppSelect from '@/components/ui/app-select'
import {
  quickCreateClient, quickCreateService,
  type QuickClientInput, type QuickServiceInput,
} from '@/app/(dashboard)/dashboard/tasks/quick-create-actions'

const CURRENCIES = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

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

        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="clientName" required>Client name</Label>
            <Input id="clientName" autoFocus value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Sea Star Supermarket" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="clientPhone">Phone</Label>
              <Input id="clientPhone" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} placeholder="+91…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clientCurrency">Currency</Label>
              <AppSelect id="clientCurrency" value={form.default_currency} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </AppSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="clientContact">Contact name</Label>
              <Input id="clientContact" value={form.contact_name} onChange={e => setForm(p => ({ ...p, contact_name: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clientEmail">Email</Label>
              <Input id="clientEmail" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="Optional" />
            </div>
          </div>

          {!canSeePricing && (
            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-300/90">An admin will set this client&apos;s pricing — it&apos;ll be flagged <b>Needs pricing</b> until then.</p>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 pb-5">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={submit} disabled={!form.name.trim()} loading={saving} className="flex-1">
            Add Client
          </Button>
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

        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="serviceName" required>Service name</Label>
            <Input id="serviceName" autoFocus value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Offer Flyer" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="serviceType">Pricing type</Label>
            <AppSelect id="serviceType" value={form.pricing_type} onChange={e => setForm(p => ({ ...p, pricing_type: e.target.value }))}>
              {PRICING_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </AppSelect>
          </div>

          {canSeePricing ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="servicePrice">Default price</Label>
                <Input id="servicePrice" value={form.priceStr} onChange={e => setForm(p => ({ ...p, priceStr: e.target.value }))} placeholder="Optional" inputMode="decimal" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="serviceCurrency">Currency</Label>
                <AppSelect id="serviceCurrency" value={form.default_currency} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </AppSelect>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-300/90">An admin will set this service&apos;s pricing — it&apos;ll be flagged <b>Needs pricing</b> until then.</p>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 pb-5">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={submit} disabled={!form.name.trim()} loading={saving} className="flex-1">
            Add Service
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}
