'use client'

/**
 * Shop — the interactive client. Reads arrive as plain props from the server
 * page; every write goes through actions.ts. Nothing here talks to Supabase.
 */

import { useState } from 'react'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { Store, Plus, X, Pencil, Trash2, Loader2, ArrowUp, ArrowDown } from 'lucide-react'
import {
  EXTRA_KEYS, EXTRA_LABEL, OCC_OPTIONS, WHO_OPTIONS, bannerState,
  type ExtraKey, type ShopBanner, type ShopProduct, type ShopSettings, type ShopSpot,
} from '@/lib/shop/catalogue'
import {
  deleteBanner, deleteProduct, saveBanner, saveProduct, saveSettings, setBannerActive, setProductActive, swapProductOrder,
  type BannerInput, type ProductInput,
} from './actions'

type Tab = 'gifts' | 'banners' | 'prices' | 'highlights'
const TABS: { key: Tab; label: string }[] = [
  { key: 'gifts', label: 'Gifts' },
  { key: 'banners', label: 'Banners' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'prices', label: 'Prices and delivery' },
]
const INPUT = 'w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'
const AREA = 'w-full px-3 py-2 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'
const rupees = (n: number) => '₹' + n.toLocaleString('en-IN')
const niceDay = (d: string | null) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

const BANNER_TONE: Record<ReturnType<typeof bannerState>, { label: string; cls: string }> = {
  live: { label: 'Showing now', cls: 'bg-green-500/15 text-green-500' },
  scheduled: { label: 'Scheduled', cls: 'bg-blue-500/15 text-blue-400' },
  ended: { label: 'Ended', cls: 'bg-secondary text-muted-foreground' },
  off: { label: 'Off', cls: 'bg-secondary text-muted-foreground' },
}

export default function ShopClient({
  products: initialProducts, banners: initialBanners, settings: initialSettings, canManage, notSetUp, today,
}: {
  products: ShopProduct[]
  banners: ShopBanner[]
  settings: ShopSettings
  canManage: boolean
  notSetUp: boolean
  today: string
}) {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('gifts')
  const [products, setProducts] = useState<ShopProduct[]>(initialProducts)
  const [banners, setBanners] = useState<ShopBanner[]>(initialBanners)
  const [settings, setSettings] = useState<ShopSettings>(initialSettings)
  const [editGift, setEditGift] = useState<ShopProduct | 'new' | null>(null)
  const [editBanner, setEditBanner] = useState<ShopBanner | 'new' | null>(null)
  const [removeGift, setRemoveGift] = useState<ShopProduct | null>(null)
  const [removeBanner, setRemoveBanner] = useState<ShopBanner | null>(null)

  const sorted = [...products].sort((a, b) => a.sort - b.sort)
  const onCount = products.filter(p => p.active).length
  // The site shows the first banner whose dates include today.
  const showing = [...banners].sort((a, b) => a.sort - b.sort).find(b => bannerState(b, today) === 'live') ?? null

  async function toggleGift(p: ShopProduct) {
    const next = !p.active
    setProducts(prev => prev.map(x => (x.id === p.id ? { ...x, active: next } : x)))
    const res = await setProductActive(p.id, next)
    if (!res.ok) {
      setProducts(prev => prev.map(x => (x.id === p.id ? { ...x, active: p.active } : x)))
      toast.error('Could not change it', res.error)
    } else toast.success(next ? `${p.name} is on the website` : `${p.name} is hidden`)
  }

  async function moveGift(p: ShopProduct, dir: -1 | 1) {
    const i = sorted.findIndex(x => x.id === p.id), other = sorted[i + dir]
    if (!other) return
    setProducts(prev => prev.map(x => (x.id === p.id ? { ...x, sort: other.sort } : x.id === other.id ? { ...x, sort: p.sort } : x)))
    const res = await swapProductOrder(p.id, other.id)
    if (!res.ok) { toast.error('Could not move it', res.error); window.location.reload() }
  }

  async function toggleBanner(b: ShopBanner) {
    const next = !b.active
    setBanners(prev => prev.map(x => (x.id === b.id ? { ...x, active: next } : x)))
    const res = await setBannerActive(b.id, next)
    if (!res.ok) {
      setBanners(prev => prev.map(x => (x.id === b.id ? { ...x, active: b.active } : x)))
      toast.error('Could not change it', res.error)
    }
  }

  async function storeSettings(next: ShopSettings, done: string): Promise<boolean> {
    const res = await saveSettings(next)
    if (!res.ok || !res.data) { toast.error('Could not save', res.error); return false }
    setSettings(res.data)
    toast.success(done)
    return true
  }

  return (
    <>
      <Header
        title="Shop Settings"
        subtitle="What the Memoura website sells and announces"
        actions={canManage && !notSetUp && (tab === 'gifts' || tab === 'banners') ? (
          <Button size="sm" onClick={() => (tab === 'gifts' ? setEditGift('new') : setEditBanner('new'))}>
            <Plus className="w-4 h-4 mr-1.5" /> {tab === 'gifts' ? 'Add gift' : 'Add banner'}
          </Button>
        ) : undefined}
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1100px] mx-auto w-full">
        {notSetUp ? (
          <Card><CardContent className="p-0">
            <EmptyState icon={Store} title="The shop is not switched on yet" body="The shop tables have not been created in the database. Ask the admin to run the shop catalogue migration." />
          </CardContent></Card>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-3" role="tablist" aria-label="Shop sections">
              {TABS.map(t => (
                <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                  className={`px-3 h-8 rounded-lg text-sm font-medium ${tab === t.key ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mb-4">Changes show on the website within about a minute.</p>

            {tab === 'gifts' && (
              products.length === 0 ? (
                <Card><CardContent className="p-0">
                  <EmptyState icon={Store} title="No gifts yet" body="Add the first gift the website should sell."
                    action={canManage ? { label: 'Add gift', onClick: () => setEditGift('new') } : undefined} />
                </CardContent></Card>
              ) : (
                <>
                  <div className="text-xs text-muted-foreground mb-2">{onCount} of {products.length} on the website</div>
                  <Card><CardContent className="p-0 divide-y divide-border/60">
                    {sorted.map((p, i) => (
                      <div key={p.id} className={`flex items-center gap-3 px-3 py-2.5 ${p.active ? '' : 'opacity-60'}`}>
                        <Switch checked={p.active} disabled={!canManage} label={`${p.name} on the website`} onChange={() => toggleGift(p)} />
                        <button type="button" disabled={!canManage} onClick={() => setEditGift(p)} className="flex-1 min-w-0 text-left">
                          <div className="text-sm font-medium text-foreground truncate">
                            {p.name}
                            {p.badge && <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium bg-violet-500/15 text-violet-400">{p.badge}</span>}
                            {p.ready && <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium bg-teal-500/15 text-teal-400">Ready-made</span>}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{p.meta || 'No short line'}{p.active ? '' : ' · hidden'}</div>
                        </button>
                        <span className="text-sm tabular-nums">{rupees(p.price)}</span>
                        {canManage && (
                          <span className="flex items-center gap-0.5 text-muted-foreground">
                            <button type="button" aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => moveGift(p, -1)} className="w-7 h-7 grid place-items-center rounded hover:bg-secondary disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                            <button type="button" aria-label={`Move ${p.name} down`} disabled={i === sorted.length - 1} onClick={() => moveGift(p, 1)} className="w-7 h-7 grid place-items-center rounded hover:bg-secondary disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
                            <button type="button" aria-label={`Edit ${p.name}`} onClick={() => setEditGift(p)} className="w-7 h-7 grid place-items-center rounded hover:bg-secondary"><Pencil className="w-4 h-4" /></button>
                          </span>
                        )}
                      </div>
                    ))}
                  </CardContent></Card>
                </>
              )
            )}

            {tab === 'banners' && (
              <>
                <Card className="mb-3"><CardContent className="p-3">
                  <div className="text-xs text-muted-foreground mb-1.5">On the website today</div>
                  {showing ? (
                    <div className="rounded-lg px-3 py-2 text-sm text-center bg-emerald-200 text-slate-900">
                      {showing.title && <b>{showing.title}{/^[,.:;!?]/.test(showing.body) ? '' : ' '}</b>}{showing.body}
                    </div>
                  ) : <div className="text-sm text-muted-foreground">No banner is showing. The strip is hidden.</div>}
                </CardContent></Card>
                {banners.length === 0 ? (
                  <Card><CardContent className="p-0">
                    <EmptyState icon={Store} title="No banners yet" body="A banner is the strip at the very top of the website: an offer, a new gift, or a festival greeting."
                      action={canManage ? { label: 'Add banner', onClick: () => setEditBanner('new') } : undefined} />
                  </CardContent></Card>
                ) : (
                  <Card><CardContent className="p-0 divide-y divide-border/60">
                    {[...banners].sort((a, b) => a.sort - b.sort).map(b => {
                      const tone = BANNER_TONE[bannerState(b, today)]
                      return (
                        <div key={b.id} className="flex items-center gap-3 px-3 py-2.5">
                          <Switch checked={b.active} disabled={!canManage} label="Banner on" onChange={() => toggleBanner(b)} />
                          <button type="button" disabled={!canManage} onClick={() => setEditBanner(b)} className="flex-1 min-w-0 text-left">
                            <div className="text-sm text-foreground truncate">{b.title && <b>{b.title} </b>}{b.body}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {b.starts_on || b.ends_on ? `${niceDay(b.starts_on) || 'Now'} to ${niceDay(b.ends_on) || 'until switched off'}` : 'No dates: shows until switched off'}
                              {b.free_extra && b.free_with ? ` · free ${EXTRA_LABEL[b.free_extra].toLowerCase()} with ${products.find(p => p.slug === b.free_with)?.name ?? b.free_with}` : ''}
                            </div>
                          </button>
                          <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${tone.cls}`}>{tone.label}</span>
                        </div>
                      )
                    })}
                  </CardContent></Card>
                )}
                <p className="text-xs text-muted-foreground mt-2">When two banners are on for the same day, the one higher in this list shows. A new banner goes to the top.</p>
              </>
            )}

            {tab === 'highlights' && (
              <HighlightsForm key={JSON.stringify(settings.spotlight)} settings={settings} products={sorted} canManage={canManage}
                onSave={spotlight => storeSettings({ ...settings, spotlight }, 'Highlights saved')} />
            )}

            {tab === 'prices' && (
              <PricesForm key={JSON.stringify([settings.sizes, settings.delivery, settings.extras, settings.freeShippingAbove])} settings={settings} canManage={canManage}
                onSave={next => storeSettings({ ...next, spotlight: settings.spotlight }, 'Prices saved')} />
            )}
          </>
        )}
      </div>

      {editGift && (
        <GiftModal
          gift={editGift === 'new' ? null : editGift}
          onClose={() => setEditGift(null)}
          onDelete={editGift === 'new' ? undefined : () => { setRemoveGift(editGift); setEditGift(null) }}
          onSave={async input => {
            const res = await saveProduct(input)
            if (!res.ok || !res.data) { toast.error('Could not save the gift', res.error); return }
            const saved = res.data
            setProducts(prev => (prev.some(x => x.id === saved.id) ? prev.map(x => (x.id === saved.id ? saved : x)) : [...prev, saved]))
            toast.success(input.id ? 'Gift saved' : `${saved.name} added`)
            setEditGift(null)
          }}
        />
      )}

      {editBanner && (
        <BannerModal
          banner={editBanner === 'new' ? null : editBanner}
          products={sorted}
          onClose={() => setEditBanner(null)}
          onDelete={editBanner === 'new' ? undefined : () => { setRemoveBanner(editBanner); setEditBanner(null) }}
          onSave={async input => {
            const res = await saveBanner(input)
            if (!res.ok || !res.data) { toast.error('Could not save the banner', res.error); return }
            const saved = res.data
            setBanners(prev => (prev.some(x => x.id === saved.id) ? prev.map(x => (x.id === saved.id ? saved : x)) : [saved, ...prev]))
            toast.success('Banner saved')
            setEditBanner(null)
          }}
        />
      )}

      {removeGift && (
        <ConfirmDialog
          title="Delete this gift?"
          body={`${removeGift.name} will leave this list and the website. To hide it for now and bring it back later, switch it off instead.`}
          confirmLabel="Delete gift"
          danger
          onCancel={() => setRemoveGift(null)}
          onConfirm={async () => {
            const t = removeGift
            setRemoveGift(null)
            const res = await deleteProduct(t.id)
            if (!res.ok) { toast.error('Could not delete', res.error); return }
            setProducts(prev => prev.filter(x => x.id !== t.id))
            toast.success('Gift deleted')
          }}
        />
      )}

      {removeBanner && (
        <ConfirmDialog
          title="Delete this banner?"
          body="It will leave this list and the website. To keep it for next time, switch it off instead."
          confirmLabel="Delete banner"
          danger
          onCancel={() => setRemoveBanner(null)}
          onConfirm={async () => {
            const t = removeBanner
            setRemoveBanner(null)
            const res = await deleteBanner(t.id)
            if (!res.ok) { toast.error('Could not delete', res.error); return }
            setBanners(prev => prev.filter(x => x.id !== t.id))
            toast.success('Banner deleted')
          }}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange}
      className={`relative shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-green-500' : 'bg-secondary border border-border'}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="block text-[11px] text-muted-foreground mt-1">{hint}</span>}
    </label>
  )
}

function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
        <div className="flex items-center justify-between gap-2 p-4 border-t border-border sticky bottom-0 bg-card">{footer}</div>
      </div>
    </ModalOverlay>
  )
}

function Chips({ options, value, onChange }: { options: readonly { key: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => {
        const on = value.includes(o.key)
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter(k => k !== o.key) : [...value, o.key])}
            className={`px-2.5 h-7 rounded-full text-xs font-medium border ${on ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-muted-foreground border-border'}`}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function GiftModal({ gift, onClose, onSave, onDelete }: {
  gift: ShopProduct | null
  onClose: () => void
  onSave: (input: ProductInput) => Promise<void>
  onDelete?: () => void
}) {
  const [name, setName] = useState(gift?.name ?? '')
  const [meta, setMeta] = useState(gift?.meta ?? '')
  const [price, setPrice] = useState(gift ? String(gift.price) : '')
  const [pieces, setPieces] = useState(gift?.pieces ? String(gift.pieces) : '')
  const [badge, setBadge] = useState(gift?.badge ?? '')
  const [description, setDescription] = useState(gift?.description ?? '')
  const [needs, setNeeds] = useState((gift?.needs ?? []).join('\n'))
  const [who, setWho] = useState<string[]>(gift?.who ?? ['her', 'him', 'friends'])
  const [occ, setOcc] = useState<string[]>(gift?.occ ?? ['birthday'])
  const [ready, setReady] = useState(gift?.ready ?? false)
  const [imageUrl, setImageUrl] = useState(gift?.image_url ?? '')
  const [active, setActive] = useState(gift?.active ?? true)
  const [saving, setSaving] = useState(false)

  return (
    <Sheet title={gift ? 'Edit gift' : 'Add gift'} onClose={onClose} footer={
      <>
        {onDelete ? <button type="button" onClick={onDelete} className="inline-flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300"><Trash2 className="w-4 h-4" /> Delete</button> : <span />}
        <span className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!name.trim() || !(Number(price) > 0) || saving}
            onClick={async () => {
              setSaving(true)
              await onSave({ id: gift?.id ?? null, name, meta, price, pieces, badge, description, needs, who, occ, ready, imageUrl, active })
              setSaving(false)
            }}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Save
          </Button>
        </span>
      </>
    }>
      <Field label="Name *"><input value={name} onChange={e => setName(e.target.value)} maxLength={80} className={INPUT} /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Price (₹) *"><input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" className={INPUT} /></Field>
        <Field label="Pieces in the set"><input value={pieces} onChange={e => setPieces(e.target.value)} inputMode="numeric" placeholder="Optional" className={INPUT} /></Field>
        <Field label="Badge"><input value={badge} onChange={e => setBadge(e.target.value)} maxLength={24} placeholder="New, Most loved" className={INPUT} /></Field>
      </div>
      <Field label="Short line under the name" hint="For example: 20 pieces, A5, box set."><input value={meta} onChange={e => setMeta(e.target.value)} maxLength={60} className={INPUT} /></Field>
      <Field label="Description"><textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={300} rows={2} className={AREA} /></Field>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={ready} onChange={e => setReady(e.target.checked)} />
        Ready-made: our own design, the customer sends no photos
      </label>
      {!ready && (
        <Field label="What the customer sends" hint="One item on each line."><textarea value={needs} onChange={e => setNeeds(e.target.value)} rows={3} placeholder={'20 photos\nCaptions, if you want them'} className={AREA} /></Field>
      )}
      <div><div className="text-xs text-muted-foreground mb-1.5">Good for</div><Chips options={WHO_OPTIONS} value={who} onChange={setWho} /></div>
      <div><div className="text-xs text-muted-foreground mb-1.5">Occasion</div><Chips options={OCC_OPTIONS} value={occ} onChange={setOcc} /></div>
      <Field label="Photo" hint="A full link to a photo, or the name of a file in the website's assets/photos folder. Leave empty to show the drawing.">
        <input value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://… or polaroid-1.jpg" className={INPUT} />
      </Field>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
        Show on the website
      </label>
    </Sheet>
  )
}

function BannerModal({ banner, products, onClose, onSave, onDelete }: {
  banner: ShopBanner | null
  products: ShopProduct[]
  onClose: () => void
  onSave: (input: BannerInput) => Promise<void>
  onDelete?: () => void
}) {
  const [title, setTitle] = useState(banner?.title ?? '')
  const [body, setBody] = useState(banner?.body ?? '')
  const [startsOn, setStartsOn] = useState(banner?.starts_on ?? '')
  const [endsOn, setEndsOn] = useState(banner?.ends_on ?? '')
  const [freeExtra, setFreeExtra] = useState<ExtraKey | ''>(banner?.free_extra ?? '')
  const [freeWith, setFreeWith] = useState(banner?.free_with ?? '')
  const [active, setActive] = useState(banner?.active ?? true)
  const [saving, setSaving] = useState(false)
  const datesWrong = !!startsOn && !!endsOn && endsOn < startsOn

  return (
    <Sheet title={banner ? 'Edit banner' : 'Add banner'} onClose={onClose} footer={
      <>
        {onDelete ? <button type="button" onClick={onDelete} className="inline-flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300"><Trash2 className="w-4 h-4" /> Delete</button> : <span />}
        <span className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!body.trim() || datesWrong || (!!freeExtra && !freeWith) || saving}
            onClick={async () => {
              setSaving(true)
              await onSave({ id: banner?.id ?? null, title, body, startsOn: startsOn || null, endsOn: endsOn || null, freeExtra: freeExtra || null, freeWith: freeExtra ? freeWith : null, active })
              setSaving(false)
            }}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Save
          </Button>
        </span>
      </>
    }>
      <div className="rounded-lg px-3 py-2 text-sm text-center bg-emerald-200 text-slate-900 min-h-[36px]">
        {title && <b>{title}{/^[,.:;!?]/.test(body) ? '' : ' '}</b>}{body || 'Your banner shows like this'}
      </div>
      <Field label="Bold words at the start" hint="Optional. For example: The Smile Drop, New, Onam offer."><input value={title} onChange={e => setTitle(e.target.value)} maxLength={60} className={INPUT} /></Field>
      <Field label="Banner text *" hint="Keep it to one short line. Simple English."><input value={body} onChange={e => setBody(e.target.value)} maxLength={160} className={INPUT} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts on"><input type="date" value={startsOn} onChange={e => setStartsOn(e.target.value)} className={INPUT} /></Field>
        <Field label="Ends on"><input type="date" value={endsOn} onChange={e => setEndsOn(e.target.value)} className={INPUT} /></Field>
      </div>
      <p className={`text-[11px] ${datesWrong ? 'text-red-400' : 'text-muted-foreground'}`}>
        {datesWrong ? 'The end date is before the start date.' : 'Leave the dates empty to show it until you switch it off. After the end date it disappears by itself.'}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Free extra in this offer">
          <AppSelect value={freeExtra} onChange={e => setFreeExtra(e.target.value as ExtraKey | '')}>
            <option value="">None</option>
            {EXTRA_KEYS.map(k => <option key={k} value={k}>{EXTRA_LABEL[k]}</option>)}
          </AppSelect>
        </Field>
        <Field label="With this gift">
          <AppSelect value={freeWith} onChange={e => setFreeWith(e.target.value)} disabled={!freeExtra}>
            <option value="">Choose a gift</option>
            {products.map(p => <option key={p.id} value={p.slug}>{p.name}</option>)}
          </AppSelect>
        </Field>
      </div>
      {freeExtra && <p className="text-[11px] text-muted-foreground">Between the two dates, an order with that gift gets the extra free in the website&apos;s order total.</p>}
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
        Banner is on
      </label>
    </Sheet>
  )
}

function HighlightsForm({ settings, products, canManage, onSave }: {
  settings: ShopSettings
  products: ShopProduct[]
  canManage: boolean
  onSave: (spotlight: ShopSpot[]) => Promise<boolean>
}) {
  const blank: ShopSpot = { id: '', title: '', text: '' }
  const [cards, setCards] = useState<ShopSpot[]>([settings.spotlight[0] ?? blank, settings.spotlight[1] ?? blank])
  const [saving, setSaving] = useState(false)
  const set = (i: number, patch: Partial<ShopSpot>) => setCards(prev => prev.map((c, k) => (k === i ? { ...c, ...patch } : c)))
  const incomplete = cards.some(c => c.id && !c.title.trim())

  return (
    <>
      <p className="text-sm text-muted-foreground mb-3">
        The two big cards between the print designs and the gifts. Use them for the gift you want to sell most right now: a new gift, a trend, an occasion.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        {cards.map((c, i) => {
          const p = products.find(x => x.slug === c.id)
          return (
            <Card key={i}><CardContent className="p-3 space-y-3">
              <div className="text-xs font-medium text-muted-foreground">Card {i + 1}</div>
              <Field label="Gift">
                <AppSelect value={c.id} disabled={!canManage} onChange={e => set(i, { id: e.target.value })}>
                  <option value="">No card</option>
                  {products.map(x => <option key={x.id} value={x.slug}>{x.name}{x.active ? '' : ' (hidden)'}</option>)}
                </AppSelect>
              </Field>
              <Field label="Heading" hint="Type {price} where the price should appear."><input value={c.title} disabled={!canManage || !c.id} onChange={e => set(i, { title: e.target.value })} maxLength={80} placeholder="Fill your wall for {price}" className={INPUT} /></Field>
              <Field label="One or two lines" hint="Type {each} for the price of one piece in a set."><textarea value={c.text} disabled={!canManage || !c.id} onChange={e => set(i, { text: e.target.value })} maxLength={200} rows={2} className={AREA} /></Field>
              {p && !p.active && <p className="text-[11px] text-orange-400">This gift is hidden, so this card will not show until the gift is switched on.</p>}
            </CardContent></Card>
          )
        })}
      </div>
      {canManage && (
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" disabled={saving || incomplete} onClick={async () => { setSaving(true); await onSave(cards.filter(c => c.id && c.title.trim())); setSaving(false) }}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Save highlights
          </Button>
          {incomplete && <span className="text-xs text-orange-400">Give each card a heading.</span>}
        </div>
      )}
    </>
  )
}

function PricesForm({ settings, canManage, onSave }: {
  settings: ShopSettings
  canManage: boolean
  onSave: (next: ShopSettings) => Promise<boolean>
}) {
  const [sizes, setSizes] = useState(settings.sizes.map(s => ({ ...s, price: String(s.price) })))
  const [free, setFree] = useState(String(settings.freeShippingAbove))
  const [kerala, setKerala] = useState(String(settings.delivery.kerala))
  const [india, setIndia] = useState(String(settings.delivery.india))
  const [extras, setExtras] = useState<Record<ExtraKey, string>>({
    wrap: String(settings.extras.wrap), note: String(settings.extras.note), express: String(settings.extras.express),
  })
  const [saving, setSaving] = useState(false)
  const bad = sizes.some(s => !(Number(s.price) > 0)) || !(Number(free) > 0)

  return (
    <div className="space-y-3">
      <Card><CardContent className="p-3">
        <div className="text-sm font-medium mb-2">Price of one print</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {sizes.map((s, i) => (
            <Field key={s.key} label={`${s.name} (${s.note})`}>
              <input value={s.price} disabled={!canManage} inputMode="decimal" onChange={e => setSizes(prev => prev.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))} className={INPUT} />
            </Field>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">The same price applies to every design and to prints of the customer&apos;s own photo.</p>
      </CardContent></Card>

      <Card><CardContent className="p-3">
        <div className="text-sm font-medium mb-2">Delivery</div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Free above (₹)"><input value={free} disabled={!canManage} inputMode="decimal" onChange={e => setFree(e.target.value)} className={INPUT} /></Field>
          <Field label="Within Kerala (₹)"><input value={kerala} disabled={!canManage} inputMode="decimal" onChange={e => setKerala(e.target.value)} className={INPUT} /></Field>
          <Field label="Rest of India (₹)"><input value={india} disabled={!canManage} inputMode="decimal" onChange={e => setIndia(e.target.value)} className={INPUT} /></Field>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">The order total and the delivery lines on the Policies and How it works pages follow these amounts.</p>
      </CardContent></Card>

      <Card><CardContent className="p-3">
        <div className="text-sm font-medium mb-2">Extras</div>
        <div className="grid grid-cols-3 gap-3">
          {EXTRA_KEYS.map(k => (
            <Field key={k} label={`${EXTRA_LABEL[k]} (₹)`}>
              <input value={extras[k]} disabled={!canManage} inputMode="decimal" onChange={e => setExtras(prev => ({ ...prev, [k]: e.target.value }))} className={INPUT} />
            </Field>
          ))}
        </div>
      </CardContent></Card>

      {canManage && (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={saving || bad}
            onClick={async () => {
              setSaving(true)
              await onSave({
                freeShippingAbove: Number(free),
                delivery: { kerala: Number(kerala) || 0, india: Number(india) || 0 },
                extras: { wrap: Number(extras.wrap) || 0, note: Number(extras.note) || 0, express: Number(extras.express) || 0 },
                sizes: sizes.map(s => ({ ...s, price: Number(s.price) })),
                spotlight: settings.spotlight,
              })
              setSaving(false)
            }}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Save prices
          </Button>
          {bad && <span className="text-xs text-orange-400">Every print size and the free-delivery amount need a number above zero.</span>}
        </div>
      )}
    </div>
  )
}
