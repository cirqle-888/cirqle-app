'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, Plus, Save } from 'lucide-react'
import Header from '@/components/layout/header'
import type { Brand } from '@/lib/brands/brands'
import { createBrand, updateBrand, setServiceBrand, type BrandInput } from '../actions'
import { BrandMark } from '../brand-ui'

interface ServiceRow { id: string; name: string; category: string | null; brand_id: string | null }

const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30'
const labelCls = 'block text-[11px] font-medium text-muted-foreground mb-1'

const toInput = (b?: Brand): BrandInput => ({
  name: b?.name ?? '',
  tagline: b?.tagline ?? '',
  color: b?.color ?? '#7c3aed',
  logoUrl: b?.logo_url ?? '',
  whatsappNumber: b?.whatsapp_number ?? '',
  website: b?.website ?? '',
  isActive: b?.is_active ?? true,
  showOnInvoices: b?.show_on_invoices ?? false,
  displayOrder: b?.display_order ?? 0,
})

function BrandForm({ brand, onSaved }: { brand?: Brand; onSaved: () => void }) {
  const [v, setV] = useState<BrandInput>(() => toInput(brand))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (p: Partial<BrandInput>) => setV(prev => ({ ...prev, ...p }))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    const res = brand ? await updateBrand(brand.id, v) : await createBrand(v)
    setBusy(false)
    if (!res.ok) { setMsg({ ok: false, text: res.error ?? 'Could not save.' }); return }
    setMsg({ ok: true, text: 'Saved' })
    if (!brand) setV(toInput())
    onSaved()
  }

  return (
    <form onSubmit={save} id={brand?.slug} className="rounded-xl border border-border bg-card p-4 space-y-3 scroll-mt-20">
      <div className="flex items-center gap-3">
        <BrandMark brand={{ name: v.name || '?', color: v.color ?? null, logo_url: v.logoUrl || null }} size={36} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">{brand ? brand.name : 'New brand'}</p>
          <p className="text-[11px] text-muted-foreground">
            {brand?.is_default ? 'Default brand — unbranded work, accounts and services count here' : brand ? `/${brand.slug}` : 'Add a Cirqle sub-brand'}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`${brand?.id ?? 'new'}-name`}>Name *</label>
          <input id={`${brand?.id ?? 'new'}-name`} value={v.name} onChange={e => set({ name: e.target.value })} className={field} required placeholder="e.g. Memoura" />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${brand?.id ?? 'new'}-tag`}>Tagline</label>
          <input id={`${brand?.id ?? 'new'}-tag`} value={v.tagline ?? ''} onChange={e => set({ tagline: e.target.value })} className={field} placeholder="What it sells, in a line" />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${brand?.id ?? 'new'}-wa`}>WhatsApp number</label>
          <input id={`${brand?.id ?? 'new'}-wa`} value={v.whatsappNumber ?? ''} onChange={e => set({ whatsappNumber: e.target.value })} className={field} placeholder="+91 …" inputMode="tel" />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${brand?.id ?? 'new'}-web`}>Website</label>
          <input id={`${brand?.id ?? 'new'}-web`} value={v.website ?? ''} onChange={e => set({ website: e.target.value })} className={field} placeholder="memoura.gifts" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor={`${brand?.id ?? 'new'}-logo`}>Logo URL</label>
          <input id={`${brand?.id ?? 'new'}-logo`} value={v.logoUrl ?? ''} onChange={e => set({ logoUrl: e.target.value })} className={field} placeholder="https://… (square PNG works best)" />
        </div>
        <div className="flex items-end gap-3">
          <div>
            <label className={labelCls} htmlFor={`${brand?.id ?? 'new'}-color`}>Colour</label>
            <input id={`${brand?.id ?? 'new'}-color`} type="color" value={v.color || '#7c3aed'} onChange={e => set({ color: e.target.value })}
              className="h-9 w-14 rounded border border-border bg-background p-0.5" />
          </div>
          <div className="flex-1">
            <label className={labelCls} htmlFor={`${brand?.id ?? 'new'}-order`}>Order</label>
            <input id={`${brand?.id ?? 'new'}-order`} type="number" value={v.displayOrder ?? 0} onChange={e => set({ displayOrder: Number(e.target.value) || 0 })} className={field} />
          </div>
        </div>
        <div className="flex flex-col justify-end gap-1.5 text-sm">
          {!brand?.is_default && (
            <>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={!!v.isActive} onChange={e => set({ isActive: e.target.checked })} /> Active
              </label>
              <label className="inline-flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={!!v.showOnInvoices} onChange={e => set({ showOnInvoices: e.target.checked })} />
                <span>Show on invoices<span className="block text-[10px] text-muted-foreground">Its name, logo and WhatsApp print on invoices where every line is one of its services. Cirqle stays the seller (name, GST, bank).</span></span>
              </label>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {msg && <span role={msg.ok ? 'status' : 'alert'} className={`text-xs ${msg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{msg.text}</span>}
        <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : brand ? <Save className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {brand ? 'Save' : 'Add brand'}
        </button>
      </div>
    </form>
  )
}

export default function ManageBrandsClient({ brands, services, migrated }: { brands: Brand[]; services: ServiceRow[]; migrated: boolean }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const refresh = () => startTransition(() => router.refresh())
  const [savingSvc, setSavingSvc] = useState<string | null>(null)
  const [svcError, setSvcError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const def = brands.find(b => b.is_default) ?? brands[0]
  const byCategory = useMemo(() => {
    const groups = new Map<string, ServiceRow[]>()
    for (const s of services) {
      if (q && !`${s.name} ${s.category ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue
      const k = s.category ?? 'Uncategorised'
      groups.set(k, [...(groups.get(k) ?? []), s])
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [services, q])

  async function moveService(id: string, brandId: string) {
    setSavingSvc(id); setSvcError(null)
    const res = await setServiceBrand(id, brandId && brandId !== def?.id ? brandId : null)
    setSavingSvc(null)
    if (!res.ok) setSvcError(res.error ?? 'Could not save.')
    else refresh()
  }

  return (
    <>
      <Header title="Manage brands" subtitle="Cirqle's own brands — name, look, contact, and the services each one sells" />
      <div className="p-4 md:p-6 space-y-5 max-w-4xl">
        <Link href="/dashboard/cirqle-accounts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Cirqle Brands
        </Link>

        {!migrated ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            Brands are not set up in the database yet. Apply migration <code>20261122100000_brands</code>.
          </div>
        ) : (
          <>
            <section className="space-y-3" aria-label="Brands">
              {brands.map(b => <BrandForm key={b.id} brand={b} onSaved={refresh} />)}
              <BrandForm onSaved={refresh} />
            </section>

            <section className="rounded-xl border border-border bg-card overflow-hidden" aria-labelledby="svc-heading">
              <div className="px-4 py-3 border-b border-border/60 space-y-2">
                <h2 id="svc-heading" className="text-sm font-semibold">Which brand sells each service</h2>
                <p className="text-[11px] text-muted-foreground">
                  Client work on a service counts as that brand&rsquo;s revenue. Anything left on {def?.name ?? 'the default brand'} stays there.
                </p>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter services…" className={field} aria-label="Filter services" />
                {svcError && <p role="alert" className="text-xs text-red-500">{svcError}</p>}
              </div>
              {byCategory.map(([cat, rows]) => (
                <div key={cat}>
                  <p className="px-4 py-1.5 bg-secondary/40 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{cat}</p>
                  {rows.map(s => (
                    <div key={s.id} className="flex items-center gap-3 px-4 py-2 border-t border-border/60">
                      <p className="text-sm flex-1 min-w-0 truncate">{s.name}</p>
                      <select
                        value={s.brand_id ?? def?.id ?? ''}
                        onChange={e => void moveService(s.id, e.target.value)}
                        disabled={savingSvc === s.id}
                        aria-label={`Brand that sells ${s.name}`}
                        className="rounded-lg border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
                      >
                        {brands.filter(b => b.is_active || b.id === s.brand_id).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                      {savingSvc === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </>
  )
}
