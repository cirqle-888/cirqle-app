'use client'

import { useState, useEffect } from 'react'
import { X, Search, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from './modal-overlay'
import AppSelect from './app-select'
import type { Currency } from '@/types'

interface Props {
  clientId: string
  serviceId?: string
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

export function ClientEditModal({ clientId, serviceId, onClose, onSaved }: Props) {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Record<string, any>>({})
  const [services, setServices] = useState<any[]>([])

  // Services currently shown in the UI (for editing pricing)
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set())
  // ALL pricing from DB — used to preserve rows we don't show on save
  const [allDbPricings, setAllDbPricings] = useState<Record<string, { price: string; commission_percentage: string; currency: string }>>({})
  // Pricing state for all selected services (including newly added)
  const [pricings, setPricings] = useState<Record<string, { price: string; commission_percentage: string; currency: string }>>({})
  // Services user explicitly removed this session (to delete from DB)
  const [explicitlyRemoved, setExplicitlyRemoved] = useState<Set<string>>(new Set())

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

      const allPricing: Record<string, { price: string; commission_percentage: string; currency: string }> = {}
      if (pricingRes.data) {
        pricingRes.data.forEach((r: any) => {
          allPricing[r.service_id] = {
            price: String(r.price || ''),
            commission_percentage: String(r.commission_percentage || ''),
            currency: r.currency || 'INR',
          }
        })
      }
      setAllDbPricings(allPricing)

      // When opened from a specific task: show only that service
      // When opened without a serviceId (e.g. from settings): show all configured services
      if (serviceId) {
        const sel = new Set([serviceId])
        const shown: Record<string, { price: string; commission_percentage: string; currency: string }> = {
          [serviceId]: allPricing[serviceId] || { price: '', commission_percentage: '', currency: clientRes.data?.default_currency || 'INR' },
        }
        setSelectedServices(sel)
        setPricings(shown)
      } else {
        const sel = new Set(Object.keys(allPricing))
        setSelectedServices(sel)
        setPricings({ ...allPricing })
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

    // Build rows to upsert: selected services (shown + edited) + hidden DB services (unchanged)
    const upsertRows: any[] = []

    // 1. Services shown in UI — save current edited values
    for (const [service_id, v] of Object.entries(pricings)) {
      if (selectedServices.has(service_id) && !explicitlyRemoved.has(service_id)) {
        upsertRows.push({
          client_id: clientId, service_id,
          price: parseFloat(v.price) || 0,
          commission_percentage: parseFloat(v.commission_percentage) || 0,
          currency: v.currency || 'INR',
          is_active: true,
        })
      }
    }

    // 2. Hidden DB services (not shown in this session) — preserve as-is
    if (serviceId) {
      for (const [service_id, v] of Object.entries(allDbPricings)) {
        if (!selectedServices.has(service_id) && !explicitlyRemoved.has(service_id)) {
          upsertRows.push({
            client_id: clientId, service_id,
            price: parseFloat(v.price) || 0,
            commission_percentage: parseFloat(v.commission_percentage) || 0,
            currency: v.currency || 'INR',
            is_active: true,
          })
        }
      }
    }

    if (upsertRows.length > 0) {
      await supabase.from('client_service_pricing').upsert(upsertRows, { onConflict: 'client_id,service_id' })
    }

    // Delete only explicitly removed services
    const toDelete = [...explicitlyRemoved]
    if (!serviceId) {
      // Full edit mode: also delete services that were deselected without explicit remove
      const allShownIds = Object.keys(allDbPricings)
      allShownIds.forEach(id => { if (!selectedServices.has(id)) toDelete.push(id) })
    }
    const uniqueToDelete = [...new Set(toDelete)]
    if (uniqueToDelete.length > 0) {
      await supabase.from('client_service_pricing').delete().eq('client_id', clientId).in('service_id', uniqueToDelete)
    }

    setSaving(false)
    if (onSaved && updated) onSaved(updated)
    onClose()
  }

  const addService = (id: string) => {
    setSelectedServices(prev => new Set([...prev, id]))
    // Use existing DB pricing if available, else blank
    setPricings(p => ({ ...p, [id]: allDbPricings[id] || p[id] || { price: '', commission_percentage: '', currency: form.default_currency || 'INR' } }))
    setExplicitlyRemoved(prev => { const n = new Set(prev); n.delete(id); return n })
    setServiceSearch('')
  }

  const removeService = (id: string) => {
    setSelectedServices(prev => { const n = new Set(prev); n.delete(id); return n })
    setExplicitlyRemoved(prev => new Set([...prev, id]))
  }

  // Services not currently shown
  const unselectedServices = services.filter(s =>
    !selectedServices.has(s.id) &&
    (!serviceSearch || s.name.toLowerCase().includes(serviceSearch.toLowerCase()))
  )
  // Is this service already configured in DB (has existing pricing)?
  const isConfigured = (id: string) => id in allDbPricings
  const selectedServiceList = services.filter(s => selectedServices.has(s.id))

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <div>
            <h2 className="font-semibold">Edit Client</h2>
            {serviceId && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Showing pricing for this task's service
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading…</div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="flex flex-col sm:grid sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <Field label="Client Name" required>
                  <input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} />
                </Field>
              </div>
              <Field label="Code">
                <div className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm font-mono font-bold text-primary">{form.code || '—'}</div>
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Email"><input type="email" value={form.email || ''} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} className={inputCls} /></Field>
              <Field label="Phone"><input value={form.phone || ''} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} className={inputCls} /></Field>
            </div>

            <Field label="Address">
              <textarea value={form.address || ''} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} rows={2} className={inputCls + ' resize-none'} />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

            {/* Service Pricing */}
            {services.length > 0 && (
              <div className="border-t border-border pt-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Service Pricing</p>

                {/* Pricing rows for shown services */}
                {selectedServiceList.length > 0 && (
                  <div className="space-y-2">
                    {selectedServiceList.map(svc => {
                      const p = pricings[svc.id] || { price: '', commission_percentage: '', currency: form.default_currency || 'INR' }
                      return (
                        <div key={svc.id} className="bg-secondary/40 rounded-lg px-3 py-2.5">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-medium">{svc.name}</p>
                            {svc.id !== serviceId && (
                              <button type="button" onClick={() => removeService(svc.id)} className="text-muted-foreground hover:text-red-400 transition-colors text-xs">
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
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

                {/* Add more services */}
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground font-medium">Add more services</p>
                  <div className="relative">
                    <input
                      type="text"
                      value={serviceSearch}
                      onChange={e => setServiceSearch(e.target.value)}
                      placeholder="Search services…"
                      className={inputCls + ' pl-8'}
                    />
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                    {serviceSearch && unselectedServices.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-20 max-h-48 overflow-y-auto">
                        {unselectedServices.map(svc => (
                          <button key={svc.id} type="button" onClick={() => addService(svc.id)}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-secondary/60 flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2">
                              <span className="text-primary text-xs">+</span> {svc.name}
                            </span>
                            {isConfigured(svc.id) && (
                              <span className="text-[10px] text-green-400 flex items-center gap-0.5 shrink-0">
                                <Check className="w-2.5 h-2.5" /> configured
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {!serviceSearch && (
                    <div className="flex flex-wrap gap-1.5">
                      {unselectedServices.slice(0, 8).map(svc => (
                        <button key={svc.id} type="button" onClick={() => addService(svc.id)}
                          className={`px-2.5 py-1 rounded-full text-xs border transition-colors flex items-center gap-1 ${
                            isConfigured(svc.id)
                              ? 'text-green-400 bg-green-500/10 border-green-500/25 hover:bg-green-500/20'
                              : 'text-muted-foreground bg-secondary border-transparent hover:border-border hover:text-foreground'
                          }`}>
                          {isConfigured(svc.id) ? <Check className="w-2.5 h-2.5" /> : '+'} {svc.name}
                        </button>
                      ))}
                      {unselectedServices.length > 8 && (
                        <span className="px-2.5 py-1 text-xs text-muted-foreground">+{unselectedServices.length - 8} more — use search</span>
                      )}
                    </div>
                  )}
                </div>
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
