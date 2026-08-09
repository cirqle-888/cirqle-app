'use client'

import { useState, useRef, useMemo } from 'react'
import Link from 'next/link'
import {
  Search, Plus, Upload, ImageIcon, Tag, Building2, Filter,
  X, Check, Loader2, Pencil, Users, ChevronDown, ChevronUp,
  Package, AlertCircle, ExternalLink, RefreshCw, Trash2, Star,
} from 'lucide-react'
import {
  createProduct, updateProduct, assignProductToClients,
  removeClientAssignment, getProductImageUploadUrl, saveProductImage,
  setPrimaryImage, deleteProductImage,
} from './actions'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPrimaryImage(product: any): string | null {
  const images: any[] = product.images || []
  return images.find(i => i.is_primary)?.url || images[0]?.url || product.image_url || null
}

function getAssignedClientCount(product: any): number {
  return (product.assignments || []).filter((a: any) => a.is_active).length
}

// ── Add / Edit product modal ──────────────────────────────────────────────────

function ProductModal({
  product,
  clients,
  onClose,
  onSaved,
}: {
  product?: any
  clients: { id: string; name: string }[]
  onClose: () => void
  onSaved: (p: any) => void
}) {
  const isEdit = !!product
  const [name, setName] = useState(product?.name || '')
  const [weight, setWeight] = useState(product?.weight || '')
  const [category, setCategory] = useState(product?.category || '')
  const [brand, setBrand] = useState(product?.brand || '')
  const [barcode, setBarcode] = useState(product?.barcode || '')
  const [notes, setNotes] = useState(product?.notes || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function handleSave() {
    if (!name.trim()) { setErr('Product name is required.'); return }
    setSaving(true); setErr('')
    const row = { name, weight, category, brand, barcode, notes }
    let res
    if (isEdit) {
      res = await updateProduct(product.id, row)
      if (res.ok) onSaved({ ...product, ...row })
    } else {
      res = await createProduct(row)
      if (res.ok && (res as any).data) onSaved((res as any).data.product)
    }
    setSaving(false)
    if (!res.ok) setErr(res.error || 'Could not save.')
    else onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border border-border rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold">{isEdit ? 'Edit product' : 'Add product'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>Product name *</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="e.g. Sunflower Oil" />
          </div>
          <div>
            <label className={labelCls}>Weight / Size</label>
            <input value={weight} onChange={e => setWeight(e.target.value)} className={inputCls} placeholder="e.g. 1L, 5kg" />
          </div>
          <div>
            <label className={labelCls}>Category</label>
            <input value={category} onChange={e => setCategory(e.target.value)} className={inputCls} placeholder="e.g. Oils & Fats" />
          </div>
          <div>
            <label className={labelCls}>Brand</label>
            <input value={brand} onChange={e => setBrand(e.target.value)} className={inputCls} placeholder="e.g. Fortune" />
          </div>
          <div>
            <label className={labelCls}>Barcode <span className="text-muted-foreground/50">(optional)</span></label>
            <input value={barcode} onChange={e => setBarcode(e.target.value)} className={inputCls} placeholder="e.g. 8901234567890" />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Notes</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} placeholder="Internal notes" />
          </div>
        </div>
        {err && <p className="text-xs text-red-400 mt-3 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{err}</p>}
        <div className="flex gap-2 mt-5">
          <button onClick={handleSave} disabled={saving || !name.trim()}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {isEdit ? 'Save changes' : 'Add product'}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-xl bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Product card ──────────────────────────────────────────────────────────────

function ProductCard({
  product, clients, onUpdate,
}: {
  product: any
  clients: { id: string; name: string }[]
  onUpdate: (p: any) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showAssign, setShowAssign] = useState(false)
  const [imgUploading, setImgUploading] = useState(false)
  const [assignBusy, setAssignBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState('')
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [imgBusy, setImgBusy] = useState<string | null>(null)
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so the delete button
  // would silently do nothing there.
  const [deleteImgTarget, setDeleteImgTarget] = useState<any | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Newest-first — uploading a new image should surface it ahead of older ones.
  const sortedImages = [...(product.images || [])].sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''))

  const img = getPrimaryImage(product)
  const assignedIds = new Set((product.assignments || []).filter((a: any) => a.is_active).map((a: any) => a.client_id))
  const assignedCount = assignedIds.size

  function showFlash(msg: string) { setFlash(msg); setTimeout(() => setFlash(''), 3000) }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImgUploading(true)
    const urlRes = await getProductImageUploadUrl(product.id, file.name, file.type)
    if (!urlRes.ok || !urlRes.data) { setImgUploading(false); showFlash('Upload failed'); return }
    const { uploadUrl, publicUrl, storagePath } = urlRes.data
    const uploadRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
    if (!uploadRes.ok) { setImgUploading(false); showFlash('Upload failed'); return }
    const saveRes = await saveProductImage(product.id, publicUrl, storagePath, 'original', true)
    const newImage = {
      id: saveRes.ok ? (saveRes as any).data?.imageId : `tmp-${Date.now()}`,
      version: 'original', url: publicUrl, is_primary: true, created_at: new Date().toISOString(),
    }
    onUpdate({
      ...product,
      image_url: publicUrl,
      images: [newImage, ...(product.images || []).map((i: any) => ({ ...i, is_primary: false }))],
    })
    setImgUploading(false)
    showFlash('Image added — set as primary ✓')
    e.target.value = ''
  }

  async function handleSetPrimary(imageId: string, url: string) {
    setImgBusy(imageId)
    const res = await setPrimaryImage(product.id, imageId)
    if (res.ok) {
      onUpdate({
        ...product,
        image_url: url,
        images: (product.images || []).map((i: any) => ({ ...i, is_primary: i.id === imageId })),
      })
    } else showFlash(res.error || 'Could not set primary')
    setImgBusy(null)
  }

  async function handleDeleteImage(imageId: string) {
    setImgBusy(imageId)
    const res = await deleteProductImage(imageId)
    if (res.ok) {
      const remaining = (product.images || []).filter((i: any) => i.id !== imageId)
      const wasPrimary = !remaining.some((i: any) => i.is_primary)
      const next = wasPrimary ? [...remaining].sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''))[0] : null
      onUpdate({
        ...product,
        image_url: next ? next.url : (wasPrimary ? null : product.image_url),
        images: next ? remaining.map((i: any) => ({ ...i, is_primary: i.id === next.id })) : remaining,
      })
    } else showFlash(res.error || 'Could not delete image')
    setImgBusy(null)
  }

  async function handleToggleClient(clientId: string) {
    setAssignBusy(clientId)
    if (assignedIds.has(clientId)) {
      await removeClientAssignment(product.id, clientId)
      const newAssignments = (product.assignments || []).filter((a: any) => a.client_id !== clientId)
      onUpdate({ ...product, assignments: newAssignments })
    } else {
      await assignProductToClients(product.id, [clientId])
      const client = clients.find(c => c.id === clientId)
      const newAssignments = [...(product.assignments || []), { client_id: clientId, is_active: true, client }]
      onUpdate({ ...product, assignments: newAssignments })
    }
    setAssignBusy(null)
  }

  return (
    <>
      {editing && (
        <ProductModal
          product={product}
          clients={clients}
          onClose={() => setEditing(false)}
          onSaved={p => { onUpdate(p); setEditing(false) }}
        />
      )}
      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        {/* Card header */}
        <div className="flex items-start gap-3 p-4">
          {/* Image */}
          <div className="relative shrink-0 group">
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={img} alt={product.name} className="w-14 h-14 rounded-xl object-cover border border-border" />
            ) : (
              <div className="w-14 h-14 rounded-xl bg-secondary border border-border flex items-center justify-center">
                <ImageIcon className="w-5 h-5 text-muted-foreground/30" />
              </div>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={imgUploading}
              className="absolute inset-0 rounded-xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
            >
              {imgUploading ? <Loader2 className="w-4 h-4 animate-spin text-white" /> : <Upload className="w-4 h-4 text-white" />}
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground leading-tight truncate">{product.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {[product.weight, product.brand, product.category].filter(Boolean).join(' · ') || '—'}
                </p>
                <p className="text-[10px] text-muted-foreground/50 mt-0.5 font-mono">{product.product_code}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => setEditing(true)}
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setExpanded(e => !e)}
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                  {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Tags row */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {product.status === 'inactive' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground border border-border">Inactive</span>
              )}
              <button
                onClick={() => { setExpanded(true); setShowAssign(true) }}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors"
              >
                <Users className="w-2.5 h-2.5" /> {assignedCount} client{assignedCount !== 1 ? 's' : ''}
              </button>
              {product.barcode && (
                <span className="text-[10px] text-muted-foreground/50 font-mono">{product.barcode}</span>
              )}
            </div>
          </div>
        </div>

        {/* Flash */}
        {flash && (
          <div className="mx-4 mb-3 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-400 flex items-center gap-1.5">
            <Check className="w-3 h-3" /> {flash}
          </div>
        )}

        {/* Expanded */}
        {expanded && (
          <div className="border-t border-border px-4 py-4 space-y-4">
            {/* Client assignment */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" /> Assigned clients
                </p>
                <button
                  onClick={() => setShowAssign(a => !a)}
                  className="text-xs text-violet-400 hover:underline"
                >{showAssign ? 'Done' : 'Edit'}</button>
              </div>
              {showAssign ? (
                <div className="grid grid-cols-2 gap-1.5">
                  {clients.map(c => {
                    const active = assignedIds.has(c.id)
                    return (
                      <button
                        key={c.id}
                        onClick={() => handleToggleClient(c.id)}
                        disabled={assignBusy === c.id}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs border transition-all ${
                          active
                            ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30'
                            : 'bg-secondary/50 text-muted-foreground border-border hover:border-violet-500/30'
                        }`}
                      >
                        {assignBusy === c.id
                          ? <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                          : active ? <Check className="w-3 h-3 shrink-0" /> : <div className="w-3 h-3 shrink-0" />}
                        <span className="truncate">{c.name}</span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {assignedCount === 0
                    ? <p className="text-xs text-muted-foreground/40">Not assigned to any client</p>
                    : (product.assignments || []).filter((a: any) => a.is_active).map((a: any) => (
                      <span key={a.client_id} className="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20">
                        {a.client?.name || a.client_id}
                      </span>
                    ))
                  }
                </div>
              )}
            </div>

            {/* Images section — newest first; click to enlarge, hover to set primary / delete */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5" /> Images
              </p>
              <div className="flex gap-2 flex-wrap">
                {sortedImages.map((img: any) => (
                  <div key={img.id} className="relative group">
                    <button onClick={() => setLightboxUrl(img.url)} className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={product.name} className="w-16 h-16 rounded-lg object-cover border border-border" />
                    </button>
                    <span className="absolute bottom-0 left-0 right-0 text-center text-[9px] bg-black/60 text-white rounded-b-lg py-0.5 capitalize pointer-events-none">
                      {img.version}
                    </span>
                    {img.is_primary && (
                      <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-violet-500 border border-background" title="Primary" />
                    )}
                    {/* Hover actions */}
                    <div className="absolute inset-0 rounded-lg bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                      {imgBusy === img.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
                      ) : (
                        <>
                          {!img.is_primary && (
                            <button onClick={() => handleSetPrimary(img.id, img.url)} title="Set as primary"
                              className="p-1 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors">
                              <Star className="w-3 h-3" />
                            </button>
                          )}
                          <button onClick={() => setDeleteImgTarget(img)} title="Delete"
                            className="p-1 rounded-md bg-white/10 hover:bg-red-500/40 text-white transition-colors">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={imgUploading}
                  className="w-16 h-16 rounded-lg border border-dashed border-border hover:border-violet-500/40 flex flex-col items-center justify-center gap-1 text-muted-foreground/40 hover:text-violet-400 transition-colors"
                >
                  {imgUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  <span className="text-[9px]">Add</span>
                </button>
              </div>
              {sortedImages.length > 1 && (
                <p className="text-[10px] text-muted-foreground/50 mt-1.5">Sorted newest first · ⭐ sets primary · the newest upload becomes primary automatically</p>
              )}
            </div>
          </div>
        )}
      </div>
      {lightboxUrl && <ImageLightbox src={lightboxUrl} alt={product.name} onClose={() => setLightboxUrl(null)} />}
      {deleteImgTarget && (
        <ConfirmDialog
          title="Delete this image?"
          body={`It is erased from storage and disappears everywhere ${product.name} is shown, including offers already sent to clients.${deleteImgTarget.is_primary ? ' The next newest image becomes the main one.' : ''}`}
          confirmLabel="Delete image"
          danger
          onConfirm={() => { const id = deleteImgTarget.id; setDeleteImgTarget(null); void handleDeleteImage(id) }}
          onCancel={() => setDeleteImgTarget(null)}
        />
      )}
    </>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CatalogClient({
  initialProducts, clients, categories, brands,
}: {
  initialProducts: any[]
  clients: { id: string; name: string }[]
  categories: string[]
  brands: string[]
}) {
  const [products, setProducts] = useState(initialProducts)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterBrand, setFilterBrand] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterStatus, setFilterStatus] = useState('active')
  const [showAdd, setShowAdd] = useState(false)

  const filtered = useMemo(() => products.filter(p => {
    if (filterStatus && filterStatus !== 'all' && p.status !== filterStatus) return false
    if (filterCat && p.category !== filterCat) return false
    if (filterBrand && p.brand !== filterBrand) return false
    if (filterClient) {
      const assigned = (p.assignments || []).some((a: any) => a.is_active && a.client_id === filterClient)
      if (!assigned) return false
    }
    if (search) {
      const q = search.toLowerCase()
      return p.name.toLowerCase().includes(q)
        || (p.brand || '').toLowerCase().includes(q)
        || (p.category || '').toLowerCase().includes(q)
        || (p.barcode || '').includes(q)
        || (p.product_code || '').toLowerCase().includes(q)
    }
    return true
  }), [products, search, filterCat, filterBrand, filterClient, filterStatus])

  function handleProductUpdate(updated: any) {
    setProducts(prev => prev.map(p => p.id === updated.id ? updated : p))
  }

  function handleProductAdded(newProduct: any) {
    setProducts(prev => [newProduct, ...prev].sort((a, b) => a.name.localeCompare(b.name)))
  }

  const totalActive = products.filter(p => p.status === 'active').length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-border">
        {/* pl-12 on mobile clears the fixed global sidebar hamburger. */}
        <div className="flex items-start justify-between gap-4 mb-4 pl-12 md:pl-0">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Package className="w-5 h-5 text-violet-400" /> Product Catalog
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">{totalActive} active products · shared across all clients</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Link
              href="/dashboard/catalog/import"
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Upload className="w-4 h-4" /> Bulk import
            </Link>
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" /> Add product
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, brand, barcode, code…"
              className="w-full bg-secondary border border-border rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
            />
          </div>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All status</option>
          </select>
          {categories.length > 0 && (
            <select value={filterCat} onChange={e => setFilterCat(e.target.value)}
              className="bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none">
              <option value="">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {brands.length > 0 && (
            <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)}
              className="bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none">
              <option value="">All brands</option>
              {brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
            className="bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none">
            <option value="">All clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {(search || filterCat || filterBrand || filterClient) && (
            <button onClick={() => { setSearch(''); setFilterCat(''); setFilterBrand(''); setFilterClient('') }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl bg-secondary border border-border text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Product grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Package className="w-12 h-12 text-muted-foreground/20 mb-4" />
            <p className="text-sm text-muted-foreground mb-1">
              {products.length === 0 ? 'No products in catalog yet' : 'No products match your filters'}
            </p>
            {products.length === 0 && (
              <div className="flex gap-2 mt-4">
                <Link href="/dashboard/catalog/import"
                  className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-xl gradient-bg text-white hover:opacity-90">
                  <Upload className="w-4 h-4" /> Bulk import from Excel
                </Link>
                <button onClick={() => setShowAdd(true)}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-xl bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground">
                  <Plus className="w-4 h-4" /> Add one product
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground/50 mb-4">{filtered.length} product{filtered.length !== 1 ? 's' : ''}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map(p => (
                <ProductCard
                  key={p.id}
                  product={p}
                  clients={clients}
                  onUpdate={handleProductUpdate}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Add product modal */}
      {showAdd && (
        <ProductModal
          clients={clients}
          onClose={() => setShowAdd(false)}
          onSaved={p => { handleProductAdded(p); setShowAdd(false) }}
        />
      )}
    </div>
  )
}
