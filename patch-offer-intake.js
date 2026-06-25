import fs from 'fs'

let file = fs.readFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', 'utf8')

// 1. Add setCatalogPageTarget and update addFromCatalog
let stateMarker = '  const [campaignId, setCampaignId] = useState<string | undefined>(initialCampaign?.id)\n'
let stateAddition = `  const [catalogPageTarget, setCatalogPageTarget] = useState<number>(1)

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
      _key: \`dup-\${Date.now()}-\${Math.random()}\`,
      display_order: order,
    }])
  }
`
file = file.replace(stateMarker, stateMarker + '\n' + stateAddition)

// Update addFromCatalog
const addFromCatOld = `  function addFromCatalog(item: CatalogItem) {
    const order = products.length
    if (!item.id) {
      // New blank product
      setProducts(prev => [...prev, emptyProduct(order)])
    } else {
      // Check not already added
      const already = products.some(p => p.catalog_id === item.id)
      if (already) return
      setProducts(prev => [...prev, {
        _key: \`cat-\${item.id}-\${Date.now()}\`,
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
  }`
const addFromCatNew = `  function addFromCatalog(item: CatalogItem) {
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
        _key: \`cat-\${item.id}-\${Date.now()}\`,
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
        page,
      }])
    }
  }`
file = file.replace(addFromCatOld, addFromCatNew)

// 2. Replace Products Section
const productsSectionStart = '{/* ── Products section ── */}'
const productsSectionEnd = '{/* ── Note to team ── */}'
const pStartIdx = file.indexOf(productsSectionStart)
const pEndIdx = file.indexOf(productsSectionEnd)

const newProductsSection = `{/* ── Products section ── */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3 px-1">
             <h2 className="text-sm font-semibold text-white/70">
               Products <span className="text-white/30">({products.length})</span>
             </h2>
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
                       <button onClick={() => { setCatalogPageTarget(pageNum); setShowCatalog(true) }} className="text-xs font-medium text-white/50 hover:text-white transition-colors flex items-center gap-1">
                         <Search className="w-3 h-3" /> Search past
                       </button>
                     </div>
                   </div>

                   <div className="space-y-2">
                     {pageProducts.map(p => (
                       <ProductRow
                         key={p._key}
                         product={p}
                         badges={badges}
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

        `

file = file.substring(0, pStartIdx) + newProductsSection + file.substring(pEndIdx)

fs.writeFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', file)
console.log('patched OfferIntakeClient loop')
