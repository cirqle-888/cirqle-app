import fs from 'fs'

let file = fs.readFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', 'utf8')

// 1. Update ProductRow signature
const prSignatureOld = `function ProductRow({
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
}) {`
const prSignatureNew = `function ProductRow({
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
}) {`
file = file.replace(prSignatureOld, prSignatureNew)

// 2. Add Autocomplete state and logic
const stateOld = `  const [isExpanded, setIsExpanded] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)`
const stateNew = `  const [isExpanded, setIsExpanded] = useState(false)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const searchMatch = product.name?.trim().length > 1 
    ? catalog.filter(c => c.name.toLowerCase().includes(product.name.toLowerCase()) || (c.category || '').toLowerCase().includes(product.name.toLowerCase())).slice(0, 6)
    : []`
file = file.replace(stateOld, stateNew)

// 3. Update Name input
const inputOld = `          <input
            value={product.name}
            onChange={e => onUpdate({ name: e.target.value })}
            className="bg-transparent border border-transparent hover:border-white/10 focus:bg-white/5 focus:border-violet-500/50 rounded-lg px-2 py-1.5 text-sm font-medium focus:outline-none placeholder:text-white/20 w-full"
            placeholder="Product name"
          />`
const inputNew = `          <div className="relative">
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
                        name: item.name,
                        weight: item.weight || product.weight || '',
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
          </div>`
file = file.replace(inputOld, inputNew)

// 4. Pass catalog to ProductRow in main map
const prMapOld = `<ProductRow
                         key={p._key}
                         product={p}
                         badges={badges}
                         catalogImages={catalog.find(c => c.id === p.catalog_id)?.images}`
const prMapNew = `<ProductRow
                         key={p._key}
                         product={p}
                         badges={badges}
                         catalog={catalog}
                         catalogImages={catalog.find(c => c.id === p.catalog_id)?.images}`
file = file.replace(prMapOld, prMapNew)

fs.writeFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', file)
console.log('patched autocomplete')
