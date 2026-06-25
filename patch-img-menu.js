import fs from 'fs'

let file = fs.readFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', 'utf8')

// 1. Add showImgMenu state
const stateOld = `  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)`
const stateNew = `  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [showImgMenu, setShowImgMenu] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)`
file = file.replace(stateOld, stateNew)

// 2. Replace the image button block to add the dropdown menu
const imgBlockOld = `          {product.image_url && !isExpanded && (
             <button 
               onClick={() => {
                 setLightbox(product.image_url!);
                 setIsExpanded(true);
               }}
               className="w-6 h-6 rounded bg-white/5 border border-white/10 overflow-hidden shrink-0 hover:ring-2 hover:ring-violet-500/50 transition-all cursor-pointer"
             >
               {/* eslint-disable-next-line @next/next/no-img-element */}
               <img src={product.image_url} alt="" className="w-full h-full object-cover" />
             </button>
          )}`
const imgBlockNew = `          {product.image_url && !isExpanded && (
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
                         <Images className="w-3.5 h-3.5" /> Past photos
                       </button>
                     )}
                   </div>
                 </>
               )}
             </div>
          )}`
file = file.replace(imgBlockOld, imgBlockNew)

fs.writeFileSync('src/app/intake/offer/[token]/offer-intake-client.tsx', file)
console.log('patched img menu')
