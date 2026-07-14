'use client'

/**
 * New advertising campaign form.
 *
 * Prefills from a Smart Router draft when one was stashed by Quick Capture
 * (sessionStorage 'cirqle:capture:draft'), so "Run Meta ads ₹20k for Acme" lands
 * here with platform/objective/budget already filled. The budget block (incl.
 * the daily-budget × duration auto-calc) is the shared BudgetFields component.
 * Commits through the guarded createAdProject action, then opens the campaign.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Megaphone, Loader2, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { PLATFORMS, CAMPAIGN_TYPES, STATUSES } from '@/lib/advertising/types'
import { createAdProject } from '../actions'
import BudgetFields, { emptyBudget, resolveBudget, type BudgetValue } from '../budget-fields'

interface ServiceRow { id: string; name: string; pricing_type: string | null; default_price: number | null }
interface Props {
  clients: { id: string; name: string; code: string }[]
  services: ServiceRow[]
  servicePricing: { client_id: string; service_id: string; price: number }[]
}

const inrFmt = (v: number) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export default function NewCampaignForm({ clients, services, servicePricing }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [clientId, setClientId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [campaignName, setCampaignName] = useState('')
  const [platform, setPlatform] = useState('meta')
  const [campaignType, setCampaignType] = useState('')
  const [status, setStatus] = useState('draft')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [objective, setObjective] = useState('')
  const [budget, setBudget] = useState<BudgetValue>(emptyBudget())

  // Smart Router prefill.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('cirqle:capture:draft')
      if (!raw) return
      const draft = JSON.parse(raw)
      if (draft?.type !== 'advertising') return
      const f = draft.fields || {}
      if (f.campaignName) setCampaignName(String(f.campaignName))
      if (f.platform) setPlatform(String(f.platform))
      if (f.campaignType) setCampaignType(String(f.campaignType))
      if (f.clientId) setClientId(String(f.clientId))
      if (f.adBudget != null) setBudget(b => ({ ...b, adBudget: String(f.adBudget) }))
      sessionStorage.removeItem('cirqle:capture:draft')
    } catch { /* ignore malformed draft */ }
  }, [])

  // Derive the agency service charge from the selected service's pricing (a
  // client-specific rate wins over the service default). percentage_of_spend →
  // a % of the ad budget; everything else → a fixed amount.
  function deriveServiceCharge(sid: string, cid: string): { type: 'fixed' | 'percent'; value: number; derivedPricing: { serviceName: string; isPercent: boolean; value: number } } | null {
    const svc = services.find(s => s.id === sid)
    if (!svc) return null
    const override = servicePricing.find(p => p.service_id === sid && p.client_id === cid)
    const price = override?.price ?? svc.default_price
    if (price == null) return null
    if (svc.pricing_type === 'percentage_of_spend') {
      return { type: 'percent', value: Number(price), derivedPricing: { serviceName: svc.name, isPercent: true, value: Number(price) } }
    }
    return { type: 'fixed', value: Number(price), derivedPricing: { serviceName: svc.name, isPercent: false, value: Number(price) } }
  }
  const serviceCharge = deriveServiceCharge(serviceId, clientId)

  // When the service or client changes, refresh the auto-derived charge (unless
  // the service has no price set — then drop to manual entry).
  function applyServiceCharge(sid: string, cid: string) {
    const d = deriveServiceCharge(sid, cid)
    if (d) {
      setBudget(b => ({ ...b, scType: d.type, scValue: String(d.value), overrideServiceCharge: false }))
    } else {
      const svc = services.find(s => s.id === sid)
      const t: 'fixed' | 'percent' = svc?.pricing_type === 'percentage_of_spend' ? 'percent' : 'fixed'
      setBudget(b => ({ ...b, scType: t, overrideServiceCharge: true }))
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!campaignName.trim()) { setError('Campaign name is required.'); return }
    setBusy(true); setError(null)
    const { adSpend, days } = resolveBudget(budget, startDate, endDate)
    const res = await createAdProject({
      clientId: clientId || null,
      campaignName,
      platform,
      campaignType: campaignType || null,
      status,
      serviceId: serviceId || null,
      adBudget: adSpend,
      adBudgetCurrency: budget.currency,
      budgetInputMode: budget.mode,
      dailyBudget: budget.mode === 'daily' ? Number(budget.dailyBudget) || 0 : null,
      budgetDays: budget.mode === 'daily' ? days : null,
      serviceChargeType: budget.scType,
      serviceChargeValue: Number(budget.scValue) || 0,
      taxPercent: Number(budget.taxPercent) || 0,
      objective: objective || null,
      startDate: startDate || null,
      endDate: endDate || null,
    })
    setBusy(false)
    if (res.ok && res.data) router.push(`/dashboard/advertising/${res.data.id}`)
    else setError(res.error || 'Could not create the campaign.')
  }

  const field = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-pink-500/40'
  const labelCls = 'block text-xs font-medium text-muted-foreground mb-1'

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">
      <div>
        <Link href="/dashboard/advertising" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Advertising
        </Link>
        <h1 className="text-xl font-semibold flex items-center gap-2 mt-2">
          <Megaphone className="h-5 w-5 text-pink-500" /> New campaign
        </h1>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={submit} className="space-y-5">
        {/* General */}
        <section className="rounded-xl border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold">General</h2>
          <div>
            <label className={labelCls}>Campaign name *</label>
            <input value={campaignName} onChange={e => setCampaignName(e.target.value)} className={field} placeholder="e.g. Diwali Lead-Gen — Meta" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Client</label>
              <select value={clientId} onChange={e => { setClientId(e.target.value); applyServiceCharge(serviceId, e.target.value) }} className={field}>
                <option value="">Internal — Cirqle (company campaign)</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!clientId && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Funded from the company wallet, tracked on the Company P&L, never invoiced.
                </p>
              )}
            </div>
            <div>
              <label className={labelCls}>Platform</label>
              <select value={platform} onChange={e => setPlatform(e.target.value)} className={field}>
                {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Campaign type</label>
              <select value={campaignType} onChange={e => setCampaignType(e.target.value)} className={field}>
                <option value="">— Select —</option>
                {CAMPAIGN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)} className={field}>
                {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Advertising service</label>
              <select value={serviceId} onChange={e => { setServiceId(e.target.value); applyServiceCharge(e.target.value, clientId) }} className={field}>
                <option value="">— Select the service for this client —</option>
                {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Drives the single campaign task&apos;s pricing &amp; contribution parameters (set up work-types like Creative, Media Buying… under Settings → Parameters).
                {serviceCharge && <> The service charge is taken from its pricing automatically.</>}
              </p>
            </div>
          </div>
          <div>
            <label className={labelCls}>Objective / optimization goal</label>
            <input value={objective} onChange={e => setObjective(e.target.value)} className={field} placeholder="e.g. Maximize leads at ≤ ₹120 CPL" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Start date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={field} />
            </div>
            <div>
              <label className={labelCls}>End date</label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className={field} />
            </div>
          </div>
        </section>

        {/* Budget (shared editor — total or daily×duration) */}
        <section className="rounded-xl border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold">Budget</h2>
          <BudgetFields value={budget} onChange={p => setBudget(b => ({ ...b, ...p }))} startDate={startDate} endDate={endDate} derivedPricing={serviceCharge?.derivedPricing ?? null} />
        </section>

        <p className="text-xs text-muted-foreground">
          Creating the campaign adds <strong>one</strong> linked task (the chosen service). The work breakdown — Creative,
          Media Buying, Reporting… — is split via Contributions, configured under Settings → Parameters.
        </p>

        <div className="flex justify-end gap-2">
          <Link href="/dashboard/advertising" className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-secondary">Cancel</Link>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:opacity-90">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}
            Create campaign
          </button>
        </div>
      </form>
    </div>
  )
}
