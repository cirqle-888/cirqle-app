import fs from 'fs'

const file = fs.readFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', 'utf8')

// Replace Lucide imports
const newImports = `import {
  Plus, Loader2, CheckCircle2, Check, X, ChevronDown, ChevronUp,
  Upload, Search, Tag, Calendar, MessageSquare, RefreshCw,
  ImageIcon, Trash2, GripVertical, Copy, FilePlus, CopyPlus
} from 'lucide-react'`
let patched = file.replace(/import \{\n  Plus, Loader2.*?\} from 'lucide-react'/s, newImports)


// Replace ProductRow
const startMarker = 'function ProductRow({'
const endMarker = '  )\n}\n\n// ── Catalog picker modal'

const startIdx = patched.indexOf(startMarker)
const endIdx = patched.indexOf(endMarker) + endMarker.length - ('\n// ── Catalog picker modal'.length)

const newProductRow = `function ProductRow({
  product, badges, catalogImages, onUpdate, onRemove, onUploadImage, uploading,
  onDuplicate, onAddNext
}: {
  product: (ProductInput & { _key: string; id?: string })
  badges: Badge[]
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
    <div className={\`bg-white/5 border \${isExpanded ? 'border-white/20 shadow-xl' : 'border-white/10 hover:border-white/15'} rounded-2xl transition-all overflow-hidden\`}>
      {/* ── Collapsed / Header ── */}
      <div className="flex items-center gap-2 p-3">
        <GripVertical className="w-4 h-4 text-white/20 shrink-0 cursor-grab" />
        
        <div className="flex-1 grid grid-cols-[3fr_2fr] gap-2 items-center">
          <input
            value={product.name}
            onChange={e => onUpdate({ name: e.target.value })}
            className="bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm font-medium focus:outline-none placeholder:text-white/20 w-full"
            placeholder="Product name"
          />
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
             <div className="w-6 h-6 rounded bg-white/5 border border-white/10 overflow-hidden">
               {/* eslint-disable-next-line @next/next/no-img-element */}
               <img src={product.image_url} alt="" className="w-full h-full object-cover" />
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
              <label className={labelCls}>Weight / Size</label>
              <input
                value={product.weight || ''}
                onChange={e => onUpdate({ weight: e.target.value })}
                className={inputCls}
                placeholder="e.g. 1L, 5kg"
              />
            </div>
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
                  className={\`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border \${
                    offerType === t
                      ? 'bg-violet-500/20 text-violet-300 border-violet-500/40'
                      : 'bg-white/5 text-white/50 border-white/10 hover:border-white/20'
                  }\`}
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
                onChange={e => onUpdate({ offer_text: e.target.value ? \`\${e.target.value}% Off\` : '' })}
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
                    className={\`px-2.5 py-1 rounded-lg text-xs border transition-all \${
                      active ? BADGE_COLOR[b.color] || BADGE_COLOR.amber : 'bg-transparent text-white/30 border-white/10 hover:border-white/20 hover:text-white/60'
                    }\`}
                  >
                    {b.label}
                  </button>
                )
              })}
              {productBadges.filter(pb => !pb.badge_id).map((pb, i) => {
                const idx = productBadges.indexOf(pb)
                return (
                  <span key={\`custom-\${i}\`} className={\`px-2.5 py-1 rounded-lg text-xs border flex items-center gap-1 \${BADGE_COLOR[pb.color] || BADGE_COLOR.amber}\`}>
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
                      className={\`w-3 h-3 rounded-full border \${customColor === c ? 'ring-1 ring-white/50' : ''} \${BADGE_COLOR[c].split(' ')[0]}\`} />
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
                    className={\`relative rounded-lg overflow-hidden border \${product.image_url === img.url ? 'border-violet-400' : 'border-white/10'}\`}>
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
`

patched = patched.substring(0, startIdx) + newProductRow + patched.substring(endIdx)

fs.writeFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', patched)
console.log('patched ProductRow')
