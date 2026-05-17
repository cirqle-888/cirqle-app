'use client'

import { useState, useEffect } from 'react'
import { X, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from './modal-overlay'
import AppSelect from './app-select'
import type { Currency } from '@/types'

interface Props {
  clientId: string
  onClose: () => void
  onSaved?: (client: any) => void
}

const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

const inputCls = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50'

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

export function ClientEditModal({ clientId, onClose, onSaved }: Props) {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Record<string, any>>({})
  const [services, setServices] = useState<any[]>([])
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set())
  const [pricings, setPricings] = useState<Record<string, { price: string; commission_percentage: string; currency: string }>>({})
  const [serviceSearch, setServiceSearch] = useState('')

  useEffect(() => {
    async function load() {
      const [clientRes, servicesRes, pricingRes] = await Promise.all([
        supabase.from('clients').select('*').eq('id', clientId).single(),
        supabase.from('services').select('id, name, is_active').eq('is_active', true).order('name'),
        supabase.from('client_service_pricing').select('*').eq('client_id', clientId),
      ])
      if (clientRes.data) setForm(clientRes.data)
      if (servicesRes.data) setServices(servicesRes.data)
      if (pricingRes.data) {
        const p: Record<string, { price: string; commission_percentage: string; currency: string }> = {}
        const sel = new Set<string>()
        pricingRes.data.forEach((r: any) => {
          p[r.service_id] = { price: String(r.price || ''), commission_percentage: String(r.commission_percentage || ''), currency: r.currency || 'INR' }
          sel.add(r.service_id)
        })
        setPricings(p)
        setSelectedServices(sel)
      }
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const { data: updated } = await supabase.from('clients').update(form).eq('id', clientId).select().single()
    // Save pricing
    const rows = Object.entries(pricings)
      .filter(([, v]) => v.price !== '' || v.commission_percentage !== '')
      .map(([service_id, v]) => ({
        client_id: clientId, service_id,
        price: parseFloat(v.price) || 0,
        commission_percentage: parseFloat(v.commission_percentage) || 0,
        currency: v.currency || 'INR',
        is_active: true,
      }))
    if (rows.length > 0) {
      await supabase.from('client_service_pricing').upsert(rows, { onConflict: 'client_id,service_id' })
    }
    // Remove deselected services
    const allPricedIds = Object.keys(pricings)
    const removed = allPricedIds.filter(id => !selectedServices.has(id))
    if (removed.length > 0) {
      await supabase.from('client_service_pricing').delete().eq('client_id', clientId).in('service_id', removed)
    }
    setSaving(false)
    if (onSaved && updated) onSaved(updated)
    onClose()
  }

  const addService = (id: string) => {
    setSelectedServices(prev => new Set([...prev, id]))
    setPricings(p => ({ ...p, [id]: p[id] || { price: '', commission_percentage: '', currency: form.default_currency || 'INR' } }))
    setServiceSearch('')
  }
  const removeService = (id: string) => {
    setSelectedServices(prev => { const n = new Set(prev); n.delete(id); return n })
    setPricings(p => { const n = { ...p }; delete n[id]; return n })
  }

  const filteredServices = services.filter(s => !selectedServices.has(s.id) && (!serviceSearch || s.name.toLowerCase().includes(serviceSearch.toLowerCase())))
  const selectedServiceList = services.filter(s => selectedServices.has(s.id))

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <h2 className="font-semibold">Edit Client</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading…</div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field label="Client Name" required>
                  <input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} />
                </Field>
              </div>
              <Field label="Code">
                <div className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm font-mono font-bold text-primary">{form.code || '—'}</div>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Email"><input type="email" value={form.email || ''} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} className={inputCls} /></Field>
              <Field label="Phone"><input value={form.phone || ''} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} className={inputCls} /></Field>
            </div>

            <Field label="Address">
              <textarea value={form.address || ''} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} rows={2} className={inputCls + ' resize-none'} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Country"><input value={form.country || ''} onChange={e => setForm(p => ({ ...p, country: e.target.value }))} className={inputCls} placeholder="India" /></Field>
              <Field label="Default Currency">
                <AppSelect value={form.default_currency || 'INR'} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </AppSelect>
              </Field>
            </div>

            {/* Billing Cycle */}
            <div className="border-t border-border pt-4 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Invoice Billing Cycle</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Billing Cycle">
                  <AppSelect value={form.billing_cycle || 'monthly'} onChange={e => setForm(p => ({ ...p, billing_cycle: e.target.value }))}>
                    <option value="monthly">📅 Monthly</option>
                    <option value="weekly">📆 Weekly</option>
                    <option value="daily">🗓️ Daily</option>
                    <option value="none">🚫 Manual Only</option>
                  </AppSelect>
                </Field>
                {(form.billing_cycle === 'monthly' || !form.billing_cycle) && (
                  <Field label="Invoice Day of Month">
                    <input type="number" min="1" max="28" value={form.billing_day || 1} onChange={e => setForm(p => ({ ...p, billing_day: parseInt(e.target.value) || 1 }))} className={inputCls} />
                  </Field>
                )}
                {form.billing_cycle === 'weekly' && (
                  <Field label="Day of Week">
                    <AppSelect value={form.billing_day ?? 1} onChange={e => setForm(p => ({ ...p, billing_day: parseInt(e.target.value) }))}>
                      {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => <option key={i} value={i}>{d}</option>)}
                    </AppSelect>
                  </Field>
                )}
              </div>
            </div>

            {/* Services */}
            {services.length > 0 && (
              <div className="border-t border-border pt-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Services this client uses</p>

                {selectedServiceList.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 p-2.5 bg-secondary/40 rounded-lg border border-border min-h-[36px]">
                    {selectedServiceList.map(svc => (
                      <span key={svc.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs font-medium bg-primary/15 text-primary border border-primary/25">
                        {svc.name}
                        <button type="button" onClick={() => removeService(svc.id)} className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-primary/20 text-primary/70 hover:text-primary">×</button>
                      </span>
                    ))}
                  </div>
                )}

                <div className="relative">
                  <input type="text" value={serviceSearch} onChange={e => setServiceSearch(e.target.value)} placeholder="Search and add services…" className={inputCls + ' pl-8'} />
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  {serviceSearch && filteredServices.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-20 max-h-48 overflow-y-auto">
                      {filteredServices.map(svc => (
                        <button key={svc.id} type="button" onClick={() => addService(svc.id)} className="w-full text-left px-3 py-2 text-sm hover:bg-secondary/60 flex items-center gap-2">
                          <span className="text-primary text-xs">+</span> {svc.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {!serviceSearch && filteredServices.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {filteredServices.slice(0, 8).map(svc => (
                      <button key={svc.id} type="button" onClick={() => addService(svc.id)} className="px-2.5 py-1 rounded-full text-xs text-muted-foreground bg-secondary border border-transparent hover:border-border hover:text-foreground transition-colors">
                        + {svc.name}
                      </button>
                    ))}
                    {filteredServices.length > 8 && <span className="px-2.5 py-1 text-xs text-muted-foreground">+{filteredServices.length - 8} more — use search</span>}
                  </div>
                )}

                {selectedServiceList.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground font-medium">Pricing for selected services</p>
                    {selectedServiceList.map(svc => {
                      const p = pricings[svc.id] || { price: '', commission_percentage: '', currency: form.default_currency || 'INR' }
                      return (
                        <div key={svc.id} className="bg-secondary/40 rounded-lg px-3 py-2.5">
                          <p className="text-xs font-medium mb-2">{svc.name}</p>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">Price</label>
                              <input type="number" min="0" step="0.01" value={p.price} onChange={e => setPricings(prev => ({ ...prev, [svc.id]: { ...prev[svc.id], price: e.target.value } }))} className={inputCls} placeholder="0" />
                            </div>
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">Commission %</label>
                              <input type="number" min="0" max="100" step="0.1" value={p.commission_percentage} onChange={e => setPricings(prev => ({ ...prev, [svc.id]: { ...prev[svc.id], commission_percentage: e.target.value } }))} className={inputCls} placeholder="0" />
                            </div>
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">Currency</label>
                              <AppSelect value={p.currency} onChange={e => setPricings(prev => ({ ...prev, [svc.id]: { ...prev[svc.id], currency: e.target.value } }))}>
                                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                              </AppSelect>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-2 border-t border-border">
              <button type="button" onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
              <button type="submit" disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        )}
      </div>
    </ModalOverlay>
  )
}
