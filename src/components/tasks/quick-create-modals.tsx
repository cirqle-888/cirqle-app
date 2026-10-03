'use client'

import { useState } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Building2, Briefcase, AlertTriangle, FlaskConical, ChevronDown } from 'lucide-react'
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

/**
 * Add a client inline from a planning screen (Tasks, Requests, Social
 * Calendar, Contributions). Two kinds:
 *  - a real client (clients.create / settings.access), and
 *  - a DRAFT (trial) client — a prospect who asked for trial creatives. It can
 *    be planned for, requested for and assigned work, but is never invoiced
 *    until an approver turns it into a real client on the Clients page.
 * `canAddReal = false` (only clients.create_draft) forces the draft kind.
 */
export function QuickCreateClientModal({
  initialName = '', canSeePricing, canAddReal = true, defaultDraft = false, onClose, onCreated,
}: {
  initialName?: string
  canSeePricing: boolean
  /** False when the user holds only clients.create_draft — every add is a draft. */
  canAddReal?: boolean
  /** Start with the draft box ticked (still changeable when canAddReal). */
  defaultDraft?: boolean
  onClose: () => void
  onCreated: (client: any, pricingPending: boolean) => void
}) {
  const [form, setForm] = useState<QuickClientInput>({
    name: initialName, phone: '', email: '', contact_name: '', default_currency: 'INR', country: 'India',
    address: '', gstin: '', as_draft: !canAddReal || defaultDraft, draft_note: '',
  })
  const [showMore, setShowMore] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isDraft = !canAddReal || !!form.as_draft
  const set = (k: keyof QuickClientInput) => (e: { target: { value: string } }) =>
    setForm(p => ({ ...p, [k]: e.target.value }))

  async function submit() {
    if (!form.name.trim()) { setError('Client name is required.'); return }
    setSaving(true); setError(null)
    const res = await quickCreateClient({ ...form, as_draft: isDraft })
    setSaving(false)
    if (res.ok && res.data) onCreated(res.data.client, res.data.pricingPending)
    else setError(res.error || 'Could not create client.')
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDraft ? 'bg-sky-500/10' : 'bg-primary/10'}`}>
              {isDraft ? <FlaskConical className="w-4 h-4 text-sky-500" /> : <Building2 className="w-4 h-4 text-primary" />}
            </div>
            <div>
              <p className="font-semibold text-sm">{isDraft ? 'Add Draft Client' : 'Add Client'}</p>
              {isDraft && <p className="text-[11px] text-muted-foreground">Trial / prospect — plan and assign work now, approve later</p>}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {canAddReal && (
            <label className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5 cursor-pointer">
              <input type="checkbox" className="mt-0.5 accent-sky-500" checked={!!form.as_draft}
                onChange={e => setForm(p => ({ ...p, as_draft: e.target.checked }))} />
              <span className="text-xs">
                <span className="font-medium text-foreground">Draft / trial client</span>
                <span className="block text-muted-foreground mt-0.5">For a prospect who asked for trial work. Not invoiced until approved on the Clients page.</span>
              </span>
            </label>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="clientName" required>Client name</Label>
            <Input id="clientName" autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Sea Star Supermarket" />
          </div>

          {isDraft && (
            <div className="space-y-1.5">
              <Label htmlFor="draftNote">What&apos;s the trial for?</Label>
              <Input id="draftNote" value={form.draft_note} onChange={set('draft_note')} placeholder="e.g. 3 trial posters for Onam offers" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="clientContact">Contact name</Label>
              <Input id="clientContact" value={form.contact_name} onChange={set('contact_name')} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clientPhone">Phone / WhatsApp</Label>
              <Input id="clientPhone" value={form.phone} onChange={set('phone')} placeholder="+91…" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="clientEmail">Email</Label>
              <Input id="clientEmail" value={form.email} onChange={set('email')} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clientCurrency">Currency</Label>
              <AppSelect id="clientCurrency" value={form.default_currency} onChange={set('default_currency')}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </AppSelect>
            </div>
          </div>

          {!showMore ? (
            <button type="button" onClick={() => setShowMore(true)}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <ChevronDown className="w-3.5 h-3.5" /> More details (address, country, GSTIN)
            </button>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="clientAddress">Address</Label>
                <textarea id="clientAddress" rows={2} value={form.address} onChange={set('address')} placeholder="Optional"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary/50 resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="clientCountry">Country</Label>
                  <Input id="clientCountry" value={form.country} onChange={set('country')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="clientGstin">GSTIN / Tax ID</Label>
                  <Input id="clientGstin" value={form.gstin} onChange={set('gstin')} placeholder="Optional" />
                </div>
              </div>
            </>
          )}

          {isDraft ? (
            <div className="flex items-start gap-2 bg-sky-500/10 border border-sky-500/25 rounded-lg px-3 py-2.5">
              <FlaskConical className="w-3.5 h-3.5 text-sky-500 mt-0.5 shrink-0" />
              <p className="text-[11px] text-sky-800 dark:text-sky-200/90">
                Shows as <b>Draft</b> everywhere you pick a client, so you can plan content, raise requests and assign tasks.
                It stays out of invoicing until someone approves it on the Clients page.
              </p>
            </div>
          ) : !canSeePricing && (
            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-300/90">An admin will set this client&apos;s pricing — it&apos;ll be flagged <b>Needs pricing</b> until then.</p>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 pb-5 pt-1 shrink-0">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={submit} disabled={!form.name.trim()} loading={saving} className="flex-1">
            {isDraft ? 'Add Draft Client' : 'Add Client'}
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
