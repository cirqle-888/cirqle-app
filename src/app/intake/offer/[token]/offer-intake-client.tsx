'use client'

import { useState, useRef } from 'react'
import {
  Plus, Loader2, CheckCircle2, X, ChevronDown, ChevronUp,
  Upload, Search, Tag, Calendar, MessageSquare, RefreshCw,
  ImageIcon, Trash2, GripVertical,
} from 'lucide-react'
import { saveCampaign, getImageUploadUrl, type ProductInput, type CampaignInput } from './actions'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Badge { id: string; label: string; color: string }
interface CatalogItem { id: string; name: string; weight?: string; image_url?: string; category?: string }
interface Campaign {
  id: string
  title?: string
  date_type: 'single' | 'range'
  offer_date?: string
  offer_date_from?: string
  offer_date_to?: string
  products: OfferProduct[]
}
interface OfferProduct {
  id: string
  catalog_id?: string
  name: string
  weight?: string
  image_url?: string
  offer_type: 'price' | 'percent' | 'bogo' | 'other'
  price?: number | null
  mrp?: number | null
  offer_text?: string
  badge_id?: string | null
  badge?: Badge | null
  display_order: number
}

const BADGE_COLOR: Record<string, string> = {
  red:    'bg-red-500/15 text-red-400 border-red-500/30',
  amber:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  orange: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  green:  'bg-green-500/15 text-green-400 border-green-500/30',
  blue:   'bg-blue-500/15 text-blue-400 border-blue-500/30',
  purple: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

const inputCls = 'w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 placeholder:text-white/30'
const labelCls = 'block text-xs font-medium text-white/50 mb-1.5'

function fmtDate(d?: string | null) {
  if (!d) return ''
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Empty product ─────────────────────────────────────────────────────────────

function emptyProduct(order: number): ProductInput & { _key: string } {
  return {
    _key: `new-${Date.now()}-${Math.random()}`,
    name: '',
    weight: '',
    image_url: '',
    offer_type: 'price',
    price: null,
    mrp: null,
    offer_text: '',
    badge_id: null,
    display_order: order,
  }
}

// ── Product Row ───────────────────────────────────────────────────────────────

function ProductRow({
  product, badges, onUpdate, onRemove, onUploadImage, uploading,
}: {
  product: (ProductInput & { _key: string; id?: string })
  badges: Badge[]
  onUpdate: (updates: Partial<ProductInput>) => void
  onRemove: () => void
  onUploadImage: (file: File) => Promise<string | null>
  uploading: boolean
}) {
  const [imgUploading, setImgUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImgUploading(true)
    const url = await onUploadImage(file)
    if (url) onUpdate({ image_url: url })
    setImgUploading(false)
    e.target.value = ''
  }

  const offerType = product.offer_type

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
      {/* Row header */}
      <div className="flex items-center gap-2">
        <GripVertical className="w-4 h-4 text-white/20 shrink-0" />
        <div className="flex-1 grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Product name *</label>
            <input
              value={product.name}
              onChange={e => onUpdate({ name: e.target.value })}
              className={inputCls}
              placeholder="e.g. Sunflower Oil"
            />
          </div>
          <div>
            <label className={labelCls}>Weight / Size</label>
            <input
              value={product.weight || ''}
              onChange={e => onUpdate({ weight: e.target.value })}
              className={inputCls}
              placeholder="e.g. 1L, 5kg"
            />
          </div>
        </div>
        <button
          onClick={onRemove}
          className="p-2 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Offer type toggle */}
      <div>
        <label className={labelCls}>Offer type</label>
        <div className="flex gap-1.5 flex-wrap">
          {(['price', 'percent', 'bogo', 'other'] as const).map(t => (
            <button
              key={t}
              onClick={() => onUpdate({ offer_type: t, price: null, mrp: null, offer_text: '' })}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                offerType === t
                  ? 'bg-violet-500/20 text-violet-300 border-violet-500/40'
                  : 'bg-white/5 text-white/50 border-white/10 hover:border-white/20'
              }`}
            >
              {t === 'price' ? '₹ Price' : t === 'percent' ? '% Off' : t === 'bogo' ? 'Buy 1 Get 1' : 'Other'}
            </button>
          ))}
        </div>
      </div>

      {/* Price fields */}
      {offerType === 'price' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Sale price</label>
            <input
              type="number" step="0.01" min="0"
              value={product.price ?? ''}
              onChange={e => onUpdate({ price: e.target.value ? parseFloat(e.target.value) : null })}
              className={inputCls}
              placeholder="e.g. 149.90"
            />
          </div>
          <div>
            <label className={labelCls}>MRP <span className="text-white/30">(optional)</span></label>
            <input
              type="number" step="0.01" min="0"
              value={product.mrp ?? ''}
              onChange={e => onUpdate({ mrp: e.target.value ? parseFloat(e.target.value) : null })}
              className={inputCls}
              placeholder="e.g. 199"
            />
          </div>
        </div>
      )}

      {offerType === 'percent' && (
        <div>
          <label className={labelCls}>Discount %</label>
          <input
            type="number" min="1" max="99"
            value={product.offer_text?.replace('%', '').replace(' Off', '') || ''}
            onChange={e => onUpdate({ offer_text: e.target.value ? `${e.target.value}% Off` : '' })}
            className={inputCls}
            placeholder="e.g. 50"
          />
        </div>
      )}

      {offerType === 'other' && (
        <div>
          <label className={labelCls}>Offer text</label>
          <input
            value={product.offer_text || ''}
            onChange={e => onUpdate({ offer_text: e.target.value })}
            className={inputCls}
            placeholder="e.g. 3 for ₹99, Free gift with purchase"
          />
        </div>
      )}

      {/* Badge + image row */}
      <div className="flex gap-2 items-start">
        {/* Badge selector */}
        <div className="flex-1">
          <label className={labelCls}>Badge <span className="text-white/30">(optional)</span></label>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => onUpdate({ badge_id: null })}
              className={`px-2.5 py-1 rounded-lg text-xs border transition-all ${
                !product.badge_id ? 'bg-white/10 text-white/70 border-white/20' : 'bg-transparent text-white/30 border-white/10 hover:border-white/20'
              }`}
            >
              None
            </button>
            {badges.map(b => (
              <button
                key={b.id}
                onClick={() => onUpdate({ badge_id: product.badge_id === b.id ? null : b.id })}
                className={`px-2.5 py-1 rounded-lg text-xs border transition-all ${
                  product.badge_id === b.id
                    ? BADGE_COLOR[b.color] || BADGE_COLOR.amber
                    : 'bg-transparent text-white/30 border-white/10 hover:border-white/20 hover:text-white/60'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {/* Image */}
        <div className="shrink-0">
          <label className={labelCls}>Image</label>
          <div className="flex items-center gap-2">
            {product.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={product.image_url} alt={product.name} className="w-10 h-10 rounded-lg object-cover border border-white/10" />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                <ImageIcon className="w-4 h-4 text-white/20" />
              </div>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={imgUploading}
              className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 hover:border-white/20 text-white/50 hover:text-white/80 transition-all flex items-center gap-1.5 disabled:opacity-40"
            >
              {imgUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              {product.image_url ? 'Change' : 'Upload'}
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Catalog picker modal ──────────────────────────────────────────────────────

function CatalogPicker({
  catalog, onSelect, onClose,
}: {
  catalog: CatalogItem[]
  onSelect: (item: CatalogItem) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const filtered = catalog.filter(c =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    (c.category || '').toLowerCase().includes(q.toLowerCase())
  )

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#1a1a2e] border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-white/10 flex items-center gap-3">
          <Search className="w-4 h-4 text-white/40 shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-white/30"
            placeholder="Search past products…"
          />
          <button onClick={onClose} className="p-1 rounded text-white/30 hover:text-white/70">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 && (
            <p className="text-sm text-white/30 text-center py-6">No products found</p>
          )}
          {filtered.map(item => (
            <button
              key={item.id}
              onClick={() => { onSelect(item); onClose() }}
              className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors text-left"
            >
              {item.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.image_url} alt={item.name} className="w-9 h-9 rounded-lg object-cover border border-white/10 shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4 text-white/20" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-white/90 truncate">{item.name}</p>
                {(item.weight || item.category) && (
                  <p className="text-xs text-white/40 truncate">{[item.weight, item.category].filter(Boolean).join(' · ')}</p>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-white/10">
          <button
            onClick={() => { onSelect({ id: '', name: '' }); onClose() }}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm text-white/60 hover:text-white/90 hover:bg-white/5 transition-colors border border-dashed border-white/15"
          >
            <Plus className="w-4 h-4" /> Add new product
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OfferIntakeClient({
  token, client, campaign: initialCampaign, catalog, badges, logoUrl,
}: {
  token: string
  client: { id: string; name: string }
  campaign: Campaign | null
  catalog: CatalogItem[]
  badges: Badge[]
  logoUrl: string | null
}) {
  // ── Header state ────────────────────────────────────────────────────────────
  const [title, setTitle] = useState(initialCampaign?.title || '')
  const [dateType, setDateType] = useState<'single' | 'range'>(initialCampaign?.date_type || 'range')
  const [offerDate, setOfferDate] = useState(initialCampaign?.offer_date || '')
  const [offerDateFrom, setOfferDateFrom] = useState(initialCampaign?.offer_date_from || '')
  const [offerDateTo, setOfferDateTo] = useState(initialCampaign?.offer_date_to || '')
  const [clientNote, setClientNote] = useState('')
  const [showNote, setShowNote] = useState(false)

  // ── Products state ──────────────────────────────────────────────────────────
  type LocalProduct = ProductInput & { _key: string; id?: string }
  const [products, setProducts] = useState<LocalProduct[]>(() =>
    initialCampaign?.products?.length
      ? initialCampaign.products
          .sort((a, b) => a.display_order - b.display_order)
          .map((p, i) => ({ ...p, _key: p.id, display_order: i }))
      : []
  )

  // ── UI state ────────────────────────────────────────────────────────────────
  const [showCatalog, setShowCatalog] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [campaignId, setCampaignId] = useState<string | undefined>(initialCampaign?.id)

  function updateProduct(key: string, updates: Partial<ProductInput>) {
    setProducts(prev => prev.map(p => p._key === key ? { ...p, ...updates } : p))
  }

  function removeProduct(key: string) {
    setProducts(prev => prev.filter(p => p._key !== key).map((p, i) => ({ ...p, display_order: i })))
  }

  function addFromCatalog(item: CatalogItem) {
    const order = products.length
    if (!item.id) {
      // New blank product
      setProducts(prev => [...prev, emptyProduct(order)])
    } else {
      // Check not already added
      const already = products.some(p => p.catalog_id === item.id)
      if (already) return
      setProducts(prev => [...prev, {
        _key: `cat-${item.id}-${Date.now()}`,
        catalog_id: item.id,
        name: item.name,
        weight: item.weight || '',
        image_url: item.image_url || '',
        offer_type: 'price',
        price: null,
        mrp: null,
        offer_text: '',
        badge_id: null,
        display_order: order,
      }])
    }
  }

  async function handleUploadImage(productKey: string, file: File): Promise<string | null> {
    const res = await getImageUploadUrl(token, file.name, file.type)
    if (!res.ok || !res.data) return null
    const uploadRes = await fetch(res.data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    if (!uploadRes.ok) return null
    return res.data.publicUrl
  }

  async function handleSave() {
    const invalid = products.find(p => !p.name.trim())
    if (invalid) { setError('All products need a name.'); return }
    if (products.length === 0) { setError('Add at least one product.'); return }

    setSaving(true); setError(''); setSaved(false)

    const input: CampaignInput = {
      title: title.trim() || undefined,
      date_type: dateType,
      offer_date: dateType === 'single' ? offerDate || undefined : undefined,
      offer_date_from: dateType === 'range' ? offerDateFrom || undefined : undefined,
      offer_date_to: dateType === 'range' ? offerDateTo || undefined : undefined,
      client_note: clientNote.trim() || undefined,
      products: products.map((p, i) => ({
        id: p.id,
        catalog_id: p.catalog_id,
        name: p.name.trim(),
        weight: p.weight?.trim() || undefined,
        image_url: p.image_url || undefined,
        offer_type: p.offer_type,
        price: p.price ?? null,
        mrp: p.mrp ?? null,
        offer_text: p.offer_text?.trim() || undefined,
        badge_id: p.badge_id || null,
        display_order: i,
      })),
    }

    const res = await saveCampaign(token, input, campaignId)
    setSaving(false)

    if (res.ok && res.data) {
      setCampaignId(res.data.campaignId)
      setSaved(true)
      setClientNote('')
      setShowNote(false)
      setTimeout(() => setSaved(false), 4000)
    } else {
      setError(res.error || 'Could not save. Please try again.')
    }
  }

  const dateDisplay = dateType === 'single'
    ? (offerDate ? fmtDate(offerDate) : '')
    : [offerDateFrom ? fmtDate(offerDateFrom) : '', offerDateTo ? fmtDate(offerDateTo) : ''].filter(Boolean).join(' – ')

  return (
    <div className="min-h-dvh bg-[#0f0f1a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12">

        {/* Brand header */}
        <div className="text-center mb-8">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Cirqle" className="h-10 mx-auto object-contain mb-4 brightness-0 invert" />
          ) : (
            <div className="mb-4">
              <div className="text-2xl font-extrabold tracking-tight">cirqle<span className="text-violet-400">.</span></div>
            </div>
          )}
          <h1 className="text-xl font-bold text-white/90">Offer Products</h1>
          <p className="text-sm text-white/40 mt-1">
            {client.name} · Add your products and prices for this offer
          </p>
        </div>

        {/* Saved banner */}
        {saved && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl px-4 py-3 mb-5 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-300 flex-1">Saved and sent to Cirqle team ✓</p>
          </div>
        )}

        {/* ── Offer header card ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5 mb-4 space-y-4">
          <div>
            <label className={labelCls}>Offer title <span className="text-white/25">(optional — your suggestion)</span></label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              className={inputCls}
              placeholder="e.g. Weekend Bonanza, Onam Special, Monthly Offers"
            />
          </div>

          {/* Date type toggle */}
          <div>
            <label className={labelCls}>Offer period</label>
            <div className="flex gap-2 mb-3">
              {(['single', 'range'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setDateType(t)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                    dateType === t
                      ? 'bg-violet-500/20 text-violet-300 border-violet-500/40'
                      : 'bg-white/5 text-white/40 border-white/10 hover:border-white/20'
                  }`}
                >
                  <Calendar className="w-3 h-3" />
                  {t === 'single' ? 'Single day' : 'Date range'}
                </button>
              ))}
            </div>

            {dateType === 'single' ? (
              <input
                type="date"
                value={offerDate}
                onChange={e => setOfferDate(e.target.value)}
                className={inputCls}
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>From</label>
                  <input type="date" value={offerDateFrom} onChange={e => setOfferDateFrom(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>To</label>
                  <input type="date" value={offerDateTo} onChange={e => setOfferDateTo(e.target.value)} className={inputCls} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Products section ── */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white/70">
              Products <span className="text-white/30">({products.length})</span>
            </h2>
            <button
              onClick={() => setShowCatalog(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors shadow-lg shadow-violet-900/40"
            >
              <Plus className="w-4 h-4" /> Add product
            </button>
          </div>

          <div className="space-y-3">
            {products.length === 0 && (
              <div className="bg-white/3 border border-dashed border-white/10 rounded-2xl py-10 text-center">
                <Tag className="w-8 h-8 text-white/15 mx-auto mb-3" />
                <p className="text-sm text-white/30">No products yet</p>
                <p className="text-xs text-white/20 mt-1">Tap "Add product" to pick from past products or add a new one</p>
              </div>
            )}
            {products.map(p => (
              <ProductRow
                key={p._key}
                product={p}
                badges={badges}
                onUpdate={updates => updateProduct(p._key, updates)}
                onRemove={() => removeProduct(p._key)}
                onUploadImage={file => handleUploadImage(p._key, file)}
                uploading={false}
              />
            ))}
          </div>
        </div>

        {/* ── Note to team ── */}
        <div className="mb-4">
          <button
            onClick={() => setShowNote(o => !o)}
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors"
          >
            <MessageSquare className="w-4 h-4" />
            {showNote ? 'Hide note' : 'Add a note to Cirqle team'}
            {showNote ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showNote && (
            <textarea
              rows={3}
              value={clientNote}
              onChange={e => setClientNote(e.target.value)}
              className={inputCls + ' mt-2 resize-none'}
              placeholder="e.g. Please check image for Atta — last one was blurry. Also check price for Rice."
            />
          )}
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-4 flex items-center gap-2 text-sm text-red-400">
            <X className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* ── Save button ── */}
        <button
          onClick={handleSave}
          disabled={saving || products.length === 0}
          className="w-full py-3.5 text-sm font-bold rounded-2xl bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
        >
          {saving
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
            : campaignId
              ? <><RefreshCw className="w-4 h-4" /> Update offer list</>
              : <><CheckCircle2 className="w-4 h-4" /> Submit offer list</>
          }
        </button>

        {campaignId && (
          <p className="text-center text-xs text-white/25 mt-3">
            You can update this list any time — changes are logged for the Cirqle team.
          </p>
        )}

        <p className="text-center text-[11px] text-white/20 mt-8">
          Cirqle Design · cirqle.work · This page is private to {client.name}.
        </p>
      </div>

      {/* Catalog picker modal */}
      {showCatalog && (
        <CatalogPicker
          catalog={catalog}
          onSelect={addFromCatalog}
          onClose={() => setShowCatalog(false)}
        />
      )}
    </div>
  )
}
