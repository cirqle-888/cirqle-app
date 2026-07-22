'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Plus, Loader2, CheckCircle2, Check, X, ChevronDown, ChevronUp,
  Upload, Search, Calendar, MessageSquare, RefreshCw,
  ImageIcon, ImageOff, Trash2, GripVertical, Copy, FilePlus, CopyPlus, LayoutGrid, List,
  ArrowUp, ArrowDown, Shuffle, Sparkles, ClipboardPaste, Clipboard,
  ArrowLeft, AlertTriangle, FileSpreadsheet, Pencil, SlidersHorizontal, Link2,
  Download, History, Table2, Eraser,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, arrayMove, sortableKeyboardCoordinates,
  verticalListSortingStrategy, rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  saveCampaign, getImageUploadUrl, aiParseProductList, cancelCampaign,
  cloneLastCampaign, getCampaignSyncStatus, resyncOfferSheet, fetchExternalImage,
  type ProductInput, type ProductBadgeInput, type CampaignInput, type OfferGroupOption,
} from './actions'
import type { ParsedOfferProduct } from '@/lib/ai/offer-capture'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { FigmaBindingHelp } from '@/components/offer/figma-binding-help'
import { IntakeAppSwitcher } from '@/components/intake/app-switcher'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

import { useValidationEngine } from './components/useValidationEngine'
import { ValidationPanel } from './components/ValidationPanel'
import { useKeyboardShortcuts } from './components/useKeyboardShortcuts'
import { buildOfferSheetRows, offerSheetTsv, offerSheetCsv } from '@/lib/offer-sheet'
import { formatProductName, type NameCaseMode } from '@/lib/format-product-name'

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
  group_id?: string | null
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

function isPublicImageUrl(value: string | undefined | null) {
  try {
    const url = new URL(value || '')
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

// Google Drive / Dropbox *share* links (the "…/view", "?dl=0" pages) are HTML
// viewers, not hotlinkable image bytes — they load in a browser but break in
// Google Sheets IMAGE()/the Figma plugin. Flag them so the user swaps in a
// direct image URL before it silently produces a blank flyer cell.
function isFragileImageShareLink(value: string | undefined | null): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'drive.google.com' || host === 'docs.google.com') return true
    if (host.endsWith('dropbox.com') && !host.startsWith('dl.')) return true
    return false
  } catch {
    return false
  }
}

// Pull an image off the clipboard (e.g. a pasted screenshot) as a File the
// existing signed-upload path can consume. Returns null when the clipboard has
// no image or the browser doesn't support async clipboard reads.
async function readImageFromClipboard(): Promise<File | null> {
  try {
    if (!navigator.clipboard?.read) return null
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'))
      if (type) {
        const blob = await item.getType(type)
        const ext = type.split('/')[1] || 'png'
        return new File([blob], `pasted-${Date.now()}.${ext}`, { type })
      }
    }
  } catch {
    /* clipboard permission denied or unsupported — caller shows a hint */
  }
  return null
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy clipboard fallback */ }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  } catch {
    return false
  }
}

// ── Split price input (Price 1 / Price 2) ────────────────────────────────────
// Prices are entered and shown as two parts everywhere, mirroring the flyer
// design and the sheet's Price 1 / Price 2 columns: big rupees, small paisa
// ("49" + "99" = ₹49.99). Typing/pasting "49.99" into the rupee box still
// works — it splits automatically. Both parts write back to the single
// numeric `price`, so saving, validation, and the sheet output are unchanged.

function SplitPriceInput({
  value, onChange, onKeyDown, wholeId, wholeCls, paiseCls, placeholder = 'Price',
}: {
  value: number | null | undefined
  onChange: (v: number | null) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  wholeId?: string
  wholeCls: string
  paiseCls: string
  placeholder?: string
}) {
  const wholeNum = value == null ? null : Math.trunc(value)
  const paiseNum = value == null ? 0 : Math.round((value - Math.trunc(value)) * 100)

  function setWhole(text: string) {
    const t = text.trim()
    if (!t) { onChange(null); return }
    if (t.includes('.')) {
      const f = parseFloat(t)
      onChange(Number.isNaN(f) ? null : f)
      return
    }
    const n = parseInt(t, 10)
    if (Number.isNaN(n)) return
    onChange(n + paiseNum / 100)
  }

  function setPaise(text: string) {
    const digits = text.replace(/\D/g, '').slice(0, 2)
    const p = digits ? parseInt(digits, 10) : 0
    onChange((wholeNum ?? 0) + p / 100)
  }

  return (
    <span className="inline-flex items-baseline gap-0.5 min-w-0">
      <input
        id={wholeId}
        type="text"
        inputMode="decimal"
        value={wholeNum == null ? '' : String(wholeNum)}
        onChange={e => setWhole(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={wholeCls}
      />
      <span className="text-white/25 text-[10px] shrink-0 select-none">.</span>
      <input
        type="text"
        inputMode="numeric"
        maxLength={2}
        value={paiseNum ? String(paiseNum) : ''}
        onChange={e => setPaise(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="99"
        title="Paise (Price 2) — shown smaller in the flyer design"
        className={paiseCls}
      />
    </span>
  )
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

/**
 * A stable fingerprint of everything a save would persist, used to tell whether
 * the editor holds unsaved work.
 *
 * Deliberately excludes `id` and `_key`: the server hands back row ids after a
 * save and the editor adopts them, which must NOT read as a fresh edit.
 * Position matters (it becomes display_order), so this is order-sensitive.
 */
function offerSignature(
  header: {
    title: string
    dateType: 'single' | 'range'
    offerDate: string
    offerDateFrom: string
    offerDateTo: string
  },
  products: (ProductInput & { _key?: string })[],
): string {
  return JSON.stringify([
    header.title.trim(),
    header.dateType,
    header.dateType === 'single' ? header.offerDate : '',
    header.dateType === 'range' ? header.offerDateFrom : '',
    header.dateType === 'range' ? header.offerDateTo : '',
    products.map(p => [
      p.name.trim(),
      p.weight?.trim() || '',
      p.image_url || '',
      p.offer_type,
      p.price ?? '',
      p.mrp ?? '',
      p.offer_text?.trim() || '',
      p.page || 1,
      p.group_id || '',
      (p.badges || []).map(b => [b.badge_id || '', b.custom_label || '', b.color]),
    ]),
  ])
}

// ── Product Row ───────────────────────────────────────────────────────────────

function ProductRow({
  product, badges, catalog, catalogImages, onUpdate, onRemove, onUploadImage, uploading,
  onDuplicate, onAddNext, selected, onToggleSelect,
  setDragNodeRef, dragStyle, dragHandle, isDragging, onRemoveBg,
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
  selected?: boolean
  onToggleSelect?: () => void
  setDragNodeRef?: (el: HTMLElement | null) => void
  dragStyle?: React.CSSProperties
  dragHandle?: React.ReactNode
  isDragging?: boolean
  onRemoveBg?: (imageUrl: string) => Promise<string | null>
}) {
  const [imgUploading, setImgUploading] = useState(false)
  const [bgBusy, setBgBusy] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [customBadgeOpen, setCustomBadgeOpen] = useState(false)
  const [customLabel, setCustomLabel] = useState('')
  const [customColor, setCustomColor] = useState('amber')
  const [isExpanded, setIsExpanded] = useState(false)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [showImgMenu, setShowImgMenu] = useState(false)
  const [showImageUrl, setShowImageUrl] = useState(false)
  const [pasteMsg, setPasteMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Paste a screenshot / copied image straight onto this product.
  async function handlePasteImage() {
    setShowImgMenu(false)
    setPasteMsg(null)
    setImgUploading(true)
    const file = await readImageFromClipboard()
    if (!file) {
      setImgUploading(false)
      setPasteMsg('No image found on the clipboard. Copy an image first, then Paste image.')
      setTimeout(() => setPasteMsg(null), 5000)
      return
    }
    const url = await onUploadImage(file)
    if (url) onUpdate({ image_url: url })
    setImgUploading(false)
  }

  // Cut the product out of its background (on-device AI) and save the PNG.
  async function handleRemoveBg() {
    if (!product.image_url || !onRemoveBg || bgBusy) return
    setShowImgMenu(false)
    setBgBusy(true)
    const url = await onRemoveBg(product.image_url)
    if (url) onUpdate({ image_url: url })
    setBgBusy(false)
  }

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
    <div
      ref={setDragNodeRef}
      style={dragStyle}
      id={`product-row-${product._key}`}
      className={`bg-white/5 border ${isExpanded ? 'border-white/20 shadow-xl' : 'border-white/10 hover:border-white/15'} ${selected ? 'border-violet-500/50 bg-violet-500/5' : ''} ${isDragging ? 'opacity-80 shadow-2xl ring-1 ring-violet-500/40' : ''} rounded-2xl transition-all relative ${showAutocomplete ? 'z-20' : 'z-10'}`}
    >
      {/* ── Collapsed / Header ── */}
      <div className="flex items-center gap-2 p-3">
        {dragHandle ?? <GripVertical className="w-4 h-4 text-white/20 shrink-0" />}

        {onToggleSelect && (
          <input 
            type="checkbox" 
            checked={!!selected}
            onChange={onToggleSelect}
            className="w-4 h-4 shrink-0 rounded border-white/20 bg-black/20 accent-violet-500 focus:ring-violet-500/30 cursor-pointer"
          />
        )}
        
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
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-white/30 text-xs font-medium shrink-0">₹</span>
            <SplitPriceInput
              value={product.price}
              onChange={price => onUpdate({ price })}
              onKeyDown={e => {
                 if (e.key === 'Enter') {
                   e.preventDefault()
                   onAddNext()
                 }
              }}
              placeholder="Price"
              wholeCls="bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm focus:outline-none placeholder:text-white/20 w-full min-w-0"
              paiseCls="bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-1 py-1 text-xs text-white/70 focus:outline-none placeholder:text-white/15 w-7 shrink-0"
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
                     <button
                       onClick={() => { setIsExpanded(true); void handlePasteImage() }}
                       className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 hover:text-white flex items-center gap-2"
                     >
                       <Clipboard className="w-3.5 h-3.5" /> Paste image
                     </button>
                     <button
                       onClick={() => { setShowImgMenu(false); setIsExpanded(true); setShowImageUrl(true); }}
                       className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 hover:text-white flex items-center gap-2"
                     >
                       <Link2 className="w-3.5 h-3.5" /> Use public link
                     </button>
                     {onRemoveBg && (
                       <button
                         onClick={handleRemoveBg}
                         disabled={bgBusy}
                         className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 hover:text-white flex items-center gap-2 disabled:opacity-50"
                       >
                         {bgBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />}
                         {bgBusy ? 'Removing…' : 'Remove background'}
                       </button>
                     )}
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
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Page</label>
              <input
                type="number" min={1}
                value={product.page ?? 1}
                onChange={e => onUpdate({ page: Math.max(1, parseInt(e.target.value) || 1) })}
                className={inputCls}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Weight/Unit <span className="text-white/30">(optional)</span></label>
              <input
                type="text"
                value={product.weight ?? ''}
                onChange={e => onUpdate({ weight: e.target.value })}
                className={inputCls}
                placeholder="e.g. 500gm, 1kg, 2L"
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
                    <button key={c} onClick={() => setCustomColor(c)} aria-label={`Badge color ${c}`}
                      className={`w-3 h-3 rounded-full border ${customColor === c ? 'ring-1 ring-white/50' : ''} ${BADGE_COLOR[c].split(' ')[0]}`} />
                  ))}
                  <button onClick={addCustomBadge} aria-label="Add badge" className="text-emerald-400 hover:text-emerald-300"><Check className="w-3 h-3" /></button>
                  <button onClick={() => setCustomBadgeOpen(false)} aria-label="Cancel adding badge" className="text-white/30 hover:text-white/60"><X className="w-3 h-3" /></button>
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
              <button
                onClick={handlePasteImage}
                disabled={imgUploading}
                title="Paste a copied image or screenshot from your clipboard"
                className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 hover:border-white/20 text-white/50 flex items-center gap-1.5 disabled:opacity-40"
              >
                <Clipboard className="w-3 h-3" /> Paste
              </button>
              {!!catalogImages?.length && catalogImages.length > 1 && (
                <button onClick={() => setShowGallery(g => !g)}
                  className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 hover:border-white/20 text-white/50 flex items-center gap-1.5">
                  <ImageIcon className="w-3 h-3" /> Past photos
                </button>
              )}
              {product.image_url && onRemoveBg && (
                <button
                  onClick={handleRemoveBg}
                  disabled={bgBusy || imgUploading}
                  title="Cut the product out of its background (runs on your device) and save as a transparent PNG"
                  className="px-3 py-1.5 rounded-lg text-xs bg-violet-500/10 border border-violet-500/25 hover:border-violet-500/50 text-violet-300 flex items-center gap-1.5 disabled:opacity-40"
                >
                  {bgBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eraser className="w-3 h-3" />}
                  {bgBusy ? 'Removing…' : 'Remove BG'}
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            </div>
            {pasteMsg && <p className="mt-1.5 text-[11px] text-amber-300">{pasteMsg}</p>}
            <div className="mt-3">
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <label className={labelCls + ' mb-0'}>Public image link</label>
                <button
                  type="button"
                  onClick={() => setShowImageUrl(value => !value)}
                  className="text-[11px] text-violet-300 hover:text-violet-200"
                >
                  {showImageUrl ? 'Hide link' : 'Paste link instead'}
                </button>
              </div>
              {showImageUrl && (
                <>
                  <input
                    type="url"
                    value={product.image_url || ''}
                    onChange={e => onUpdate({ image_url: e.target.value.trim() })}
                    placeholder="https://…/product-photo.jpg"
                    aria-invalid={!!product.image_url && !isPublicImageUrl(product.image_url)}
                    className={inputCls}
                  />
                  <p className={`mt-1.5 text-[11px] ${product.image_url && (!isPublicImageUrl(product.image_url) || isFragileImageShareLink(product.image_url)) ? 'text-amber-300' : 'text-white/35'}`}>
                    {product.image_url && !isPublicImageUrl(product.image_url)
                      ? 'Use a public http(s) image URL so Google Sheets and Figma can load it.'
                      : product.image_url && isFragileImageShareLink(product.image_url)
                        ? 'This looks like a Drive/Dropbox share link — it won’t load in Figma. Open the image and use its direct URL.'
                        : 'Use a public direct image URL. It will be sent to Google Sheets and Figma unchanged.'}
                  </p>
                </>
              )}
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
  product, badges, catalogImages, onUpdate, onRemove, onUploadImage, uploading, selected, onToggleSelect,
  setDragNodeRef, dragStyle, dragHandle, isDragging, onRemoveBg,
}: {
  product: any
  badges: Badge[]
  catalogImages?: CatalogImage[]
  onUpdate: (updates: Partial<ProductInput>) => void
  onRemove: () => void
  onUploadImage: (file: File) => Promise<string | null>
  uploading: boolean
  selected?: boolean
  onToggleSelect?: () => void
  setDragNodeRef?: (el: HTMLElement | null) => void
  dragStyle?: React.CSSProperties
  dragHandle?: React.ReactNode
  isDragging?: boolean
  onRemoveBg?: (imageUrl: string) => Promise<string | null>
}) {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [imgUploading, setImgUploading] = useState(false)
  const [bgBusy, setBgBusy] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const [showImageUrl, setShowImageUrl] = useState(false)
  const [pasteMsg, setPasteMsg] = useState<string | null>(null)
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

  async function handlePasteImage() {
    setPasteMsg(null)
    setImgUploading(true)
    const file = await readImageFromClipboard()
    if (!file) {
      setImgUploading(false)
      setPasteMsg('No image on the clipboard.')
      setTimeout(() => setPasteMsg(null), 4000)
      return
    }
    const url = await onUploadImage(file)
    if (url) onUpdate({ image_url: url })
    setImgUploading(false)
  }

  async function handleRemoveBg() {
    if (!product.image_url || !onRemoveBg || bgBusy) return
    setBgBusy(true)
    const url = await onRemoveBg(product.image_url)
    if (url) onUpdate({ image_url: url })
    setBgBusy(false)
  }

  return (
    <>
      <div
        ref={setDragNodeRef}
        style={dragStyle}
        id={`product-grid-${product._key}`}
        className={`bg-white/5 border ${selected ? 'border-violet-500/50 bg-violet-500/5' : 'border-white/10 hover:border-white/20'} ${isDragging ? 'opacity-80 shadow-2xl ring-1 ring-violet-500/40' : ''} rounded-2xl overflow-hidden shadow-lg flex flex-col transition-all relative`}
      >
        <div className="absolute top-2 left-2 z-30 flex gap-1 items-center">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={!!selected}
              onChange={onToggleSelect}
              className="w-4 h-4 shrink-0 rounded border-white/20 bg-black/20 accent-violet-500 focus:ring-violet-500/30 cursor-pointer ml-1"
            />
          )}
          {dragHandle}
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
             <button onClick={handlePasteImage} className="p-2 bg-white/20 hover:bg-white/40 rounded-full text-white transition-colors" disabled={imgUploading} title="Paste image from clipboard">
               <Clipboard className="w-4 h-4" />
             </button>
             <button onClick={() => setShowImageUrl(value => !value)} className="p-2 bg-white/20 hover:bg-white/40 rounded-full text-white transition-colors" title="Use public image link">
               <Link2 className="w-4 h-4" />
             </button>
             {product.image_url && onRemoveBg && (
               <button onClick={handleRemoveBg} disabled={bgBusy} className="p-2 bg-violet-500/40 hover:bg-violet-500/70 rounded-full text-white transition-colors disabled:opacity-50" title="Remove background (on-device AI)">
                 {bgBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eraser className="w-4 h-4" />}
               </button>
             )}
             {!!catalogImages?.length && catalogImages.length > 1 && (
               <button onClick={() => setShowGallery(g => !g)} className="p-2 bg-white/20 hover:bg-white/40 rounded-full text-white transition-colors" title="Past photos"><ImageIcon className="w-4 h-4"/></button>
             )}
          </div>

          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />

          {showImageUrl && (
            <div className="absolute inset-x-2 bottom-2 z-40 rounded-xl border border-white/15 bg-[#12121b]/95 p-2 shadow-xl backdrop-blur">
              <div className="flex gap-1.5">
                <input
                  type="url"
                  value={product.image_url || ''}
                  onChange={e => onUpdate({ image_url: e.target.value.trim() })}
                  placeholder="Paste public image URL…"
                  aria-label="Public product image URL"
                  className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-xs text-white outline-none focus:border-violet-400"
                />
                <button onClick={() => setShowImageUrl(false)} className="rounded-lg px-2 text-xs text-white/60 hover:bg-white/10">Done</button>
              </div>
              {product.image_url && !isPublicImageUrl(product.image_url) && <p className="mt-1 text-[10px] text-amber-300">Use a public http(s) image URL for Figma.</p>}
              {product.image_url && isPublicImageUrl(product.image_url) && isFragileImageShareLink(product.image_url) && (
                <p className="mt-1 text-[10px] text-amber-300">Drive/Dropbox share link — won’t load in Figma. Use a direct image URL.</p>
              )}
              {pasteMsg && <p className="mt-1 text-[10px] text-amber-300">{pasteMsg}</p>}
            </div>
          )}
          {pasteMsg && !showImageUrl && (
            <div className="absolute inset-x-2 bottom-2 z-40 rounded-lg bg-black/70 px-2 py-1 text-[10px] text-amber-300 backdrop-blur">{pasteMsg}</div>
          )}
          
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
            placeholder="Product name"
          />
          <input
            value={product.weight ?? ''}
            onChange={e => onUpdate({ weight: e.target.value })}
            className="bg-transparent text-white/50 text-[11px] leading-snug w-full focus:outline-none focus:bg-white/10 hover:bg-white/5 rounded px-1 -mx-1 mt-1 transition-colors"
            placeholder="Weight/Unit (e.g. 500gm)"
          />
          <div className="mt-auto pt-3 flex items-end justify-between gap-2">
             <div className="shrink-0 flex items-center gap-0.5">
               <span className="text-emerald-400 font-bold text-[11px] mb-0.5">₹</span>
               <SplitPriceInput
                 value={product.price}
                 onChange={price => onUpdate({ price })}
                 placeholder="Price"
                 wholeCls="bg-transparent font-bold text-emerald-400 text-sm w-10 focus:outline-none focus:bg-white/10 hover:bg-white/5 rounded px-1 py-0.5 transition-colors"
                 paiseCls="bg-transparent font-semibold text-emerald-400/80 text-[10px] w-5 focus:outline-none focus:bg-white/10 hover:bg-white/5 rounded px-0.5 py-0.5 transition-colors placeholder:text-emerald-400/25"
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

// ── Sortable wrappers (drag-reorder within a single page) ───────────────────────
// Each page renders its own DndContext, so a drag can only reorder within that
// page — moving a product across pages is the "Move page" bulk op, not drag.
// The grip is the only drag handle, so clicks in the product's inputs never
// start a drag. Reorder is disabled while a view filter is active.

type SortableRowProps = Omit<
  React.ComponentProps<typeof ProductRow>,
  'setDragNodeRef' | 'dragStyle' | 'dragHandle' | 'isDragging'
> & { canReorder: boolean }

function SortableProductRow({ canReorder, ...rowProps }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: rowProps.product._key, disabled: !canReorder })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 40 } : {}),
  }
  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label="Drag to reorder"
      title={canReorder ? 'Drag to reorder' : 'Turn off filters to reorder'}
      className={`shrink-0 rounded p-0.5 -ml-1 text-white/25 hover:text-white/60 ${canReorder ? 'cursor-grab active:cursor-grabbing touch-none' : 'cursor-not-allowed opacity-40'}`}
    >
      <GripVertical className="w-4 h-4" />
    </button>
  )
  return <ProductRow {...rowProps} setDragNodeRef={setNodeRef} dragStyle={style} dragHandle={handle} isDragging={isDragging} />
}

type SortableGridProps = Omit<
  React.ComponentProps<typeof ProductGridCard>,
  'setDragNodeRef' | 'dragStyle' | 'dragHandle' | 'isDragging'
> & { canReorder: boolean }

function SortableProductGridCard({ canReorder, ...cardProps }: SortableGridProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: cardProps.product._key, disabled: !canReorder })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 40 } : {}),
  }
  const handle = canReorder ? (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label="Drag to reorder"
      title="Drag to reorder"
      className="p-1.5 bg-black/40 hover:bg-black/70 rounded text-white/50 hover:text-white backdrop-blur-md transition-colors cursor-grab active:cursor-grabbing touch-none"
    >
      <GripVertical className="w-3.5 h-3.5" />
    </button>
  ) : null
  return <ProductGridCard {...cardProps} setDragNodeRef={setNodeRef} dragStyle={style} dragHandle={handle} isDragging={isDragging} />
}

// ── Table (spreadsheet) view ─────────────────────────────────────────────────
// A Google-Sheet-like grid: one flat row per product, columns mirroring the
// designer sheet (Page, #, Product, Weight, Type, Price, MRP, Offer text,
// Badges, Image). Cells edit inline; Enter jumps to the same column on the
// next row (adding a row when at the bottom), so clients who think in
// spreadsheets can type products in cell-by-cell exactly like Sheets.

const tdCellCls = 'bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-md px-2 py-1.5 text-sm focus:outline-none placeholder:text-white/20 w-full'

function ProductTableView({
  products, badges, onUpdate, onRemove, onAddRow, onUploadImage,
  selectedKeys, onToggleSelect,
}: {
  products: (ProductInput & { _key: string; id?: string })[]
  badges: Badge[]
  onUpdate: (key: string, updates: Partial<ProductInput>) => void
  onRemove: (key: string) => void
  onAddRow: (page: number) => void
  onUploadImage: (key: string, file: File) => Promise<string | null>
  selectedKeys: Set<string>
  onToggleSelect: (key: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadRowRef = useRef<string | null>(null)
  const [uploadingKey, setUploadingKey] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  // Flat sheet order: page, then display order — same as the exported sheet.
  const rows = [...products].sort((a, b) =>
    (a.page || 1) - (b.page || 1) || a.display_order - b.display_order)

  function badgeText(p: ProductInput): string {
    return (p.badges || [])
      .map(b => b.custom_label || (b.badge_id ? badges.find(x => x.id === b.badge_id)?.label : ''))
      .filter(Boolean)
      .join(', ')
  }

  // Comma-separated labels → badge inputs (predefined match by label, else custom).
  function parseBadges(text: string): ProductBadgeInput[] {
    return text.split(',').map(s => s.trim()).filter(Boolean).map(label => {
      const known = badges.find(b => b.label.toLowerCase() === label.toLowerCase())
      return known
        ? { badge_id: known.id, color: known.color }
        : { custom_label: label, color: 'amber' }
    })
  }

  // Enter = same column, next row (spreadsheet muscle memory). On the last row
  // it creates a new one; focus lands after React renders it.
  function handleEnter(e: React.KeyboardEvent, col: string, idx: number) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (idx + 1 >= rows.length) onAddRow(rows[rows.length - 1]?.page || 1)
    window.setTimeout(() => {
      document.getElementById(`tcell-${col}-${idx + 1}`)?.focus()
    }, 30)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const key = uploadRowRef.current
    e.target.value = ''
    if (!file || !key) return
    setUploadingKey(key)
    const url = await onUploadImage(key, file)
    if (url) onUpdate(key, { image_url: url })
    setUploadingKey(null)
  }

  return (
    <div className="bg-[#1a1a24] border border-white/10 rounded-3xl shadow-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-white/30 border-b border-white/10">
              <th className="px-2 py-2.5 w-8"></th>
              <th className="px-2 py-2.5 w-12 text-left">Page</th>
              <th className="px-2 py-2.5 w-8 text-left">#</th>
              <th className="px-2 py-2.5 text-left min-w-[220px]">Product</th>
              <th className="px-2 py-2.5 w-24 text-left">Weight</th>
              <th className="px-2 py-2.5 w-24 text-left">Type</th>
              <th className="px-2 py-2.5 w-24 text-right">Price ₹</th>
              <th className="px-2 py-2.5 w-24 text-right">MRP ₹</th>
              <th className="px-2 py-2.5 w-32 text-left">Offer text</th>
              <th className="px-2 py-2.5 w-36 text-left">Badges</th>
              <th className="px-2 py-2.5 w-14 text-left">Image</th>
              <th className="px-2 py-2.5 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, idx) => (
              <tr key={p._key} className={`border-b border-white/5 last:border-0 ${selectedKeys.has(p._key) ? 'bg-violet-500/5' : ''}`}>
                <td className="px-2 py-1 align-middle">
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(p._key)}
                    onChange={() => onToggleSelect(p._key)}
                    className="w-3.5 h-3.5 rounded accent-violet-500 cursor-pointer"
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <input
                    id={`tcell-page-${idx}`}
                    type="number" min={1}
                    value={p.page ?? 1}
                    onChange={e => onUpdate(p._key, { page: Math.max(1, parseInt(e.target.value) || 1) })}
                    onKeyDown={e => handleEnter(e, 'page', idx)}
                    className={tdCellCls + ' text-center'}
                  />
                </td>
                <td className="px-2 py-1 text-white/30 text-xs align-middle">{idx + 1}</td>
                <td className="px-1 py-1 align-middle">
                  <input
                    id={`tcell-name-${idx}`}
                    value={p.name}
                    onChange={e => onUpdate(p._key, { name: e.target.value })}
                    onKeyDown={e => handleEnter(e, 'name', idx)}
                    placeholder="Product name"
                    className={tdCellCls + ' font-medium text-white/90'}
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <input
                    id={`tcell-weight-${idx}`}
                    value={p.weight ?? ''}
                    onChange={e => onUpdate(p._key, { weight: e.target.value })}
                    onKeyDown={e => handleEnter(e, 'weight', idx)}
                    placeholder="—"
                    className={tdCellCls}
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <select
                    value={p.offer_type}
                    onChange={e => onUpdate(p._key, { offer_type: e.target.value as ProductInput['offer_type'] })}
                    className="bg-white/5 border border-white/10 rounded-md px-1.5 py-1.5 text-xs text-white/80 focus:outline-none focus:border-violet-500/50 w-full"
                  >
                    <option value="price">₹ Price</option>
                    <option value="percent">% Off</option>
                    <option value="bogo">B1G1</option>
                    <option value="other">Other</option>
                  </select>
                </td>
                <td className="px-1 py-1 align-middle">
                  <SplitPriceInput
                    value={p.price}
                    onChange={price => onUpdate(p._key, { price })}
                    onKeyDown={e => handleEnter(e, 'price', idx)}
                    placeholder="—"
                    wholeId={`tcell-price-${idx}`}
                    wholeCls={tdCellCls + ' text-right font-semibold text-emerald-400 min-w-0'}
                    paiseCls="bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-md px-1 py-1 text-[11px] text-emerald-400/80 focus:outline-none placeholder:text-white/15 w-7 shrink-0"
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <input
                    id={`tcell-mrp-${idx}`}
                    type="number" step="0.01" min="0"
                    value={p.mrp ?? ''}
                    onChange={e => onUpdate(p._key, { mrp: e.target.value ? parseFloat(e.target.value) : null })}
                    onKeyDown={e => handleEnter(e, 'mrp', idx)}
                    placeholder="—"
                    className={tdCellCls + ' text-right text-white/50'}
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  <input
                    id={`tcell-text-${idx}`}
                    value={p.offer_text ?? ''}
                    onChange={e => onUpdate(p._key, { offer_text: e.target.value })}
                    onKeyDown={e => handleEnter(e, 'text', idx)}
                    placeholder="—"
                    className={tdCellCls + ' text-xs'}
                  />
                </td>
                <td className="px-1 py-1 align-middle">
                  {/* Uncontrolled + commit on blur/Enter: retyping "Fresh, Hot" mid-comma
                      would fight a controlled value that re-joins parsed badges. */}
                  <input
                    id={`tcell-badges-${idx}`}
                    key={`${p._key}-${badgeText(p)}`}
                    defaultValue={badgeText(p)}
                    onBlur={e => onUpdate(p._key, { badges: parseBadges(e.target.value) })}
                    onKeyDown={e => {
                      if (e.key === 'Enter') onUpdate(p._key, { badges: parseBadges((e.target as HTMLInputElement).value) })
                      handleEnter(e, 'badges', idx)
                    }}
                    placeholder="e.g. Hot, Fresh"
                    className={tdCellCls + ' text-xs text-amber-300'}
                  />
                </td>
                <td className="px-2 py-1 align-middle">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { uploadRowRef.current = p._key; fileRef.current?.click() }}
                      title={p.image_url ? 'Change image' : 'Upload image'}
                      className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 overflow-hidden flex items-center justify-center hover:ring-2 hover:ring-violet-500/50 transition-all shrink-0"
                    >
                      {uploadingKey === p._key ? (
                        <Loader2 className="w-3.5 h-3.5 text-white/40 animate-spin" />
                      ) : p.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.image_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageOff className="w-3.5 h-3.5 text-white/25" />
                      )}
                    </button>
                    {p.image_url && (
                      <button onClick={() => setLightbox(p.image_url!)} title="View larger"
                        className="p-1 rounded text-white/25 hover:text-white/70">
                        <Search className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1 align-middle">
                  <button onClick={() => onRemove(p._key)} title="Remove row"
                    className="p-1.5 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3 border-t border-white/10 flex items-center justify-between">
        <button
          onClick={() => onAddRow(rows[rows.length - 1]?.page || 1)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-violet-600/20 text-violet-300 hover:bg-violet-600/40 transition-colors"
        >
          <Plus className="w-4 h-4" /> Add row
        </button>
        <p className="text-[11px] text-white/30">Enter ↵ moves down a row · badges are comma-separated</p>
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      {lightbox && <ImageLightbox src={lightbox} alt="Product" onClose={() => setLightbox(null)} />}
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

function OfferIntakeClientInner({
  token, client, campaign: initialCampaign, catalog, badges, groups = [], sheetManaged = false,
  logoUrl, logoDarkUrl, switcher, hub, staff, flowMode = 'push',
}: {
  token: string
  client: { id: string; name: string }
  campaign: Campaign | null
  catalog: CatalogItem[]
  badges: Badge[]
  /**
   * The client's offer categories (Groceries, Vegetables, …). Empty or a single
   * entry means this client has one flyer stream, and the editor renders
   * exactly as it did before categories existed.
   */
  groups?: OfferGroupOption[]
  /** Campaign mirrors the client's own Google Sheet — read-only here. */
  sheetManaged?: boolean
  logoUrl?: string | null
  logoDarkUrl?: string | null
  switcher?: { kind: string; label: string; href: string }[]
  hub?: string
  /** True on the internal staff entrance (/dashboard/offer-prepare); shows the Google Sheet sync status. */
  staff?: boolean
  /**
   * How this client's designer sheet is maintained. Only 'push' means Cirqle
   * writes it — the others must not start a sync poll that can never succeed.
   * Defaults to 'push', the historical behaviour, when not supplied.
   */
  flowMode?: 'push' | 'pull' | 'manual'
}) {
  const router = useRouter()
  type LocalProduct = ProductInput & { _key: string; id?: string }

  // Build the editor's product rows from the loaded active campaign.
  function initialProducts(): LocalProduct[] {
    return (initialCampaign?.products || [])
      .slice()
      .sort((a, b) => a.display_order - b.display_order)
      .map((p, i) => ({ ...p, _key: p.id, display_order: i }))
  }

  // Weekly-offer decision: on the STAFF entrance, if the client already has an
  // active campaign with products, we must NOT auto-load/merge it — the
  // coordinator first chooses Start New / Continue / Start From Last Week. The
  // public client entrance just continues its own offer as before.
  const needsCampaignDecision = !!staff && !!initialCampaign && (initialCampaign.products?.length ?? 0) > 0
  const [pendingDecision, setPendingDecision] = useState(needsCampaignDecision)

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
  // Empty while a decision is pending — the modal populates it on the choice.
  const [products, setProducts] = useState<LocalProduct[]>(() =>
    needsCampaignDecision ? [] : initialProducts()
  )

  const validation = useValidationEngine(products)

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  const toggleSelect = useCallback((key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const selectAll = useCallback((keysToSelect: string[]) => {
    setSelectedKeys(new Set(keysToSelect))
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set())
  }, [])

  // ── UI state ────────────────────────────────────────────────────────────────
  const [showCatalog, setShowCatalog] = useState(false)
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'table'>('list')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [campaignId, setCampaignId] = useState<string | undefined>(
    needsCampaignDecision ? undefined : initialCampaign?.id
  )
  const [cancelling, setCancelling] = useState(false)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const [showMissingImagesOnly, setShowMissingImagesOnly] = useState(false)

  // ── Offer categories ────────────────────────────────────────────────────────
  // Only a client with MORE THAN ONE category gets tabs; one (or none) keeps the
  // pre-categories editor exactly as it was. `activeGroupId` then narrows
  // visibleProducts, so the page grouping below it needs no changes.
  const showGroupTabs = groups.length > 1
  const [activeGroupId, setActiveGroupId] = useState<string | null>(
    showGroupTabs ? groups[0].id : null,
  )
  // Products saved before a category existed (or whose category was deleted)
  // still have to be reachable, so the first tab adopts them.
  const knownGroupIds = new Set(groups.map(g => g.id))
  const belongsToActiveGroup = (p: LocalProduct) => {
    if (!showGroupTabs) return true
    const isOrphan = !p.group_id || !knownGroupIds.has(p.group_id)
    if (isOrphan) return activeGroupId === groups[0].id
    return p.group_id === activeGroupId
  }
  const [cloning, setCloning] = useState(false)
  // AI Capture merge guard: a whole-list capture into a non-empty offer prompts
  // Replace vs Add; a per-page "AI Capture to Page N" is an intentional add.
  const [bulkApply, setBulkApply] = useState<{ generate: boolean } | null>(null)

  // Google Sheet sync status (staff entrance only) — reflects the fire-and-forget
  // server sync that runs after each save.
  type SyncState = 'idle' | 'saving' | 'syncing' | 'synced' | 'skipped' | 'unknown' | 'error'
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [syncErrorMsg, setSyncErrorMsg] = useState<string | null>(null)
  const syncPollRef = useRef(0)

  // ── Unsaved-work guard ──────────────────────────────────────────────────────
  // There is no autosave: the only way work reaches the server is Save / Ctrl+S.
  // Clients open this link on phones, where a closed tab or a stray Back
  // gesture would otherwise silently discard a whole offer they just built.
  const savingRef = useRef(false)
  // Seeded with the state we loaded FROM the server — that's already saved, so
  // opening the editor and leaving without touching anything must not warn.
  // Null only when the staff decision modal is pending, since nothing is loaded
  // yet; each decision branch sets its own baseline.
  const [savedSignature, setSavedSignature] = useState<string | null>(() =>
    needsCampaignDecision
      ? null
      : offerSignature(
          {
            title: initialCampaign?.title || '',
            dateType: initialCampaign?.date_type || 'single',
            offerDate: initialCampaign?.offer_date || getTomorrowStr(),
            offerDateFrom: initialCampaign?.offer_date_from || getTomorrowStr(),
            offerDateTo: initialCampaign?.offer_date_to || '',
          },
          initialProducts(),
        ),
  )
  const currentSignature = offerSignature(
    { title, dateType, offerDate, offerDateFrom, offerDateTo },
    products,
  )
  // With no baseline (decision still pending) any product at all is unsaved work.
  const hasUnsavedWork = savedSignature === null
    ? products.length > 0
    : currentSignature !== savedSignature

  useEffect(() => {
    if (!hasUnsavedWork) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsavedWork])

  // Drag-reorder sensors (pointer with a small activation distance so clicks on
  // the row's inputs never start a drag; keyboard for accessibility).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const [catalogPageTarget, setCatalogPageTarget] = useState<number>(1)
  // Category the picker was opened from, mirroring catalogPageTarget: the tab
  // can change while the modal is open, and rows must land where the user asked.
  const [catalogGroupTarget, setCatalogGroupTarget] = useState<string | null>(null)

  // ── Bulk paste (AI) — the PRIMARY flow: paste → review → generate sheet ──
  type BulkPasteRow = ParsedOfferProduct & { _key: string; include: boolean; matchedCatalogId?: string }
  const [bulkPasteOpen, setBulkPasteOpen] = useState(false)
  const [bulkPasteText, setBulkPasteText] = useState('')
  const [bulkPasteHint, setBulkPasteHint] = useState('')
  const [hintOpen, setHintOpen] = useState(false)
  const [bulkPasteBusy, setBulkPasteBusy] = useState(false)
  const [bulkPasteReview, setBulkPasteReview] = useState<BulkPasteRow[] | null>(null)
  const [bulkPasteTargetPage, setBulkPasteTargetPage] = useState(1)
  const [bulkPasteGroupTarget, setBulkPasteGroupTarget] = useState<string | null>(null)
  // true when the capture is an intentional "add to this page" (per-page button);
  // false for a whole-list capture (which prompts Replace vs Add if the offer
  // already has products).
  const [bulkPasteAddToPage, setBulkPasteAddToPage] = useState(false)
  // A dashboard AI-Capture draft parked until the weekly-offer decision is made.
  const pendingDraftRef = useRef<BulkPasteRow[] | null>(null)

  function openBulkPaste(targetPage?: number, addToPage = false) {
    setBulkPasteText('')
    setBulkPasteReview(null)
    setBulkPasteAddToPage(addToPage)
    setBulkPasteTargetPage(targetPage ?? Math.max(1, ...products.map(p => p.page || 1)))
    setBulkPasteGroupTarget(activeGroupId)
    setBulkPasteOpen(true)
  }

  // Fuzzy-match parsed names against this client's catalog (already in memory)
  // so a reused product picks up its known image/weight instead of starting
  // blank. Match on the weight-stripped name too — "Bru Coffee 200g" should
  // still find the catalog's "Bru Coffee".
  function toReviewRows(parsed: ParsedOfferProduct[]): BulkPasteRow[] {
    return parsed.map((p, i) => {
      const lower = p.name.toLowerCase()
      const bare = lower.replace(/\s*\d+(?:\.\d+)?\s*(?:gm?|kg|ml|l|ltr|pcs?|pack|nos?)\b/gi, '').trim()
      const match = catalog.find(c => c.name.toLowerCase() === lower)
        || catalog.find(c => c.name.toLowerCase() === bare)
        || catalog.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()))
        || (bare.length > 3 ? catalog.find(c => c.name.toLowerCase().includes(bare) || bare.includes(c.name.toLowerCase())) : undefined)
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
  }

  async function runBulkPasteParse() {
    if (!bulkPasteText.trim()) return
    setBulkPasteBusy(true)
    const res = await aiParseProductList(token, bulkPasteText, bulkPasteHint.trim() || undefined)
    setBulkPasteBusy(false)
    if (res.ok && res.data) {
      setBulkPasteReview(toReviewRows(res.data.products))
    } else {
      setError(res.error || 'Could not parse that text.')
    }
  }

  // Quick Capture handoff: the dashboard's Capture Engine already parsed the
  // pasted text and stashed the draft before navigating here — consume it
  // straight into the review table so the employee doesn't paste twice.
  useEffect(() => {
    let rows: BulkPasteRow[] = []
    try {
      const raw = sessionStorage.getItem('cirqle:capture:draft')
      if (!raw) return
      const draft = JSON.parse(raw)
      if (draft?.type !== 'offer') return
      sessionStorage.removeItem('cirqle:capture:draft')
      const parsed = Array.isArray(draft.fields?.products) ? draft.fields.products : []
      rows = toReviewRows(parsed)
    } catch { /* corrupt draft — ignore */ }
    if (rows.length) {
      if (needsCampaignDecision) {
        // Hold the draft until the coordinator chooses Start New / Continue in
        // the modal, then show the review (see the decision handlers).
        pendingDraftRef.current = rows
      } else {
        // One-time mount handoff from an external store — the review table can
        // only exist after this read, so the extra render is inherent.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setBulkPasteReview(rows)
        setBulkPasteOpen(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updateBulkPasteRow(key: string, updates: Partial<BulkPasteRow>) {
    setBulkPasteReview(prev => prev?.map(r => r._key === key ? { ...r, ...updates } : r) || null)
  }

  /**
   * Confirm the reviewed rows. A whole-list capture into a non-empty offer first
   * asks Replace vs Add (so a new weekly list never silently merges); a per-page
   * "AI Capture to Page N" is an intentional add and skips the prompt.
   */
  function confirmBulkPaste(generate = false) {
    if (!bulkPasteReview) return
    const included = bulkPasteReview.filter(r => r.include && r.name.trim())
    if (!included.length) return
    if (!bulkPasteAddToPage && products.length > 0) {
      setBulkApply({ generate })
      return
    }
    applyBulkPaste('append', generate)
  }

  /**
   * Apply the reviewed rows. 'replace' starts a fresh single-page offer from the
   * captured rows; 'append' adds them to the current list. With `generate` set,
   * it also saves + syncs the sheet in the same click.
   */
  function applyBulkPaste(mode: 'append' | 'replace', generate = false) {
    if (!bulkPasteReview) return
    const included = bulkPasteReview.filter(r => r.include && r.name.trim())
    if (!included.length) return
    const base = mode === 'replace' ? [] : products
    const targetPage = mode === 'replace' ? 1 : bulkPasteTargetPage
    let order = base.length
    const newRows = included.map(r => {
      const match = r.matchedCatalogId ? catalog.find(c => c.id === r.matchedCatalogId) : undefined
      // AI-detected promo tag → a real badge: reuse a predefined badge when the
      // label matches one, otherwise carry it as a custom label.
      const badgeLabel = (r.badge || '').trim()
      const isBogo = /buy\s*1\s*get\s*1|bogo/i.test(badgeLabel)
      const known = badgeLabel && !isBogo
        ? badges.find(b => b.label.toLowerCase() === badgeLabel.toLowerCase())
        : undefined
      const productBadges = badgeLabel && !isBogo
        ? [known
            ? { badge_id: known.id, color: known.color } as ProductBadgeInput
            : { custom_label: badgeLabel, color: 'amber' } as ProductBadgeInput]
        : []
      return {
        _key: `bulk-add-${Date.now()}-${order}`,
        catalog_id: match?.id,
        name: r.name,
        weight: '',
        image_url: match?.image_url || '',
        offer_type: (isBogo ? 'bogo' : 'price') as ProductInput['offer_type'],
        price: r.price ?? null,
        mrp: r.mrp ?? null,
        offer_text: isBogo ? 'Buy 1 Get 1' : '',
        badges: productBadges,
        page: targetPage,
        group_id: bulkPasteGroupTarget,
        display_order: order++,
      }
    })
    const merged = [...base, ...newRows].map((p, i) => ({ ...p, display_order: i }))
    setProducts(merged)
    setBulkApply(null)
    setBulkPasteOpen(false)
    setBulkPasteReview(null)
    setBulkPasteText('')
    if (generate) void saveProducts(merged)
  }

  // ── Weekly-offer decision handlers (staff, when an active campaign exists) ────
  // A parked dashboard-capture draft is shown only AFTER the coordinator chooses,
  // so the modal always comes first.
  function applyPendingDraft() {
    const rows = pendingDraftRef.current
    if (!rows) return
    pendingDraftRef.current = null
    setBulkPasteAddToPage(false)
    setBulkPasteTargetPage(1)
    setBulkPasteReview(rows)
    setBulkPasteOpen(true)
  }

  function chooseContinueOffer() {
    const existing = initialProducts()
    // Continuing loads the campaign exactly as stored, so this becomes the
    // clean baseline — otherwise the unsaved-work guard would fire on an
    // untouched offer. Start New / Start From Last Week deliberately leave the
    // baseline alone: their contents genuinely aren't saved yet.
    setSavedSignature(offerSignature(
      {
        title: initialCampaign?.title || '',
        dateType: initialCampaign?.date_type || 'single',
        offerDate: initialCampaign?.offer_date || getTomorrowStr(),
        offerDateFrom: initialCampaign?.offer_date_from || getTomorrowStr(),
        offerDateTo: initialCampaign?.offer_date_to || '',
      },
      existing,
    ))
    setProducts(existing)
    setCampaignId(initialCampaign?.id)
    setTitle(initialCampaign?.title || '')
    setDateType(initialCampaign?.date_type || 'single')
    setOfferDate(initialCampaign?.offer_date || getTomorrowStr())
    setOfferDateFrom(initialCampaign?.offer_date_from || getTomorrowStr())
    setOfferDateTo(initialCampaign?.offer_date_to || '')
    setHeaderExpanded(!initialCampaign?.title && !initialCampaign?.offer_date)
    setPendingDecision(false)
    applyPendingDraft()
  }

  function resetHeaderForNewOffer() {
    setCampaignId(undefined)   // a new campaign is created on save (old auto-finalised)
    setTitle('')
    setDateType('single')
    setOfferDate(getTomorrowStr())
    setOfferDateFrom(getTomorrowStr())
    setOfferDateTo('')
    setHeaderExpanded(true)
  }

  function chooseStartNewOffer() {
    resetHeaderForNewOffer()
    setProducts([])
    setPendingDecision(false)
    if (pendingDraftRef.current) applyPendingDraft()
    else setBulkPasteOpen(true)
  }

  function chooseStartFromLastWeek() {
    resetHeaderForNewOffer()
    // Clone name/weight/image/badges/page from the current active campaign; blank
    // the offer price (coordinator re-prices). MRP is the product's stable standard
    // price, so it's kept. No ids → these insert as a brand-new campaign on save.
    const cloned: LocalProduct[] = (initialCampaign?.products || [])
      .slice()
      .sort((a, b) => (a.page || 1) - (b.page || 1) || a.display_order - b.display_order)
      .map((p, i) => ({
        _key: `clone-${Date.now()}-${i}`,
        catalog_id: p.catalog_id,
        group_id: p.group_id ?? null,
        name: p.name,
        weight: p.weight || '',
        image_url: p.image_url || '',
        offer_type: p.offer_type,
        price: null,
        mrp: p.mrp ?? null,
        offer_text: '',
        badges: (p.badges || []).map(b => ({ badge_id: b.badge_id || null, custom_label: b.custom_label || null, color: b.color })),
        page: p.page || 1,
        display_order: i,
      }))
    setProducts(cloned)
    setPendingDecision(false)
    applyPendingDraft()
  }

  function cancelDecision() {
    router.push('/dashboard/offer-prepare')
  }

  function addBlankProduct(page: number) {
    const order = products.length
    setProducts(prev => [...prev, { ...emptyProduct(order), page, group_id: activeGroupId }])
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

  // Drag-reorder within a single page: move the dragged product to the drop
  // slot and renumber that page's display_order (other pages untouched),
  // mirroring sortPageProducts so the sheet's Display Order column stays 0..n.
  function reorderPage(pageNum: number, e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setProducts(prev => {
      const pageItems = prev.filter(p => (p.page || 1) === pageNum)
      const otherItems = prev.filter(p => (p.page || 1) !== pageNum)
      const from = pageItems.findIndex(p => p._key === active.id)
      const to = pageItems.findIndex(p => p._key === over.id)
      if (from < 0 || to < 0) return prev
      const reordered = arrayMove(pageItems, from, to)
      return [...otherItems, ...reordered].map((p, i) => ({ ...p, display_order: i }))
    })
  }

  // Load the previous campaign's products (blank prices) so a new week starts
  // from last week instead of a blank page. Shown only when the editor is empty.
  async function handleStartFromLastWeek() {
    setCloning(true); setError('')
    const res = await cloneLastCampaign(token)
    setCloning(false)
    if (!res.ok || !res.data) { setError(res.error || 'No previous offer to copy yet.'); return }
    const rows: LocalProduct[] = res.data.products.map((p, i) => ({
      ...p,
      _key: `clone-${Date.now()}-${i}`,
      display_order: i,
    }))
    setProducts(rows)
    setBulkPasteOpen(false)
    setCopyMessage(`Copied ${rows.length} product${rows.length === 1 ? '' : 's'} from your last offer — just set this week's prices.`)
    window.setTimeout(() => setCopyMessage(null), 6000)
  }

  function removeProduct(key: string) {
    setProducts(prev => prev.filter(p => p._key !== key).map((p, i) => ({ ...p, display_order: i })))
  }

  // ── Bulk operations on the current selection ────────────────────────────────
  // These power both the selection toolbar and the keyboard shortcuts, so the
  // coordinator can price/badge/move a whole page of products in one action
  // instead of touching each card.
  function bulkSetWeight() {
    const wt = prompt('Set weight/unit for the selected products (e.g. 500gm, 1kg):')
    if (wt === null) return
    setProducts(prev => prev.map(p => selectedKeys.has(p._key) ? { ...p, weight: wt } : p))
  }

  function bulkSetPrice() {
    const raw = prompt('Set offer price (₹) for the selected products (blank to clear):')
    if (raw === null) return
    const trimmed = raw.trim()
    const price = trimmed === '' ? null : Number(trimmed)
    if (price !== null && Number.isNaN(price)) { setError('Enter a valid number for price.'); return }
    setProducts(prev => prev.map(p => selectedKeys.has(p._key) ? { ...p, price } : p))
  }

  function bulkMoveToPage() {
    const raw = prompt('Move selected products to page number:')
    if (raw === null) return
    const page = Math.round(Number(raw))
    if (Number.isNaN(page) || page < 1) { setError('Enter a valid page number (1 or higher).'); return }
    setProducts(prev => prev.map(p => selectedKeys.has(p._key) ? { ...p, page } : p))
  }

  function bulkSetBadge() {
    const label = prompt('Badge label for selected products (blank to clear badges):')
    if (label === null) return
    const trimmed = label.trim()
    setProducts(prev => prev.map(p => {
      if (!selectedKeys.has(p._key)) return p
      if (!trimmed) return { ...p, badges: [] }
      // Reuse a predefined badge when the label matches; otherwise a custom one.
      const known = badges.find(b => b.label.toLowerCase() === trimmed.toLowerCase())
      const badge: ProductBadgeInput = known
        ? { badge_id: known.id, color: known.color }
        : { custom_label: trimmed, color: 'amber' }
      return { ...p, badges: [badge] }
    }))
  }

  // Re-case the selected products' names: UPPERCASE / First letter / Title Case
  // (title keeps connector words + unit tokens like 500gm lowercase).
  function bulkFormatNames(mode: NameCaseMode) {
    setProducts(prev => prev.map(p =>
      selectedKeys.has(p._key) ? { ...p, name: formatProductName(p.name, mode) } : p))
  }

  function duplicateSelected() {
    const toDup = products.filter(p => selectedKeys.has(p._key))
    if (!toDup.length) return
    let order = products.length
    const clones = toDup.map(src => ({ ...src, id: undefined, _key: `dup-${Date.now()}-${order}-${Math.random()}`, display_order: order++ }))
    setProducts(prev => [...prev, ...clones])
  }

  function deleteSelected() {
    if (!selectedKeys.size) return
    if (!confirm(`Delete ${selectedKeys.size} selected product${selectedKeys.size === 1 ? '' : 's'}?`)) return
    setProducts(prev => prev.filter(p => !selectedKeys.has(p._key)).map((p, i) => ({ ...p, display_order: i })))
    clearSelection()
  }

  function addFromCatalog(item: CatalogItem) {
    const order = products.length
    const page = catalogPageTarget
    if (!item.id) {
      // New blank product
      setProducts(prev => [...prev, { ...emptyProduct(order), page, group_id: catalogGroupTarget }])
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
        group_id: catalogGroupTarget,
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

  /**
   * Cut the product out of its background and save the transparent PNG through
   * the normal upload path (so the catalog mirrors it and it's reused in future
   * campaigns). Runs entirely on-device — no per-image cost. External image
   * links are fetched through a token-gated server proxy because most product
   * CDNs don't send CORS headers.
   */
  async function removeProductBackground(imageUrl: string): Promise<string | null> {
    try {
      // 1. Source bytes — direct fetch first (our own Supabase URLs allow it).
      let blob: Blob | null = null
      try {
        const res = await fetch(imageUrl, { mode: 'cors' })
        if (res.ok) blob = await res.blob()
      } catch { /* CORS-blocked — fall through to the proxy */ }
      if (!blob) {
        const prox = await fetchExternalImage(token, imageUrl)
        if (!prox.ok || !prox.data) {
          setError(prox.error || 'Could not load that image for background removal.')
          return null
        }
        const bin = atob(prox.data.base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        blob = new Blob([bytes], { type: prox.data.contentType })
      }

      // 2. On-device model (lazy-loaded on first use).
      const { removeBackground } = await import('@/lib/images/remove-background')
      const cutout = await removeBackground(blob)

      // 3. Save as a new image so the original stays in the catalog history.
      const file = new File([cutout], 'product-cutout.png', { type: 'image/png' })
      const url = await handleUploadImage('bg-removal', file)
      if (url) setError('')
      return url
    } catch {
      setError('Background removal failed — try a clearer photo, or check your connection (the first use downloads the model).')
      return null
    }
  }

  /**
   * Save the given product list (usually the current state, but bulk-paste's
   * one-click "Generate Sheet" passes the freshly-merged list directly since
   * setState hasn't flushed yet). saveCampaign also fires the Google Sheet
   * sync server-side.
   */
  async function saveProducts(list: LocalProduct[]) {
    // In-flight guard. The Save button is disabled while saving, but Ctrl+S and
    // the bulk-paste "Generate Sheet" button both reach here directly — and two
    // overlapping saves before campaignId exists each take the server's create
    // branch, producing two campaigns where the second finalises the first.
    if (savingRef.current) return
    savingRef.current = true
    try {
      await runSave(list)
    } finally {
      savingRef.current = false
    }
  }

  async function runSave(list: LocalProduct[]) {
    const invalid = list.find(p => !p.name.trim())
    if (invalid) { setError('All products need a name.'); return }
    if (list.length === 0) { setError('Add at least one product.'); return }

    setSaving(true); setError(''); setSaved(false)
    if (staff) { setSyncState('saving'); setSyncErrorMsg(null) }

    const input: CampaignInput = {
      title: title.trim() || undefined,
      date_type: dateType,
      offer_date: dateType === 'single' ? offerDate || undefined : undefined,
      offer_date_from: dateType === 'range' ? offerDateFrom || undefined : undefined,
      offer_date_to: dateType === 'range' ? offerDateTo || undefined : undefined,
      client_note: clientNote.trim() || undefined,
      products: list.map((p, i) => ({
        id: p.id,
        catalog_id: p.catalog_id,
        group_id: p.group_id ?? null,
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

    // Signature of exactly what we're sending — recorded on success so the
    // unsaved-work guard stops warning about work that did reach the server.
    const sentSignature = offerSignature(
      { title, dateType, offerDate, offerDateFrom, offerDateTo },
      list,
    )

    const res = await saveCampaign(token, input, campaignId)
    setSaving(false)

    if (res.ok && res.data) {
      setCampaignId(res.data.campaignId)

      // Adopt the row ids the server just assigned. Without this, products
      // created by THIS save still look brand-new to the next one, which then
      // deletes and re-inserts them — churning ids and writing a bogus
      // "removed + added" pair into the change log on every single save.
      // Matched by _key (not index) because the list can have been edited
      // while the request was in flight.
      const idByKey = new Map<string, string>()
      res.data.productIds.forEach((id, i) => {
        const key = list[i]?._key
        if (id && key) idByKey.set(key, id)
      })
      if (idByKey.size) {
        setProducts(current => current.map(p =>
          p.id || !idByKey.has(p._key) ? p : { ...p, id: idByKey.get(p._key) }
        ))
      }

      setSavedSignature(sentSignature)
      setSaved(true)
      setClientNote('')
      setShowNote(false)
      setTimeout(() => setSaved(false), 4000)
      if (staff) {
        if (flowMode === 'push') { setSyncState('syncing'); void pollSyncStatus(res.data.campaignId) }
        else setSyncState('skipped')
      }
    } else {
      setError(res.error || 'Could not save. Please try again.')
      if (staff) setSyncState('idle')
    }
  }

  // Poll the campaign's Google Sheet sync status after a save (the server runs
  // the sync fire-and-forget). Correctness rules:
  //  • A newer save supersedes an in-flight poll via the run token.
  //  • Success is only ever claimed when THIS save's rows reached the sheet:
  //    sheet_last_synced_at must be at/after this save's updated_at (strict, no
  //    slop) — a stale prior-sync timestamp can't count.
  //  • The server clears sheet_sync_error at the start of each attempt, so a
  //    non-null error here belongs to this attempt → a real failure.
  //  • We wait out the server sync's own 15s fetch timeout before giving up, and
  //    on timeout we never claim success we didn't observe.
  // All timestamps are DB-sourced, so the comparison is clock-skew safe.
  async function pollSyncStatus(cid: string) {
    const run = ++syncPollRef.current
    let baseUpdatedAt: string | null = null
    let consecutiveErrors = 0
    const deadline = Date.now() + 18_000 // cover the server sync's 15s fetch timeout + slack
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1300))
      if (syncPollRef.current !== run) return // a newer save took over
      const res = await getCampaignSyncStatus(token, cid)
      if (!res.ok || !res.data) continue
      const { syncedAt, syncError, updatedAt } = res.data
      if (baseUpdatedAt == null) baseUpdatedAt = updatedAt
      // A completed sync of THIS save always wins (its timestamp is at/after the
      // save's updated_at), even over a lingering error.
      const syncedThisSave = !!syncedAt && !!baseUpdatedAt
        && new Date(syncedAt).getTime() >= new Date(baseUpdatedAt).getTime()
      if (syncedThisSave) { setSyncState('synced'); return }
      // The server clears a prior attempt's error at the start of this one, but
      // that clear can land just after our first read. Require the error to
      // persist across two reads before declaring failure so we never latch on
      // that brief stale window; genuine failures still surface within ~2.6s.
      if (syncError) {
        if (++consecutiveErrors >= 2) { setSyncState('error'); setSyncErrorMsg(syncError); return }
      } else {
        consecutiveErrors = 0
      }
    }
    // Window elapsed with no observed success or error. This is genuinely
    // indeterminate, but it is NOT "still syncing" — leaving the spinner up
    // meant it never terminated. Say we stopped watching and offer a retry.
    if (syncPollRef.current === run) setSyncState('unknown')
  }

  async function handleRetrySync() {
    if (!campaignId) return
    setSyncState('syncing'); setSyncErrorMsg(null)
    // resyncOfferSheet awaits the sync fully, so its result is authoritative.
    const res = await resyncOfferSheet(token, campaignId)
    if (res.ok) setSyncState('synced')
    else { setSyncState('error'); setSyncErrorMsg(res.error || 'Sync failed.') }
  }

  function handleSave() { void saveProducts(products) }

  // Power-user keyboard shortcuts for the daily coordinator flow. Defined here,
  // after every handler above, so the useCallback consts (selectAll/clearSelection)
  // are initialised before they're referenced.
  useKeyboardShortcuts({
    onSelectAll: () => selectAll(products.map(p => p._key)),
    onClearSelection: clearSelection,
    onDeleteSelected: deleteSelected,
    onDuplicateSelected: duplicateSelected,
    onBulkWeight: bulkSetWeight,
    onBulkMove: bulkMoveToPage,
    onBulkPrice: bulkSetPrice,
    onBulkBadge: bulkSetBadge,
    onAiCapture: () => openBulkPaste(),
    onSave: handleSave,
  })

  // Paste/review flow active — the bottom note + save controls belong to the
  // editor and would just add noise (the review table has its own CTA).
  const inPasteFlow = !!bulkPasteReview || bulkPasteOpen || products.length === 0

  const dateDisplay = dateType === 'single'
    ? (offerDate ? fmtDate(offerDate) : '')
    : [offerDateFrom ? fmtDate(offerDateFrom) : '', offerDateTo ? fmtDate(offerDateTo) : ''].filter(Boolean).join(' – ')

  // "Missing images only" is a view filter (never mutates order/data). Drag-
  // reorder is disabled while it's active so reordering a partial view can't
  // scramble the hidden rows' display_order.
  const missingImagesCount = products.filter(p => !p.image_url).length
  const inActiveGroup = showGroupTabs ? products.filter(belongsToActiveGroup) : products
  const visibleProducts = showMissingImagesOnly ? inActiveGroup.filter(p => !p.image_url) : inActiveGroup
  const canReorder = !showMissingImagesOnly

  // The single Figma-ready row set used by "Copy table", "Copy selected" and
  // "Download CSV" — identical columns to the Google Sheet, so a manual paste or
  // download is interchangeable with the webhook sync.
  function sheetRowsFor(list: LocalProduct[]) {
    return buildOfferSheetRows({
      clientName: client.name,
      offerTitle: title,
      offerDate: dateDisplay,
      products: list.map(product => ({
        ...product,
        badges: (product.badges || []).map(badge => ({
          custom_label: badge.custom_label || (badge.badge_id ? badges.find(item => item.id === badge.badge_id)?.label : null),
        })),
      })),
    })
  }

  // Shared by "Copy table" (all / per-page) and "Copy selected".
  async function copyProductsAsTable(list: LocalProduct[], label: string) {
    if (!list.length) return
    const copied = await copyText(offerSheetTsv(sheetRowsFor(list)))
    if (!copied) {
      setError('Could not copy the table. Please allow clipboard access and try again.')
      return
    }
    setCopyMessage(`${label} copied as a table — paste directly into Google Sheets, Excel, or Figma data tools.`)
    window.setTimeout(() => setCopyMessage(null), 5000)
  }

  async function copyOfferTable(page?: number) {
    const list = page == null ? products : products.filter(product => (product.page || 1) === page)
    const label = page == null ? `${list.length} product${list.length === 1 ? '' : 's'}` : `Page ${page} (${list.length})`
    await copyProductsAsTable(list, label)
  }

  async function copySelected() {
    const sel = products.filter(p => selectedKeys.has(p._key))
    if (!sel.length) return
    await copyProductsAsTable(sel, `${sel.length} selected`)
  }

  // Download the offer as a CSV file — the webhook-free fallback for importing
  // into Google Sheets / Excel. Same frozen columns as the sheet.
  function downloadCsv() {
    if (!products.length) return
    const csv = offerSheetCsv(sheetRowsFor(products))
    const safeClient = (client.name || 'offer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'offer'
    const datePart = (dateType === 'single' ? offerDate : offerDateFrom) || ''
    const filename = `${safeClient}-offer${datePart ? `-${datePart}` : ''}.csv`
    // BOM so Excel opens UTF-8 (₹, accented names) correctly.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setCopyMessage(`Downloaded ${filename} — import it into Google Sheets or Excel.`)
    window.setTimeout(() => setCopyMessage(null), 5000)
  }

  // Weekly-offer decision gate (staff): show the choice BEFORE loading any
  // products, so a new week never merges with last week's list.
  if (pendingDecision) {
    const existingCount = initialCampaign?.products?.length ?? 0
    return (
      <div className="min-h-dvh bg-[#0f0f1a] text-white flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-[#1a1a24] border border-white/10 rounded-3xl shadow-2xl overflow-hidden">
          <div className="p-5 border-b border-white/10">
            <h2 className="text-base font-bold text-white/90 flex items-center gap-2">
              <FilePlus className="w-4 h-4 text-violet-400" /> Existing Weekly Offer Found
            </h2>
            <p className="text-xs text-white/50 mt-1">
              {client.name} already has an active offer with {existingCount} product{existingCount === 1 ? '' : 's'}. What would you like to do?
            </p>
          </div>
          <div className="p-4 space-y-2.5">
            <button onClick={chooseStartNewOffer} className="w-full text-left rounded-2xl border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-4 py-3 transition-colors">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                <Sparkles className="w-4 h-4" /> Start New Weekly Offer
                <span className="ml-auto text-[10px] font-medium text-emerald-400/90 bg-emerald-500/15 px-2 py-0.5 rounded-full">Recommended</span>
              </div>
              <p className="text-[11px] text-white/50 mt-1">Empty list, fresh start. The current offer is finalised automatically when you save the new one.</p>
            </button>
            <button onClick={chooseContinueOffer} className="w-full text-left rounded-2xl border border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/15 px-4 py-3 transition-colors">
              <div className="flex items-center gap-2 text-sm font-semibold text-blue-300">
                <RefreshCw className="w-4 h-4" /> Continue Current Offer
              </div>
              <p className="text-[11px] text-white/50 mt-1">Keep editing this week&apos;s offer with its existing {existingCount} product{existingCount === 1 ? '' : 's'}.</p>
            </button>
            <button onClick={chooseStartFromLastWeek} className="w-full text-left rounded-2xl border border-violet-500/30 bg-violet-500/5 hover:bg-violet-500/15 px-4 py-3 transition-colors">
              <div className="flex items-center gap-2 text-sm font-semibold text-violet-300">
                <History className="w-4 h-4" /> Start From Last Week
              </div>
              <p className="text-[11px] text-white/50 mt-1">A new offer pre-filled with the same products (prices cleared) — you just re-price.</p>
            </button>
          </div>
          <div className="px-4 pb-4">
            <button onClick={cancelDecision} className="w-full py-2.5 rounded-2xl text-xs text-white/50 hover:text-white/80 hover:bg-white/5 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-[#0f0f1a] text-white">
      {/* Replace vs Add choice — a whole-list AI Capture into a non-empty offer. */}
      {bulkApply && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[#1a1a24] border border-white/10 rounded-3xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-white/10">
              <h2 className="text-base font-bold text-white/90 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" /> This offer already has products
              </h2>
              <p className="text-xs text-white/50 mt-1">
                There {products.length === 1 ? 'is' : 'are'} already {products.length} product{products.length === 1 ? '' : 's'} here. Replace them with the captured list, or add the captured list to them?
              </p>
            </div>
            <div className="p-4 space-y-2.5">
              <button onClick={() => applyBulkPaste('replace', bulkApply.generate)} className="w-full text-left rounded-2xl border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-4 py-3 transition-colors">
                <span className="text-sm font-semibold text-emerald-300">Replace with captured list</span>
                <p className="text-[11px] text-white/50 mt-0.5">Removes the current {products.length} and starts fresh with the new list.</p>
              </button>
              <button onClick={() => applyBulkPaste('append', bulkApply.generate)} className="w-full text-left rounded-2xl border border-white/15 bg-white/5 hover:bg-white/10 px-4 py-3 transition-colors">
                <span className="text-sm font-semibold text-white/80">Add to current offer</span>
                <p className="text-[11px] text-white/50 mt-0.5">Keeps the current products and appends the captured list.</p>
              </button>
            </div>
            <div className="px-4 pb-4">
              <button onClick={() => setBulkApply(null)} className="w-full py-2.5 rounded-2xl text-xs text-white/50 hover:text-white/80 hover:bg-white/5 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Brand header — stays a comfortable reading width even on wide screens; a
          centered logo/title stretched edge-to-edge on a desktop monitor looks broken. */}
      <div className="max-w-2xl mx-auto px-4 pt-8 sm:pt-12">
        {hub && (
          <Link href={`/start/${hub}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/50 hover:text-white transition-colors mb-6 group">
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Back to Hub
          </Link>
        )}
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
            <button aria-label={headerExpanded ? 'Collapse offer details' : 'Expand offer details'} aria-expanded={headerExpanded} className="p-1.5 bg-white/5 hover:bg-white/10 rounded text-white/60 hover:text-white transition-colors">
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

        {/* ── Products area ──
            Three states, in priority order:
            1. Review table  — AI just parsed a list; confirm/fix, then generate.
            2. Paste hero    — empty campaign (or "Bulk Paste" clicked): the
                               WhatsApp-paste box IS the front door, not a modal.
            3. Editor        — the full per-product editor ("Edit Products" mode). */}
        {bulkPasteReview ? (
        <div className="mb-8">
          <div className="bg-[#1a1a24] border border-white/10 rounded-3xl shadow-xl overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-white/10">
              <div>
                <h2 className="font-bold text-white/90 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-violet-400" />
                  AI found {bulkPasteReview.length} product{bulkPasteReview.length !== 1 ? 's' : ''}
                </h2>
                <p className="text-xs text-white/40 mt-0.5">Fix anything inline, uncheck what you don&apos;t want, then generate the sheet.</p>
              </div>
              <button
                onClick={() => { setBulkPasteReview(null); setBulkPasteOpen(true) }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Edit text
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-white/30 border-b border-white/10">
                    <th className="px-3 py-2.5 w-8"></th>
                    <th className="px-2 py-2.5 w-8 text-left">#</th>
                    <th className="px-2 py-2.5 w-14 text-left">Image</th>
                    <th className="px-2 py-2.5 text-left min-w-[200px]">Product</th>
                    <th className="px-2 py-2.5 w-24 text-right">Price ₹</th>
                    <th className="px-2 py-2.5 w-24 text-right">MRP ₹</th>
                    <th className="px-2 py-2.5 w-32 text-left">Badge</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkPasteReview.map((row, i) => {
                    const matchImg = row.matchedCatalogId ? catalog.find(c => c.id === row.matchedCatalogId)?.image_url : undefined
                    return (
                      <tr key={row._key} className={`border-b border-white/5 last:border-0 ${row.include ? '' : 'opacity-35'}`}>
                        <td className="px-3 py-2 align-middle">
                          <input type="checkbox" checked={row.include} onChange={e => updateBulkPasteRow(row._key, { include: e.target.checked })} className="accent-violet-500" />
                        </td>
                        <td className="px-2 py-2 text-white/30 text-xs align-middle">{i + 1}</td>
                        <td className="px-2 py-2 align-middle">
                          {matchImg ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={matchImg} alt="" className="w-9 h-9 rounded-lg object-cover bg-white/5 border border-white/10" />
                          ) : row.matchedCatalogId ? (
                            <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center"><ImageIcon className="w-4 h-4 text-white/20" /></div>
                          ) : (
                            <span title="Not in this client's catalog yet — will be added as a new product on save" className="inline-flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/25 whitespace-nowrap">
                              <AlertTriangle className="w-3 h-3" /> New
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 align-middle">
                          <input
                            value={row.name}
                            onChange={e => updateBulkPasteRow(row._key, { name: e.target.value })}
                            placeholder="Product name incl. weight — e.g. Rice 5kg"
                            className="w-full bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm font-medium text-white/90 focus:outline-none"
                          />
                        </td>
                        <td className="px-2 py-2 align-middle">
                          <SplitPriceInput
                            value={row.price}
                            onChange={price => updateBulkPasteRow(row._key, { price })}
                            placeholder="—"
                            wholeCls="w-full min-w-0 text-right bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm font-semibold text-emerald-400 focus:outline-none"
                            paiseCls="w-7 shrink-0 bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-1 py-1 text-[11px] text-emerald-400/80 focus:outline-none placeholder:text-white/15"
                          />
                        </td>
                        <td className="px-2 py-2 align-middle">
                          <input
                            type="number" step="0.01" min="0"
                            value={row.mrp ?? ''}
                            onChange={e => updateBulkPasteRow(row._key, { mrp: e.target.value ? parseFloat(e.target.value) : null })}
                            className="w-full text-right bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm text-white/50 focus:outline-none"
                            placeholder="—"
                          />
                        </td>
                        <td className="px-2 py-2 align-middle">
                          <input
                            value={row.badge ?? ''}
                            onChange={e => updateBulkPasteRow(row._key, { badge: e.target.value || null })}
                            placeholder="—"
                            className="w-full bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-xs text-amber-300 focus:outline-none"
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
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
                <button
                  onClick={() => confirmBulkPaste(false)}
                  disabled={!bulkPasteReview.some(r => r.include) || saving}
                  className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-xl bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 disabled:opacity-50 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" /> Add &amp; edit details
                </button>
                <button
                  onClick={() => confirmBulkPaste(true)}
                  disabled={!bulkPasteReview.some(r => r.include) || saving}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold rounded-xl bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 disabled:opacity-50 transition-colors"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                  {saving ? 'Generating…' : `Generate Sheet (${bulkPasteReview.filter(r => r.include).length})`}
                </button>
              </div>
            </div>
          </div>
        </div>
        ) : (bulkPasteOpen || products.length === 0) ? (
        <div className="mb-8 max-w-2xl mx-auto">
          <div className="bg-[#1a1a24] border border-white/10 rounded-3xl p-5 sm:p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-white/90 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-400" /> AI Capture to Page {bulkPasteTargetPage}
              </h2>
              {products.length > 0 && (
                <button onClick={() => setBulkPasteOpen(false)} className="p-1.5 rounded-lg hover:bg-white/10 text-white/50"><X className="w-4 h-4" /></button>
              )}
            </div>
            <p className="text-xs text-white/40 mt-1 mb-4">
              Paste a WhatsApp list, email, or plain text. AI fills in product names, prices, MRP and badges for Page {bulkPasteTargetPage}.
            </p>
            <textarea
              value={bulkPasteText}
              onChange={e => setBulkPasteText(e.target.value)}
              placeholder={'Bru Coffee 200g  145\nEastern Chilli Powder 500g  MRP 129  Offer 109\nSweet / Masala Number  63'}
              rows={9}
              autoFocus
              className={`${inputCls} resize-y font-mono min-h-[180px]`}
            />
            <button
              onClick={() => setHintOpen(o => !o)}
              className="mt-3 flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              AI instructions <span className="text-white/25">(optional)</span>
              {hintOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {hintOpen && (
              <input
                value={bulkPasteHint}
                onChange={e => setBulkPasteHint(e.target.value)}
                placeholder={'e.g. "the second number is MRP" or "ignore lines starting with *"'}
                className={inputCls + ' mt-2'}
              />
            )}
            <button
              onClick={runBulkPasteParse}
              disabled={!bulkPasteText.trim() || bulkPasteBusy}
              className="w-full mt-4 py-3 text-sm font-bold rounded-2xl bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            >
              {bulkPasteBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPaste className="w-4 h-4" />}
              {bulkPasteBusy ? 'AI is reading your list…' : `Capture to Page ${bulkPasteTargetPage}`}
            </button>
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 mt-4">
              <button
                onClick={() => { setBulkPasteOpen(false); if (!products.length) addBlankProduct(1) }}
                className="text-xs text-white/40 hover:text-white/80 transition-colors"
              >
                Add manually instead
              </button>
              <button
                onClick={() => { setCatalogPageTarget(1); setCatalogGroupTarget(activeGroupId); setShowCatalog(true) }}
                className="text-xs text-white/40 hover:text-white/80 transition-colors"
              >
                Search past products
              </button>
              {products.length === 0 && (
                <button
                  onClick={handleStartFromLastWeek}
                  disabled={cloning}
                  title="Copy last week's products (prices cleared) so you only re-price"
                  className="flex items-center gap-1.5 text-xs font-medium text-violet-300 hover:text-violet-200 transition-colors disabled:opacity-50"
                >
                  {cloning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
                  Start from last week
                </button>
              )}
            </div>
          </div>
        </div>
        ) : (
        <div className="mb-8">
          {/* Category tabs — only for clients with more than one flyer stream.
              Each category has its own designer sheet and Figma file, so the
              tabs mirror what actually gets produced. */}
          {showGroupTabs && (
            <div className="flex items-center gap-1.5 mb-4 px-1 overflow-x-auto pb-1">
              {groups.map(group => {
                const count = products.filter(p => {
                  const isOrphan = !p.group_id || !knownGroupIds.has(p.group_id)
                  return isOrphan ? group.id === groups[0].id : p.group_id === group.id
                }).length
                const active = group.id === activeGroupId
                return (
                  <button
                    key={group.id}
                    onClick={() => { setActiveGroupId(group.id); clearSelection() }}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
                      active
                        ? 'bg-violet-600 text-white shadow-lg shadow-violet-900/30'
                        : 'bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {group.name}
                    <span className={active ? 'text-white/60' : 'text-white/30'}>{count}</span>
                  </button>
                )
              })}
            </div>
          )}
          <div className="flex items-center justify-between mb-3 px-1">
             <div className="flex items-center gap-3">
               <h2 className="text-sm font-semibold text-white/70">
                 Products <span className="text-white/30">({inActiveGroup.length})</span>
               </h2>
               {inActiveGroup.length > 0 && (
                 <button onClick={() => {
                   const keys = inActiveGroup.map(p => p._key)
                   if (keys.every(k => selectedKeys.has(k))) clearSelection()
                   else selectAll(keys)
                 }} className="text-xs text-white/40 hover:text-white/80 transition-colors">
                   {inActiveGroup.every(p => selectedKeys.has(p._key)) ? 'Deselect All' : 'Select All'}
                 </button>
               )}
             </div>
             <div className="flex items-center gap-2">
             <button
               onClick={() => openBulkPaste()}
               title="Paste a product list and let AI fill in the rows"
               className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600/20 text-violet-300 hover:bg-violet-600/40 transition-colors"
             >
               <Sparkles className="w-3.5 h-3.5" /> AI Capture
             </button>
             {products.length > 0 && (
               <button
                 onClick={() => void copyOfferTable()}
                 title="Copy Figma-ready columns to Google Sheets or Excel"
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
               >
                 <Copy className="w-3.5 h-3.5" /> Copy table
               </button>
             )}
             {products.length > 0 && (
               <button
                 onClick={downloadCsv}
                 title="Download the offer as a CSV file for Google Sheets or Excel"
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
               >
                 <Download className="w-3.5 h-3.5" /> CSV
               </button>
             )}
             {/* Designers only — a client has no use for Figma layer names. */}
             {staff && <FigmaBindingHelp tone="dark" />}
             {products.length > 0 && (
               <button
                 onClick={() => setShowMissingImagesOnly(v => !v)}
                 title="Show only products still waiting for an image"
                 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                   showMissingImagesOnly
                     ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                     : 'bg-white/5 text-white/60 border-white/10 hover:text-white hover:bg-white/10'
                 }`}
               >
                 <ImageOff className="w-3.5 h-3.5" /> Missing images{missingImagesCount > 0 ? ` (${missingImagesCount})` : ''}
               </button>
             )}
             {products.length > 0 && (
               <div className="flex items-center bg-white/5 border border-white/10 rounded-lg p-0.5">
                 <button
                   onClick={() => setViewMode('list')}
                   title="List view"
                   className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}
                 >
                   <List className="w-3.5 h-3.5" />
                 </button>
                 <button
                   onClick={() => setViewMode('grid')}
                   title="Grid view"
                   className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}
                 >
                   <LayoutGrid className="w-3.5 h-3.5" />
                 </button>
                 <button
                   onClick={() => setViewMode('table')}
                   title="Table view — edit cell by cell like a spreadsheet"
                   className={`p-1.5 rounded-md transition-colors ${viewMode === 'table' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}
                 >
                   <Table2 className="w-3.5 h-3.5" />
                 </button>
               </div>
             )}
             </div>
          </div>

          {selectedKeys.size > 0 && (
            <div className="bg-indigo-600 border border-indigo-500 rounded-xl p-3 mb-6 flex items-center justify-between shadow-lg shadow-indigo-900/20 text-white sticky top-4 z-50">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-sm bg-indigo-500/50 px-2.5 py-1 rounded-lg shadow-inner">{selectedKeys.size} selected</span>
                <button onClick={clearSelection} className="text-xs text-indigo-200 hover:text-white transition-colors font-medium">Clear</button>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button onClick={bulkSetPrice} title="Set the same offer price on all selected (⌘⇧P)"
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-medium transition-colors shadow-sm">
                  Price
                </button>
                <button onClick={bulkSetWeight} title="Set the same weight/unit on all selected (⌘⇧W)"
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-medium transition-colors shadow-sm">
                  Weight
                </button>
                <button onClick={bulkSetBadge} title="Set the same badge on all selected (⌘⇧B)"
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-medium transition-colors shadow-sm">
                  Badge
                </button>
                <button onClick={bulkMoveToPage} title="Move all selected to another page (⌘⇧M)"
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-medium transition-colors shadow-sm">
                  Move page
                </button>
                <div className="flex items-center bg-white/10 rounded-lg overflow-hidden shadow-sm" title="Format the selected product names">
                  <button onClick={() => bulkFormatNames('upper')} title="ALL UPPERCASE"
                    className="px-2.5 py-1.5 hover:bg-white/20 text-xs font-medium transition-colors border-r border-indigo-400/30">
                    AA
                  </button>
                  <button onClick={() => bulkFormatNames('sentence')} title="First letter capital only"
                    className="px-2.5 py-1.5 hover:bg-white/20 text-xs font-medium transition-colors border-r border-indigo-400/30">
                    Aa
                  </button>
                  <button onClick={() => bulkFormatNames('title')} title="Title Case — capitalise each word, keep small words (of, with, per) and units (500gm, 1kg) lowercase"
                    className="px-2.5 py-1.5 hover:bg-white/20 text-xs font-medium transition-colors">
                    Aa Bc
                  </button>
                </div>
                <button onClick={duplicateSelected} title="Duplicate all selected (⌘D)"
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-medium transition-colors shadow-sm">
                  Duplicate
                </button>
                <button onClick={() => void copySelected()} title="Copy selected rows as a table"
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-medium transition-colors shadow-sm">
                  Copy
                </button>
                <button onClick={deleteSelected} title="Delete all selected (Del)"
                  className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/40 border border-red-500/30 text-red-100 rounded-lg text-xs font-medium transition-colors shadow-sm">
                  Delete
                </button>
              </div>
            </div>
          )}

          <div className="space-y-6">
            {showMissingImagesOnly && visibleProducts.length === 0 && (
              <div className="bg-[#1a1a24] border border-white/10 rounded-3xl p-8 text-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-3" />
                <p className="text-sm text-white/70">Every product has an image.</p>
                <button onClick={() => setShowMissingImagesOnly(false)} className="mt-3 text-xs text-violet-300 hover:text-violet-200">
                  Show all products
                </button>
              </div>
            )}
            {viewMode === 'table' && visibleProducts.length > 0 && (
              <ProductTableView
                products={visibleProducts}
                badges={badges}
                onUpdate={updateProduct}
                onRemove={removeProduct}
                onAddRow={addBlankProduct}
                onUploadImage={(key, file) => handleUploadImage(key, file)}
                selectedKeys={selectedKeys}
                onToggleSelect={toggleSelect}
              />
            )}
            {viewMode !== 'table' && Array.from(new Set(visibleProducts.map(p => p.page || 1))).sort((a, b) => a - b).map(pageNum => {
               const pageProducts = visibleProducts.filter(p => (p.page || 1) === pageNum)
               return (
                 <div key={pageNum} className="bg-[#1a1a24] border border-white/10 rounded-3xl p-4 shadow-xl">
                   <div className="flex items-center justify-between mb-4 px-1">
                     <h3 className="font-bold text-white/80 flex items-center gap-2">
                        <FilePlus className="w-4 h-4 text-violet-400" />
                        Page {pageNum}
                     </h3>
                     <div className="flex items-center gap-2">
                       {pageProducts.length > 0 && (
                         <button onClick={() => {
                           const pageKeys = pageProducts.map(p => p._key)
                           const allSelected = pageKeys.every(k => selectedKeys.has(k))
                           if (allSelected) {
                             const next = new Set(selectedKeys)
                             pageKeys.forEach(k => next.delete(k))
                             setSelectedKeys(next)
                           } else {
                             const next = new Set(selectedKeys)
                             pageKeys.forEach(k => next.add(k))
                             setSelectedKeys(next)
                           }
                         }} className="text-[11px] text-white/40 hover:text-white transition-colors mr-2">
                           {pageProducts.every(p => selectedKeys.has(p._key)) ? 'Deselect Page' : 'Select Page'}
                         </button>
                       )}
                       {canReorder && pageProducts.length > 1 && (
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
                       <button onClick={() => { setCatalogPageTarget(pageNum); setCatalogGroupTarget(activeGroupId); setShowCatalog(true) }} className="text-xs font-medium text-white/50 hover:text-white transition-colors flex items-center gap-1">
                         <Search className="w-3 h-3" /> Search past
                       </button>
                       <button onClick={() => openBulkPaste(pageNum, true)} className="text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors flex items-center gap-1 bg-violet-500/10 hover:bg-violet-500/20 px-2 py-1 rounded ml-2">
                         <Sparkles className="w-3 h-3" /> AI Capture
                       </button>
                       {pageProducts.length > 0 && (
                         <button onClick={() => void copyOfferTable(pageNum)} className="text-xs font-medium text-white/50 hover:text-white transition-colors flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5">
                           <Copy className="w-3 h-3" /> Copy table
                         </button>
                       )}
                     </div>
                   </div>

                   {/* Stable id: dnd-kit's auto-generated accessibility ids use a
                       module counter that differs between SSR and hydration,
                       spamming a hydration-mismatch console error without it. */}
                   <DndContext id={`offer-page-dnd-${pageNum}`} sensors={sensors} collisionDetection={closestCenter} onDragEnd={e => reorderPage(pageNum, e)}>
                     <SortableContext
                       items={pageProducts.map(p => p._key)}
                       strategy={viewMode === 'list' ? verticalListSortingStrategy : rectSortingStrategy}
                     >
                       {viewMode === 'list' ? (
                         <div className="space-y-2">
                           {pageProducts.map(p => (
                             <SortableProductRow
                               key={p._key}
                               canReorder={canReorder}
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
                               onRemoveBg={removeProductBackground}
                             />
                           ))}
                         </div>
                       ) : (
                         <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                           {pageProducts.map(p => (
                             <SortableProductGridCard
                               key={p._key}
                               canReorder={canReorder}
                               product={p}
                               badges={badges}
                               catalogImages={catalog.find(c => c.id === p.catalog_id)?.images}
                               onUpdate={updates => updateProduct(p._key, updates)}
                               onRemove={() => removeProduct(p._key)}
                               onUploadImage={file => handleUploadImage(p._key, file)}
                               uploading={false}
                               onRemoveBg={removeProductBackground}
                             />
                           ))}
                         </div>
                       )}
                     </SortableContext>
                   </DndContext>
                   
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
        )}

       <div className="max-w-2xl mx-auto">
        {/* ── Note to team ── */}
        {!inPasteFlow && (
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
        )}

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-4 flex items-center gap-2 text-sm text-red-400">
            <X className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {copyMessage && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 mb-4 flex items-center gap-2 text-sm text-emerald-300">
            <Check className="w-4 h-4 shrink-0" /> {copyMessage}
          </div>
        )}

        {/* ── Cancel Button ── */}
        {!inPasteFlow && campaignId && (
          <div className="mb-4">
            <button
              onClick={async () => {
                if (confirm('Cancel this request? You will be able to start a new one.')) {
                  setCancelling(true)
                  const res = await cancelCampaign(token, campaignId)
                  setCancelling(false)
                  if (res.ok) window.location.reload()
                  else setError(res.error || 'Could not cancel this offer request.')
                }
              }}
              disabled={cancelling}
              className="w-full py-3.5 text-sm font-semibold rounded-2xl border border-red-500/20 text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            >
              {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Cancel Request & Start Over
            </button>
          </div>
        )}

        {/* ── Save button ── */}
        {!inPasteFlow && (
        <>
        {/* This offer mirrors a sheet the client maintains themselves. Saving
            here would be undone by the next import, so the server rejects it —
            say so up front rather than letting someone type into a dead form. */}
        {sheetManaged && (
          <div className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 flex items-start gap-2 text-xs text-amber-200">
            <FileSpreadsheet className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold">Sheet managed.</span>{' '}
              This offer is imported from the client’s own Google Sheet and can’t be edited here — update the sheet and pull again.
              {staff && ' Convert it to a Cirqle offer from the Campaigns page if you need to edit it in Cirqle.'}
            </span>
          </div>
        )}
        <button
          onClick={handleSave}
          disabled={saving || products.length === 0 || sheetManaged}
          className="w-full py-3.5 text-sm font-bold rounded-2xl bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
        >
          {saving
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
            : campaignId
              ? <><RefreshCw className="w-4 h-4" /> Update offer list &amp; sheet</>
              : <><FileSpreadsheet className="w-4 h-4" /> Save &amp; generate sheet</>
          }
        </button>

        {/* Google Sheet sync status — staff entrance only (clients don't manage the sheet). */}
        {staff && syncState !== 'idle' && (
          <div className={`mt-3 rounded-xl border px-3 py-2 flex items-center gap-2 text-xs ${
            syncState === 'error'
              ? 'bg-red-500/10 border-red-500/25 text-red-300'
              : syncState === 'synced'
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                : 'bg-white/5 border-white/10 text-white/60'
          }`}>
            {syncState === 'saving' && <><Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Saving…</>}
            {syncState === 'syncing' && <><RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" /> Syncing Google Sheet…</>}
            {syncState === 'synced' && <><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Google Sheet synced</>}
            {syncState === 'skipped' && (
              <><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Saved. No sheet written — this client&apos;s sheet is not managed by Cirqle.</>
            )}
            {syncState === 'unknown' && (
              <>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 min-w-0">Saved, but the sheet didn&apos;t confirm in time.</span>
                <button onClick={handleRetrySync} className="shrink-0 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 transition-colors flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Retry sync
                </button>
              </>
            )}
            {syncState === 'error' && (
              <>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 min-w-0">Sheet sync failed{syncErrorMsg ? `: ${syncErrorMsg}` : ''}</span>
                <button onClick={handleRetrySync} className="shrink-0 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 transition-colors flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Retry sync
                </button>
              </>
            )}
          </div>
        )}

        {campaignId && (
          <p className="text-center text-xs text-white/25 mt-3">
            You can update this list any time — changes are logged for the Cirqle team.
          </p>
        )}
        </>
        )}

        <p className="text-center text-[11px] text-white/20 mt-8">
          Cirqle Works · cirqle.work · This page is private to {client.name}.
        </p>
       </div>
      </div>

      {/* Catalog picker modal */}
      {showCatalog && (
        <CatalogPicker
          catalog={catalog}
          onSelect={addFromCatalog}
          onClose={() => setShowCatalog(false)}
        />
      )}

      {/* Live validation summary (missing price/image, duplicates, price > MRP). */}
      <ValidationPanel
        products={products}
        issues={validation.issues}
        errors={validation.errors}
        warnings={validation.warnings}
      />
    </div>
  )
}

export default function OfferIntakeClient(props: any) {
  return <OfferIntakeClientInner {...props} />
}
