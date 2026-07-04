'use client'

import { useState, useRef } from 'react'
import {
  Plus, Loader2, CheckCircle2, Check, X, ChevronDown, ChevronUp,
  Upload, Search, Tag, Calendar, MessageSquare, RefreshCw,
  ImageIcon, Trash2, GripVertical, Copy, FilePlus, CopyPlus, LayoutGrid, List,
  ArrowUp, ArrowDown, Shuffle, Sparkles, ClipboardPaste,
} from 'lucide-react'
import { saveCampaign, getImageUploadUrl, aiParseProductList, type ProductInput, type ProductBadgeInput, type CampaignInput } from './actions'
import type { ParsedOfferProduct } from '@/lib/ai/offer-capture'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { IntakeAppSwitcher } from '@/components/intake/app-switcher'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Badge { id: string; label: string; color: string }
interface CatalogImage { id: string; url: string; is_primary: boolean; created_at: string }
interface CatalogItem { id: string; name: string; weight?: string; image_url?: string; category?: string; images?: CatalogImage[] }
interface Campaign {
  id: string
  title?: string
  date_type: 'single' | 'range'
  offer_date?: string
  offer_date_from?: string
  offer_date_to?: string
  products: OfferProduct[]
}
interface ProductBadge { id: string; badge_id?: string | null; custom_label?: string | null; color: string; badge?: Badge | null }
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
  badges?: ProductBadge[]
  page?: number
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
    badges: [],
    page: 1,
    display_order: order,
  }
}

// ── Product Row ───────────────────────────────────────────────────────────────

function ProductRow({
  product, badges, catalog, catalogImages, onUpdate, onRemove, onUploadImage, uploading,
  onDuplicate, onAddNext
}: {
  product: (ProductInput & { _key: string; id?: string })
  badges: Badge[]
  catalog: CatalogItem[]
  catalogImages?: CatalogImage[]
  onUpdate: (updates: Partial<ProductInput>) => void
  onRemove: () => void
  onUploadImage: (file: File) => Promise<string | null>
  uploading: boolean
  onDuplicate: () => void
  onAddNext: () => void
}) {
  const [imgUploading, setImgUploading] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [customBadgeOpen, setCustomBadgeOpen] = useState(false)
  const [customLabel, setCustomLabel] = useState('')
  const [customColor, setCustomColor] = useState('amber')
  const [isExpanded, setIsExpanded] = useState(false)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [showImgMenu, setShowImgMenu] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const searchMatch = product.name?.trim().length > 1 
    ? catalog.filter(c => c.name.toLowerCase().includes(product.name.toLowerCase()) || (c.category || '').toLowerCase().includes(product.name.toLowerCase())).slice(0, 6)
    : []

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImgUploading(true)
    const url = await onUploadImage(file)
    if (url) onUpdate({ image_url: url })
    setImgUploading(false)
    e.target.value = ''
  }

  const productBadges = product.badges || []
  function togglePredefinedBadge(b: Badge) {
    const has = productBadges.some(pb => pb.badge_id === b.id)
    onUpdate({
      badges: has
        ? productBadges.filter(pb => pb.badge_id !== b.id)
        : [...productBadges, { badge_id: b.id, color: b.color } as ProductBadgeInput],
    })
  }
  function addCustomBadge() {
    const label = customLabel.trim()
    if (!label) return
    onUpdate({ badges: [...productBadges, { custom_label: label, color: customColor } as ProductBadgeInput] })
    setCustomLabel(''); setCustomColor('amber'); setCustomBadgeOpen(false)
  }
  function removeBadge(idx: number) {
    onUpdate({ badges: productBadges.filter((_, i) => i !== idx) })
  }

  const offerType = product.offer_type

  return (
    <div className={`bg-white/5 border ${isExpanded ? 'border-white/20 shadow-xl' : 'border-white/10 hover:border-white/15'} rounded-2xl transition-all relative ${showAutocomplete ? 'z-20' : 'z-10'}`}>
      {/* ── Collapsed / Header ── */}
      <div className="flex items-center gap-2 p-3">
        <GripVertical className="w-4 h-4 text-white/20 shrink-0 cursor-grab" />
        
        <div className="flex-1 grid grid-cols-[3fr_2fr] gap-2 items-center">
          <div className="relative">
            <input
              value={product.name}
              onChange={e => {
                onUpdate({ name: e.target.value })
                setShowAutocomplete(true)
              }}
              onFocus={() => setShowAutocomplete(true)}
              onBlur={() => setTimeout(() => setShowAutocomplete(false), 200)}
              className="bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm font-medium focus:outline-none placeholder:text-white/20 w-full"
              placeholder="Product name"
            />
            {showAutocomplete && searchMatch.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-[240px] sm:w-[320px] bg-[#1a1a24] border border-white/10 rounded-xl shadow-2xl z-50 max-h-64 overflow-y-auto overflow-x-hidden">
                {searchMatch.map(item => (
                  <button
                    key={item.id}
                    onClick={() => {
                      onUpdate({
                        catalog_id: item.id,
                        // Weight is part of the name (single column); append a
                        // legacy catalog weight if the name doesn't already have it.
                        name: item.weight && !item.name.toLowerCase().includes(item.weight.toLowerCase())
                          ? `${item.name} ${item.weight}`
                          : item.name,
                        image_url: item.image_url || product.image_url || '',
                      })
                      setShowAutocomplete(false)
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-3 border-b border-white/5 last:border-0"
                  >
                    <div className="w-8 h-8 rounded-lg bg-white/5 shrink-0 overflow-hidden flex items-center justify-center">
                      {item.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.image_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="w-4 h-4 text-white/20" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white/90 truncate">{item.name}</p>
                      {(item.weight || item.category) && <p className="text-xs text-white/40 truncate">{[item.weight, item.category].filter(Boolean).join(' · ')}</p>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-white/30 text-xs font-medium shrink-0">₹</span>
            <input
              type="number" step="0.01" min="0"
              value={product.price ?? ''}
              onChange={e => onUpdate({ price: e.target.value ? parseFloat(e.target.value) : null })}
              onKeyDown={e => {
                 if (e.key === 'Enter') {
                   e.preventDefault()
                   onAddNext()
                 }
              }}
              className="bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm focus:outline-none placeholder:text-white/20 w-full"
              placeholder="Sale price"
            />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {product.image_url && !isExpanded && (
             <div className="relative">
               <button 
                 onClick={() => setShowImgMenu(!showImgMenu)}
                 className="w-6 h-6 rounded bg-white/5 border border-white/10 overflow-hidden shrink-0 hover:ring-2 hover:ring-violet-500/50 transition-all cursor-pointer block"
               >
                 {/* eslint-disable-next-line @next/next/no-img-element */}
                 <img src={product.image_url} alt="" className="w-full h-full object-cover" />
               </button>
               {showImgMenu && (
                 <>
                   <div className="fixed inset-0 z-40" onClick={() => setShowImgMenu(false)} />
                   <div className="absolute top-full right-0 mt-2 w-36 bg-[#1a1a24] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden py-1">
                     <button
                       onClick={() => { setShowImgMenu(false); setLightbox(product.image_url!); }}
                       className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 hover:text-white flex items-center gap-2"
                     >
                       <ImageIcon className="w-3.5 h-3.5" /> View larger
                     </button>
                     <button
                       onClick={() => { setShowImgMenu(false); fileRef.current?.click(); }}
                       className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 hover:text-white flex items-center gap-2"
                     >
                       <Upload className="w-3.5 h-3.5" /> Upload new
                     </button>
                     {!!catalogImages?.length && catalogImages.length > 1 && (
                       <button
                         onClick={() => { setShowImgMenu(false); setIsExpanded(true); setShowGallery(true); }}
                         className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 hover:text-white flex items-center gap-2"
                       >
                         <ImageIcon className="w-3.5 h-3.5" /> Past photos
                       </button>
                     )}
                   </div>
                 </>
               )}
             </div>
          )}
          {productBadges.length > 0 && !isExpanded && (
             <div className="w-5 h-5 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-[9px] font-bold text-violet-300 ml-1">
               {productBadges.length}
             </div>
          )}
          
          <button onClick={onDuplicate} className="p-1.5 rounded-lg text-white/30 hover:text-white/80 hover:bg-white/10 transition-colors hidden sm:block" title="Duplicate">
            <Copy className="w-4 h-4" />
          </button>
          <button onClick={onRemove} className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors hidden sm:block" title="Remove">
            <Trash2 className="w-4 h-4" />
          </button>
          
          <button onClick={() => setIsExpanded(!isExpanded)} className="p-1.5 rounded-lg text-white/40 hover:text-white/90 hover:bg-white/10 transition-colors border border-transparent hover:border-white/10 ml-1">
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* ── Expanded Form ── */}
      {isExpanded && (
        <div className="p-4 pt-2 border-t border-white/5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Page</label>
              <input
                type="number" min={1}
                value={product.page ?? 1}
                onChange={e => onUpdate({ page: Math.max(1, parseInt(e.target.value) || 1) })}
                className={inputCls}
              />
            </div>
          </div>

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

          {offerType === 'price' && (
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
                placeholder="e.g. 3 for ₹99, Free gift"
              />
            </div>
          )}

          <div>
            <label className={labelCls}>Badges</label>
            <div className="flex flex-wrap gap-1.5 items-center">
              {badges.map(b => {
                const active = productBadges.some(pb => pb.badge_id === b.id)
                return (
                  <button
                    key={b.id}
                    onClick={() => togglePredefinedBadge(b)}
                    className={`px-2.5 py-1 rounded-lg text-xs border transition-all ${
                      active ? BADGE_COLOR[b.color] || BADGE_COLOR.amber : 'bg-transparent text-white/30 border-white/10 hover:border-white/20 hover:text-white/60'
                    }`}
                  >
                    {b.label}
                  </button>
                )
              })}
              {productBadges.filter(pb => !pb.badge_id).map((pb, i) => {
                const idx = productBadges.indexOf(pb)
                return (
                  <span key={`custom-${i}`} className={`px-2.5 py-1 rounded-lg text-xs border flex items-center gap-1 ${BADGE_COLOR[pb.color] || BADGE_COLOR.amber}`}>
                    {pb.custom_label}
                    <button onClick={() => removeBadge(idx)} className="hover:opacity-70"><X className="w-3 h-3" /></button>
                  </span>
                )
              })}
              {!customBadgeOpen ? (
                <button onClick={() => setCustomBadgeOpen(true)}
                  className="px-2.5 py-1 rounded-lg text-xs border border-dashed border-white/15 text-white/40 hover:text-white/70 flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Custom
                </button>
              ) : (
                <div className="flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-2 py-1">
                  <input
                    autoFocus value={customLabel} onChange={e => setCustomLabel(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addCustomBadge(); if (e.key === 'Escape') setCustomBadgeOpen(false) }}
                    placeholder="Custom" className="bg-transparent text-xs text-white/80 focus:outline-none w-20"
                  />
                  {Object.keys(BADGE_COLOR).map(c => (
                    <button key={c} onClick={() => setCustomColor(c)}
                      className={`w-3 h-3 rounded-full border ${customColor === c ? 'ring-1 ring-white/50' : ''} ${BADGE_COLOR[c].split(' ')[0]}`} />
                  ))}
                  <button onClick={addCustomBadge} className="text-emerald-400 hover:text-emerald-300"><Check className="w-3 h-3" /></button>
                  <button onClick={() => setCustomBadgeOpen(false)} className="text-white/30 hover:text-white/60"><X className="w-3 h-3" /></button>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className={labelCls}>Image</label>
            <div className="flex items-center gap-2 flex-wrap">
              {product.image_url ? (
                <button onClick={() => setLightbox(product.image_url!)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={product.image_url} alt="" className="w-10 h-10 rounded-lg object-cover border border-white/10" />
                </button>
              ) : (
                <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                  <ImageIcon className="w-4 h-4 text-white/20" />
                </div>
              )}
              <button
                onClick={() => fileRef.current?.click()}
                disabled={imgUploading}
                className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 hover:border-white/20 text-white/50 flex items-center gap-1.5 disabled:opacity-40"
              >
                {imgUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                {product.image_url ? 'Change' : 'Upload'}
              </button>
              {!!catalogImages?.length && catalogImages.length > 1 && (
                <button onClick={() => setShowGallery(g => !g)}
                  className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 hover:border-white/20 text-white/50 flex items-center gap-1.5">
                  <ImageIcon className="w-3 h-3" /> Past photos
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            </div>
            {showGallery && !!catalogImages?.length && (
              <div className="mt-2 flex gap-1.5 flex-wrap bg-white/5 border border-white/10 rounded-xl p-2">
                {catalogImages.map(img => (
                  <button key={img.id} onClick={() => { onUpdate({ image_url: img.url }); setShowGallery(false) }}
                    className={`relative rounded-lg overflow-hidden border ${product.image_url === img.url ? 'border-violet-400' : 'border-white/10'}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt="" className="w-10 h-10 object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
          
          <div className="flex sm:hidden justify-between border-t border-white/5 pt-3">
             <button onClick={onDuplicate} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/80">
               <Copy className="w-3.5 h-3.5" /> Duplicate
             </button>
             <button onClick={onRemove} className="flex items-center gap-1.5 text-xs text-red-400/70 hover:text-red-400">
               <Trash2 className="w-3.5 h-3.5" /> Remove
             </button>
          </div>
        </div>
      )}
      {lightbox && <ImageLightbox src={lightbox} alt={product.name} onClose={() => setLightbox(null)} />}
    </div>
  )
}

function ProductGridCard({
  product, badges, catalogImages, onUpdate, onRemove, onUploadImage, uploading
}: {
  product: any
  badges: Badge[]
  catalogImages?: CatalogImage[]
  onUpdate: (updates: Partial<ProductInput>) => void
  onRemove: () => void
  onUploadImage: (file: File) => Promise<string | null>
  uploading: boolean
}) {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [imgUploading, setImgUploading] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const productBadges = (product.badges || [])

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImgUploading(true)
    const url = await onUploadImage(file)
    if (url) onUpdate({ image_url: url })
    setImgUploading(false)
  }

  return (
    <>
      <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden shadow-lg flex flex-col hover:border-white/20 transition-all relative">
        <div className="absolute top-2 left-2 z-30 flex gap-1">
          <button onClick={onRemove} className="p-1.5 bg-black/40 hover:bg-red-500/80 rounded text-white/50 hover:text-white backdrop-blur-md transition-colors" title="Remove">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        
        <div className="aspect-[4/3] bg-white/5 relative group/img">
          {product.image_url ? (
            <img src={product.image_url} alt="" className="w-full h-full object-cover group-hover/img:scale-105 transition-transform duration-500" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="w-8 h-8 text-white/20" />
            </div>
          )}
          
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center gap-2 z-20">
             {product.image_url && (
               <button onClick={() => setLightbox(product.image_url!)} className="p-2 bg-white/20 hover:bg-white/40 rounded-full text-white transition-colors" title="View larger"><Search className="w-4 h-4"/></button>
             )}
             <button onClick={() => fileRef.current?.click()} className="p-2 bg-white/20 hover:bg-white/40 rounded-full text-white transition-colors" disabled={imgUploading} title="Upload new">
               {imgUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
             </button>
             {!!catalogImages?.length && catalogImages.length > 1 && (
               <button onClick={() => setShowGallery(g => !g)} className="p-2 bg-white/20 hover:bg-white/40 rounded-full text-white transition-colors" title="Past photos"><ImageIcon className="w-4 h-4"/></button>
             )}
          </div>

          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
          
          {showGallery && !!catalogImages?.length && (
            <div className="absolute inset-x-0 bottom-0 top-1/2 bg-black/90 backdrop-blur-xl p-2 flex gap-2 overflow-x-auto items-center z-30 border-t border-white/10">
              {catalogImages.map(img => (
                <button key={img.id} onClick={() => { onUpdate({ image_url: img.url }); setShowGallery(false) }}
                  className={`shrink-0 relative rounded-lg overflow-hidden border ${product.image_url === img.url ? 'border-violet-400 ring-2 ring-violet-500/50' : 'border-white/10 hover:border-white/40'}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="w-12 h-12 object-cover" />
                </button>
              ))}
              <button onClick={() => setShowGallery(false)} className="absolute top-1 right-1 p-1 bg-black/50 rounded-full text-white/50 hover:text-white"><X className="w-3 h-3"/></button>
            </div>
          )}

          {productBadges.length > 0 && (
             <div className="absolute top-2 right-2 flex flex-col gap-1 items-end z-10">
               {productBadges.map((pb: any, i: number) => {
                 const badgeData = badges.find(b => b.id === pb.badge_id)
                 const bg = badgeData?.color === 'emerald' ? 'bg-emerald-500/90 text-emerald-100' :
                            badgeData?.color === 'rose' ? 'bg-rose-500/90 text-rose-100' :
                            badgeData?.color === 'blue' ? 'bg-blue-500/90 text-blue-100' :
                            badgeData?.color === 'amber' ? 'bg-amber-500/90 text-amber-100' :
                            'bg-violet-500/90 text-violet-100'
                 return (
                   <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] font-bold shadow-md ${bg}`}>
                     {pb.custom_label || badgeData?.label}
                   </span>
                 )
               })}
             </div>
          )}
        </div>
        <div className="p-3 flex-1 flex flex-col">
          <input
            value={product.name}
            onChange={e => onUpdate({ name: e.target.value })}
            className="bg-transparent font-medium text-white/90 text-[13px] leading-snug w-full focus:outline-none focus:bg-white/10 hover:bg-white/5 rounded px-1 -mx-1 transition-colors"
            placeholder="Product name (include weight, e.g. Rice 5kg)"
          />
          <div className="mt-auto pt-3 flex items-end justify-between gap-2">
             <div className="shrink-0 flex items-center gap-0.5">
               <span className="text-emerald-400 font-bold text-[11px] mb-0.5">₹</span>
               <input
                 type="number" step="0.01" min="0"
                 value={product.price ?? ''}
                 onChange={e => onUpdate({ price: e.target.value ? parseFloat(e.target.value) : null })}
                 className="bg-transparent font-bold text-emerald-400 text-sm w-16 focus:outline-none focus:bg-white/10 hover:bg-white/5 rounded px-1 py-0.5 transition-colors"
                 placeholder="Price"
               />
             </div>
             {product.offer_type !== 'price' && product.offer_text && (
               <div className="text-[10px] bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded border border-violet-500/30 max-w-[80px] truncate text-right shrink-0" title={product.offer_text}>
                 {product.offer_text}
               </div>
             )}
          </div>
        </div>
      </div>
      {lightbox && <ImageLightbox src={lightbox} alt={product.name} onClose={() => setLightbox(null)} />}
    </>
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
        <div className="max-h-80 overflow-y-auto p-3">
          {filtered.length === 0 && (
            <p className="text-sm text-white/30 text-center py-6">No products found</p>
          )}
          <div className="grid grid-cols-3 gap-2">
            {filtered.map(item => (
              <button
                key={item.id}
                onClick={() => { onSelect(item); onClose() }}
                className="rounded-xl overflow-hidden hover:ring-2 hover:ring-violet-500/50 transition-all text-left bg-white/5 border border-white/10"
              >
                <div className="aspect-square bg-white/5 relative">
                  {item.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <ImageIcon className="w-5 h-5 text-white/20" />
                    </div>
                  )}
                </div>
                <div className="p-1.5">
                  <p className="text-[11px] font-medium text-white/90 truncate" title={item.name}>{item.name}</p>
                  {(item.weight || item.category) && (
                    <p className="text-[10px] text-white/40 truncate">{[item.weight, item.category].filter(Boolean).join(' · ')}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
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

const getTomorrowStr = () => {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
}

export default function OfferIntakeClient({
  token, client, campaign: initialCampaign, catalog, badges, logoUrl, switcher,
}: {
  token: string
  client: { id: string; name: string }
  campaign: Campaign | null
  catalog: CatalogItem[]
  badges: Badge[]
  logoUrl: string | null
  switcher?: { kind: string; label: string; href: string }[]
}) {
  // ── Header state ────────────────────────────────────────────────────────────
  const [title, setTitle] = useState(initialCampaign?.title || '')
  const [dateType, setDateType] = useState<'single' | 'range'>(initialCampaign?.date_type || 'single')
  
  // Use lazy initialization for tomorrow's date so it evaluates accurately when the component mounts
  const [offerDate, setOfferDate] = useState(() => initialCampaign?.offer_date || getTomorrowStr())
  const [offerDateFrom, setOfferDateFrom] = useState(() => initialCampaign?.offer_date_from || getTomorrowStr())
  const [offerDateTo, setOfferDateTo] = useState(initialCampaign?.offer_date_to || '')
  const [clientNote, setClientNote] = useState('')
  const [showNote, setShowNote] = useState(false)
  const [headerExpanded, setHeaderExpanded] = useState(!initialCampaign?.title && !initialCampaign?.offer_date)

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
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [campaignId, setCampaignId] = useState<string | undefined>(initialCampaign?.id)

  const [catalogPageTarget, setCatalogPageTarget] = useState<number>(1)

  // ── Bulk paste (AI) ─────────────────────────────────────────────────────
  type BulkPasteRow = ParsedOfferProduct & { _key: string; include: boolean; matchedCatalogId?: string }
  const [bulkPasteOpen, setBulkPasteOpen] = useState(false)
  const [bulkPasteText, setBulkPasteText] = useState('')
  const [bulkPasteBusy, setBulkPasteBusy] = useState(false)
  const [bulkPasteReview, setBulkPasteReview] = useState<BulkPasteRow[] | null>(null)
  const [bulkPasteTargetPage, setBulkPasteTargetPage] = useState(1)

  function openBulkPaste() {
    setBulkPasteText('')
    setBulkPasteReview(null)
    setBulkPasteTargetPage(Math.max(1, ...products.map(p => p.page || 1)))
    setBulkPasteOpen(true)
  }

  async function runBulkPasteParse() {
    if (!bulkPasteText.trim()) return
    setBulkPasteBusy(true)
    const res = await aiParseProductList(token, bulkPasteText)
    setBulkPasteBusy(false)
    if (res.ok && res.data) {
      // Fuzzy-match each parsed name against this client's existing catalog
      // (already loaded in memory) so a reused product picks up its known
      // image/weight instead of starting blank.
      const rows: BulkPasteRow[] = res.data.products.map((p, i) => {
        const lower = p.name.toLowerCase()
        const match = catalog.find(c => c.name.toLowerCase() === lower)
          || catalog.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()))
        // Weight is a single column with the name. If we matched an older
        // catalog product that still stores weight separately, append it.
        const name = match?.weight && !p.name.toLowerCase().includes(match.weight.toLowerCase())
          ? `${p.name} ${match.weight}`
          : p.name
        return {
          ...p,
          name,
          weight: null,
          _key: `bulk-${Date.now()}-${i}`,
          include: true,
          matchedCatalogId: match?.id,
        }
      })
      setBulkPasteReview(rows)
    } else {
      setError(res.error || 'Could not parse that text.')
    }
  }

  function updateBulkPasteRow(key: string, updates: Partial<BulkPasteRow>) {
    setBulkPasteReview(prev => prev?.map(r => r._key === key ? { ...r, ...updates } : r) || null)
  }

  function confirmBulkPaste() {
    if (!bulkPasteReview) return
    const included = bulkPasteReview.filter(r => r.include && r.name.trim())
    if (!included.length) return
    let order = products.length
    const newRows = included.map(r => {
      const match = r.matchedCatalogId ? catalog.find(c => c.id === r.matchedCatalogId) : undefined
      return {
        _key: `bulk-add-${Date.now()}-${order}`,
        catalog_id: match?.id,
        name: r.name,
        weight: '',
        image_url: match?.image_url || '',
        offer_type: 'price' as const,
        price: r.price ?? null,
        mrp: r.mrp ?? null,
        offer_text: '',
        badges: [],
        page: bulkPasteTargetPage,
        display_order: order++,
      }
    })
    setProducts(prev => [...prev, ...newRows])
    setBulkPasteOpen(false)
    setBulkPasteReview(null)
    setBulkPasteText('')
  }

  function addBlankProduct(page: number) {
    const order = products.length
    setProducts(prev => [...prev, { ...emptyProduct(order), page }])
  }

  function duplicateProduct(key: string) {
    const src = products.find(p => p._key === key)
    if (!src) return
    const order = products.length
    setProducts(prev => [...prev, {
      ...src,
      id: undefined,
      _key: `dup-${Date.now()}-${Math.random()}`,
      display_order: order,
    }])
  }

  function updateProduct(key: string, updates: Partial<ProductInput>) {
    setProducts(prev => prev.map(p => p._key === key ? { ...p, ...updates } : p))
  }

  // Reorder one page's products (price sort or shuffle). Other pages are left
  // exactly as they were — only the target page's relative order changes.
  function sortPageProducts(pageNum: number, mode: 'price_asc' | 'price_desc' | 'shuffle') {
    setProducts(prev => {
      const pageItems = prev.filter(p => (p.page || 1) === pageNum)
      const otherItems = prev.filter(p => (p.page || 1) !== pageNum)
      const sorted = [...pageItems]
      if (mode === 'price_asc') {
        sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
      } else if (mode === 'price_desc') {
        sorted.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity))
      } else {
        // Fisher–Yates shuffle
        for (let i = sorted.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[sorted[i], sorted[j]] = [sorted[j], sorted[i]]
        }
      }
      return [...otherItems, ...sorted].map((p, i) => ({ ...p, display_order: i }))
    })
  }

  function removeProduct(key: string) {
    setProducts(prev => prev.filter(p => p._key !== key).map((p, i) => ({ ...p, display_order: i })))
  }

  function addFromCatalog(item: CatalogItem) {
    const order = products.length
    const page = catalogPageTarget
    if (!item.id) {
      // New blank product
      setProducts(prev => [...prev, { ...emptyProduct(order), page }])
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
        badges: [],
        display_order: order,
        page,
      }])
    }
  }

  async function handleUploadImage(productKey: string, file: File): Promise<string | null> {
    const res = await getImageUploadUrl(token, file.name, file.type)
    if (!res.ok || !res.data) {
      setError(res.error || 'Could not prepare image upload. Please try again or contact Cirqle.')
      return null
    }
    const uploadRes = await fetch(res.data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    if (!uploadRes.ok) {
      setError('Image upload failed. Please try again or contact Cirqle.')
      return null
    }
    setError('')
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
        badges: (p.badges || []).map(b => ({ badge_id: b.badge_id || null, custom_label: b.custom_label || null, color: b.color })),
        page: p.page || 1,
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
      {/* Brand header — stays a comfortable reading width even on wide screens; a
          centered logo/title stretched edge-to-edge on a desktop monitor looks broken. */}
      <div className="max-w-2xl mx-auto px-4 pt-8 sm:pt-12">
        <div className="text-center mb-8">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Cirqle" className="h-10 w-auto max-w-[200px] mx-auto object-contain mb-4" />
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
        {switcher && <IntakeAppSwitcher options={switcher} current="offer_intake" dark />}
      </div>

      {/* Working area — the part the client actually edits. Widens progressively
          on larger screens so desktop browsers aren't stuck in a narrow mobile-width
          column. Only the Products section (below) uses the full width of this —
          a single title input or date picker stretched across 1400px looks empty,
          so the offer-details card, note, and save button stay in their own
          reading-width column while the product grid gets the real room. */}
      <div className="max-w-2xl lg:max-w-5xl xl:max-w-7xl 2xl:max-w-[1400px] mx-auto px-4 pb-8 sm:pb-12">
       <div className="max-w-2xl mx-auto">

        {/* Saved banner */}
        {saved && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl px-4 py-3 mb-5 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-300 flex-1">Saved and sent to Cirqle team ✓</p>
          </div>
        )}

        {/* ── Offer header card ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5 mb-4 relative">
          <div className="flex justify-between items-center cursor-pointer" onClick={() => setHeaderExpanded(!headerExpanded)}>
            <div>
              <h2 className="text-sm font-semibold text-white/90">Offer Details</h2>
              {!headerExpanded && (
                <p className="text-xs text-white/50 mt-0.5 truncate max-w-sm sm:max-w-lg">
                  {title || 'Untitled Offer'} <span className="mx-2 opacity-30">•</span> {dateDisplay || 'No dates set'}
                </p>
              )}
            </div>
            <button className="p-1.5 bg-white/5 hover:bg-white/10 rounded text-white/60 hover:text-white transition-colors">
              {headerExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {headerExpanded && (
            <div className="mt-4 pt-4 border-t border-white/10 space-y-4">
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
          )}
        </div>
       </div>

        {/* ── Products section — full width of the (wide) outer container ── */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3 px-1">
             <h2 className="text-sm font-semibold text-white/70">
               Products <span className="text-white/30">({products.length})</span>
             </h2>
             <div className="flex items-center gap-2">
             <button
               onClick={openBulkPaste}
               title="Paste a product list and let AI fill in the rows"
               className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600/20 text-violet-300 hover:bg-violet-600/40 transition-colors"
             >
               <Sparkles className="w-3.5 h-3.5" /> Bulk Paste
             </button>
             {products.length > 0 && (
               <div className="flex items-center bg-white/5 border border-white/10 rounded-lg p-0.5">
                 <button
                   onClick={() => setViewMode('list')}
                   className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}
                 >
                   <List className="w-3.5 h-3.5" />
                 </button>
                 <button
                   onClick={() => setViewMode('grid')}
                   className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}
                 >
                   <LayoutGrid className="w-3.5 h-3.5" />
                 </button>
               </div>
             )}
             </div>
          </div>

          <div className="space-y-6">
            {products.length === 0 && (
              <div className="bg-white/3 border border-dashed border-white/10 rounded-2xl py-10 text-center">
                <Tag className="w-8 h-8 text-white/15 mx-auto mb-3" />
                <p className="text-sm text-white/30">No products yet</p>
                <div className="flex justify-center mt-4 gap-2">
                  <button onClick={() => addBlankProduct(1)} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors">
                    Add manually
                  </button>
                  <button onClick={() => { setCatalogPageTarget(1); setShowCatalog(true) }} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-white/10 hover:bg-white/20 text-white transition-colors">
                    Search past products
                  </button>
                </div>
              </div>
            )}

            {Array.from(new Set(products.map(p => p.page || 1))).sort((a, b) => a - b).map(pageNum => {
               const pageProducts = products.filter(p => (p.page || 1) === pageNum)
               return (
                 <div key={pageNum} className="bg-[#1a1a24] border border-white/10 rounded-3xl p-4 shadow-xl">
                   <div className="flex items-center justify-between mb-4 px-1">
                     <h3 className="font-bold text-white/80 flex items-center gap-2">
                        <FilePlus className="w-4 h-4 text-violet-400" />
                        Page {pageNum}
                     </h3>
                     <div className="flex items-center gap-2">
                       {pageProducts.length > 1 && (
                         <div className="flex items-center bg-white/5 border border-white/10 rounded-lg p-0.5 mr-1">
                           <button onClick={() => sortPageProducts(pageNum, 'price_asc')} title="Sort by price: low to high"
                             className="p-1 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors">
                             <ArrowUp className="w-3 h-3" />
                           </button>
                           <button onClick={() => sortPageProducts(pageNum, 'price_desc')} title="Sort by price: high to low"
                             className="p-1 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors">
                             <ArrowDown className="w-3 h-3" />
                           </button>
                           <button onClick={() => sortPageProducts(pageNum, 'shuffle')} title="Shuffle order"
                             className="p-1 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors">
                             <Shuffle className="w-3 h-3" />
                           </button>
                         </div>
                       )}
                       <button onClick={() => { setCatalogPageTarget(pageNum); setShowCatalog(true) }} className="text-xs font-medium text-white/50 hover:text-white transition-colors flex items-center gap-1">
                         <Search className="w-3 h-3" /> Search past
                       </button>
                     </div>
                   </div>

                   {viewMode === 'list' ? (
                     <div className="space-y-2">
                       {pageProducts.map(p => (
                         <ProductRow
                           key={p._key}
                           product={p}
                           badges={badges}
                           catalog={catalog}
                           catalogImages={catalog.find(c => c.id === p.catalog_id)?.images}
                           onUpdate={updates => updateProduct(p._key, updates)}
                           onRemove={() => removeProduct(p._key)}
                           onUploadImage={file => handleUploadImage(p._key, file)}
                           uploading={false}
                           onDuplicate={() => duplicateProduct(p._key)}
                           onAddNext={() => addBlankProduct(pageNum)}
                         />
                       ))}
                     </div>
                   ) : (
                     <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                       {pageProducts.map(p => (
                         <ProductGridCard
                           key={p._key}
                           product={p}
                           badges={badges}
                           catalogImages={catalog.find(c => c.id === p.catalog_id)?.images}
                           onUpdate={updates => updateProduct(p._key, updates)}
                           onRemove={() => removeProduct(p._key)}
                           onUploadImage={file => handleUploadImage(p._key, file)}
                           uploading={false}
                         />
                       ))}
                     </div>
                   )}
                   
                   <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/5">
                      <button onClick={() => addBlankProduct(pageNum)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-violet-600/20 text-violet-300 hover:bg-violet-600/40 transition-colors">
                        <Plus className="w-4 h-4" /> Add product
                      </button>
                      
                      {pageProducts.length > 0 && (
                        <button onClick={() => duplicateProduct(pageProducts[pageProducts.length - 1]._key)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors">
                          <CopyPlus className="w-3 h-3" /> Duplicate last
                        </button>
                      )}
                   </div>
                 </div>
               )
            })}
          </div>

          {products.length > 0 && (
             <div className="flex justify-center mt-6">
                <button onClick={() => {
                   const maxPage = Math.max(1, ...products.map(p => p.page || 1))
                   addBlankProduct(maxPage + 1)
                }} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-white/5 border border-dashed border-white/20 text-white/60 hover:text-white hover:border-white/40 transition-colors">
                  <FilePlus className="w-4 h-4" /> Add Page {Math.max(1, ...products.map(p => p.page || 1)) + 1}
                </button>
             </div>
          )}
        </div>

       <div className="max-w-2xl mx-auto">
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
      </div>

      {/* Bulk Paste modal */}
      {bulkPasteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-[#1a1a24] border border-white/10 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90dvh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
              <div>
                <h2 className="font-bold text-white/90 flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-violet-400" /> Bulk Paste</h2>
                <p className="text-xs text-white/40 mt-0.5">
                  {bulkPasteReview ? 'Review what was found — uncheck or edit anything before adding.' : 'Paste your product list — one product per line, any format.'}
                </p>
              </div>
              <button onClick={() => setBulkPasteOpen(false)} className="p-1.5 rounded-lg hover:bg-white/10 text-white/50"><X className="w-4 h-4" /></button>
            </div>

            {!bulkPasteReview ? (
              <>
                <div className="p-5 space-y-3 overflow-y-auto">
                  <textarea
                    value={bulkPasteText}
                    onChange={e => setBulkPasteText(e.target.value)}
                    placeholder={'Rice 5kg  350\nSugar 1kg  42\nEastern Chilli Powder 500gm  109.90'}
                    rows={10}
                    autoFocus
                    className={`${inputCls} resize-none font-mono`}
                  />
                </div>
                <div className="px-5 py-4 border-t border-white/10 flex justify-end gap-2 shrink-0">
                  <button onClick={() => setBulkPasteOpen(false)} className="px-4 py-2 text-sm rounded-xl bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 transition-colors">Cancel</button>
                  <button
                    onClick={runBulkPasteParse}
                    disabled={!bulkPasteText.trim() || bulkPasteBusy}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50 transition-colors"
                  >
                    {bulkPasteBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPaste className="w-4 h-4" />}
                    {bulkPasteBusy ? 'Reading…' : 'Parse Products'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="p-5 space-y-2 overflow-y-auto">
                  {bulkPasteReview.length === 0 ? (
                    <p className="text-sm text-white/40 text-center py-6">No products found.</p>
                  ) : bulkPasteReview.map(row => (
                    <div key={row._key} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${row.include ? 'bg-white/5 border-white/10' : 'bg-transparent border-white/5 opacity-40'}`}>
                      <input type="checkbox" checked={row.include} onChange={e => updateBulkPasteRow(row._key, { include: e.target.checked })} className="accent-violet-500 shrink-0" />
                      <input
                        value={row.name}
                        onChange={e => updateBulkPasteRow(row._key, { name: e.target.value })}
                        placeholder="Product name (include weight, e.g. Rice 5kg)"
                        className="flex-1 min-w-0 bg-transparent text-sm text-white/90 focus:outline-none"
                      />
                      <input
                        type="number"
                        value={row.price ?? ''}
                        onChange={e => updateBulkPasteRow(row._key, { price: e.target.value ? parseFloat(e.target.value) : null })}
                        placeholder="price"
                        className="w-20 shrink-0 bg-white/5 rounded-lg px-2 py-1 text-xs text-white/70 focus:outline-none"
                      />
                      {row.matchedCatalogId && (
                        <span title="Matched an existing catalog product — image will be reused" className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">matched</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="px-5 py-4 border-t border-white/10 flex items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-2 text-xs text-white/50">
                    <span>Add to</span>
                    <select value={bulkPasteTargetPage} onChange={e => setBulkPasteTargetPage(parseInt(e.target.value, 10))}
                      className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-white/80">
                      {Array.from({ length: Math.max(1, ...products.map(p => p.page || 1)) }, (_, i) => i + 1).map(n => (
                        <option key={n} value={n}>Page {n}</option>
                      ))}
                      <option value={Math.max(1, ...products.map(p => p.page || 1)) + 1}>New Page {Math.max(1, ...products.map(p => p.page || 1)) + 1}</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setBulkPasteReview(null)} className="px-4 py-2 text-sm rounded-xl bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 transition-colors">Back</button>
                    <button
                      onClick={confirmBulkPaste}
                      disabled={!bulkPasteReview.some(r => r.include)}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50 transition-colors"
                    >
                      <Plus className="w-4 h-4" /> Add {bulkPasteReview.filter(r => r.include).length} Product{bulkPasteReview.filter(r => r.include).length !== 1 ? 's' : ''}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
