'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { type PresentationHotspot, type PresentationHotspots, type HotspotPoint, type HotspotColour, coverBox, hotspotColour, HOTSPOT_COLOURS, DEFAULT_HOTSPOT_COLOUR } from '@/lib/portfolio/hotspots'
import { type ResolvedMedia } from '@/lib/portfolio/showcase'
import { magicSelect, rectangleFromDrag, movePolygon, movePoint, type Bitmap } from '@/lib/portfolio/trace'
import { listPortfolio } from './actions'

/**
 * Reading pixels needs the image on a canvas, and a canvas tainted by a
 * cross-origin image throws on getImageData. Downsampled to this on its long
 * edge: a poster outline needs nothing finer, and a full-resolution flood
 * fill over a 1536×2752 artwork is slow enough to look broken.
 */
const SAMPLE_MAX = 640

interface Props { value: PresentationHotspots; onChange: (value: PresentationHotspots) => void; desktop: ResolvedMedia | null; mobile: ResolvedMedia | null; disabled: boolean }
export default function HotspotEditor({value,onChange,desktop,mobile,disabled}:Props) {
 const [side,setSide]=useState<'desktop'|'mobile'>('desktop')
 const [selected,setSelected]=useState('')
 const [drawing,setDrawing]=useState(false)
 const [points,setPoints]=useState<HotspotPoint[]>([])
 /** 'rect' drags a box; 'magic' outlines whatever is clicked. */
 const [mode,setMode]=useState<'none'|'rect'|'magic'>('none')
 const [tolerance,setTolerance]=useState(12)
 const [rect,setRect]=useState<{x0:number;y0:number;x1:number;y1:number}|null>(null)
 /** Which vertex, or the whole shape, the pointer is currently moving. */
 const [drag,setDrag]=useState<{kind:'point';index:number}|{kind:'shape';x:number;y:number}|null>(null)
 const [magicNote,setMagicNote]=useState('')
 const bitmapRef=useRef<{url:string;bitmap:Bitmap}|null>(null)
 /**
  * Pointer capture keeps a drag alive when the cursor leaves the element, but
  * it THROWS when the id is not an active pointer. An exception here aborts
  * the handler before the drag state is set, so the shape never moves — the
  * convenience would be the thing that breaks the interaction. Best effort.
  */
 const capture=(el:Element|null|undefined,pointerId:number)=>{try{el?.setPointerCapture(pointerId)}catch{/* drag still works without it */}}
 const [galleries,setGalleries]=useState<{label:string;path:string}[]>([])
 const [loadError,setLoadError]=useState(false)
 const [attempt,setAttempt]=useState(0)
 const [preview,setPreview]=useState(false)
 const [dimensions,setDimensions]=useState({url:'',width:1,height:1})
 const media=side==='desktop'?desktop:mobile
 const rows=value[side], active=rows.find(r=>r.id===selected)
 useEffect(()=>{let live=true;void listPortfolio().then(r=>{if(!live)return;setLoadError(!r.ok);setGalleries((r.data||[]).flatMap(c=>[{label:c.title,path:`/portfolio/${c.slug}`},...c.brands.filter(b=>b.items.some(i=>i.published)).map(b=>({label:`${c.title} / ${b.name}`,path:`/portfolio/${c.slug}/${b.slug}`}))]));}).catch(()=>{if(live)setLoadError(true)});return()=>{live=false}},[attempt])
 useEffect(()=>{if(!media?.url)return;let live=true;const img=new Image();img.onload=()=>{if(live)setDimensions({url:media.url,width:img.naturalWidth,height:img.naturalHeight})};img.src=media.url;return()=>{live=false}},[media?.url])
 const changeRows=(next:PresentationHotspot[])=>onChange({...value,[side]:next})
 const update=(patch:Partial<PresentationHotspot>)=>changeRows(rows.map(r=>r.id===selected?{...r,...patch}:r))

 /** Reset every in-progress interaction. Called whenever the context changes. */
 const stopEditing=useCallback(()=>{setDrawing(false);setPoints([]);setMode('none');setRect(null);setDrag(null)},[])

 /**
  * Pixels for the current artwork, drawn once and cached.
  *
  * Returns null when the browser refuses to hand them over — a cross-origin
  * image with no CORS headers taints the canvas and getImageData throws. That
  * is a real possibility for artwork served from storage, so magic select
  * reports it rather than appearing to do nothing.
  */
 const readBitmap=useCallback(async(url:string):Promise<Bitmap|null>=>{
  if(bitmapRef.current?.url===url)return bitmapRef.current.bitmap
  try{
   const img=new Image();img.crossOrigin='anonymous'
   await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('load'));img.src=url})
   const scale=Math.min(1,SAMPLE_MAX/Math.max(img.naturalWidth,img.naturalHeight))
   const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale))
   const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h
   const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)return null
   ctx.drawImage(img,0,0,w,h)
   const bitmap={data:ctx.getImageData(0,0,w,h).data,width:w,height:h}
   bitmapRef.current={url,bitmap}
   return bitmap
  }catch{return null}
 },[])

 /**
  * Outline whatever sits under the click.
  *
  * A plain function, not a useCallback: it is only ever called from a pointer
  * handler, so memoising it would buy nothing and would mean either listing
  * `add` — which is rebuilt every render — as a dependency or routing around
  * it through a ref.
  */
 async function pickElement(x:number,y:number) {
  if(!media?.url)return
  const bitmap=await readBitmap(media.url)
  if(!bitmap){setMagicNote('This picture cannot be read for automatic outlining. Draw or drag the area instead.');return}
  const outline=magicSelect(bitmap,x,y,{tolerance})
  if(!outline){setMagicNote('No distinct element there. Click inside the artwork itself, or move the tolerance slider.');return}
  setMagicNote('')
  add(outline)
 }

 /**
  * Commit a new area and hand control back for adjusting it.
  *
  * Every drawing mode ends here, including the automatic pick — which is the
  * point: the traced outline is a starting position, and the handles that let
  * someone correct it only render once no tool is armed. Staying in pick mode
  * would also mean the next stray click silently added another area.
  */
 function add(outline:HotspotPoint[]) {const id=crypto.randomUUID();changeRows([...rows,{id,label:'Explore this work',path:'',points:outline}]);setSelected(id);stopEditing()}
 const width=1000,height=side==='desktop'?562.5:2166.67
 const box=coverBox(width,height,dimensions.width,dimensions.height,media?.focalX||0,media?.focalY||0)
 return <fieldset disabled={disabled} className="border border-border rounded-xl p-4 space-y-3 min-w-0">
  <legend className="px-2 text-sm font-semibold">Clickable artwork</legend>
  <p className="text-xs text-muted-foreground">Pick an element to outline it automatically, or drag a box. Then choose its gallery. Desktop and phone areas are saved separately. Recheck areas whenever you replace the picture. Up to 8 per view.</p>
  <div className="flex gap-2">{(['desktop','mobile'] as const).map(v=><button type="button" key={v} aria-pressed={side===v} onClick={()=>{setSide(v);setSelected('');stopEditing();setPreview(false);setMagicNote('')}} className={`px-3 py-2 rounded-lg text-xs border ${side===v?'border-violet-400 bg-violet-500/15':'border-border'}`}>{v==='desktop'?'Desktop':'Phone'} ({value[v].length})</button>)}</div>
  {media?.type==='image'?<>
   <div className="flex gap-2 flex-wrap text-xs">
    <button type="button" disabled={rows.length>=8} aria-pressed={mode==='magic'} onClick={()=>{stopEditing();setMode('magic');setPreview(false);setMagicNote('')}} className={`border rounded-lg px-3 py-2 ${mode==='magic'?'border-violet-400 bg-violet-500/15':''}`}>Pick element</button>
    <button type="button" disabled={rows.length>=8} aria-pressed={mode==='rect'} onClick={()=>{stopEditing();setMode('rect');setPreview(false)}} className={`border rounded-lg px-3 py-2 ${mode==='rect'?'border-violet-400 bg-violet-500/15':''}`}>Drag a box</button>
    <button type="button" disabled={rows.length>=8} aria-pressed={drawing} onClick={()=>{stopEditing();setDrawing(true);setPreview(false)}} className={`border rounded-lg px-3 py-2 ${drawing?'border-violet-400 bg-violet-500/15':''}`}>Draw outline</button>
    <button type="button" onClick={()=>{stopEditing();setPreview(!preview)}} className="border rounded-lg px-3 py-2">{preview?'Edit on full image':'Preview website crop'}</button>
   </div>
   {mode==='magic'&&<div className="space-y-1">
    <p className="text-xs">Click the poster, bag or label you want. Its outline is traced for you — drag any handle afterwards to adjust.</p>
    <label className="flex items-center gap-2 text-xs">Tolerance
     <input type="range" min={4} max={70} step={2} value={tolerance} onChange={e=>setTolerance(Number(e.target.value))} className="flex-1 max-w-[220px]"/>
     <span className="tabular-nums w-7">{tolerance}</span>
    </label>
    <p className="text-xs text-muted-foreground">Lower picks out a flat label; higher takes in shading and gradients. Change it and click again if the first try grabs too much or too little.</p>
   </div>}
   {mode==='rect'&&<p className="text-xs">Drag across the artwork to box an area.</p>}
   {magicNote&&<p className="text-xs text-amber-400" role="status">{magicNote}</p>}
   {drawing&&<div className="text-xs space-x-3"><span>Click around the poster in order (3–16 points).</span><button type="button" disabled={points.length<3} onClick={()=>add(points)} className="underline">Finish outline</button><button type="button" onClick={()=>setPoints(points.slice(0,-1))} className="underline">Undo point</button><button type="button" onClick={stopEditing} className="underline">Cancel</button></div>}
   {dimensions.url===media.url&&<div className="relative overflow-hidden rounded-lg bg-black mx-auto" style={{maxWidth:side==='mobile'?280:undefined}}>
    {/* Handles must look square. The viewBox is 100×100 stretched over the
        image's own aspect ratio (preserveAspectRatio="none"), so a unit of x
        and a unit of y are different numbers of pixels. */}
    {(()=>{const hH=2.4,hW=2.4*((dimensions.height/dimensions.width)||1)
     /**
      * Pointer position as a percentage of the ORIGINAL image.
      *
      * Always measured against the <svg>, never against `currentTarget`: a
      * handler on a polygon or a handle receives that shape as its target, so
      * measuring there gives a fraction of the shape's own bounding box. That
      * put the shape-drag anchor in the wrong place and sent the first move
      * off in the opposite direction.
      */
     const at=(e:{clientX:number;clientY:number;currentTarget:Element})=>{
      const el=e.currentTarget.tagName==='svg'?e.currentTarget:(e.currentTarget as SVGElement).ownerSVGElement
      const r=(el??e.currentTarget).getBoundingClientRect()
      return[Math.round((e.clientX-r.left)/r.width*10000)/100,Math.round((e.clientY-r.top)/r.height*10000)/100] as HotspotPoint
     }
     return <svg role="img" aria-label={preview?'Clickable areas with website crop':'Artwork outline editor'} viewBox={preview?`0 0 ${width} ${height}`:'0 0 100 100'} preserveAspectRatio="none" style={{display:'block',width:'100%',touchAction:'none',aspectRatio:preview?`${width}/${height}`:`${dimensions.width}/${dimensions.height}`,cursor:preview?undefined:drawing||mode!=='none'?'crosshair':undefined}}
      onPointerDown={e=>{
       // Preview is read-only: the image sits inside a transformed crop there,
       // so a pointer position on the SVG is not a position on the artwork.
       if(preview||disabled)return
       const [x,y]=at(e)
       if(mode==='magic'){void pickElement(x,y);return}
       if(mode==='rect'){capture(e.currentTarget,e.pointerId);setRect({x0:x,y0:y,x1:x,y1:y});return}
       if(drawing&&points.length<16){setPoints([...points,[x,y]]);return}
      }}
      onPointerMove={e=>{
       if(preview||disabled)return
       const [x,y]=at(e)
       if(rect){setRect(r=>r&&{...r,x1:x,y1:y});return}
       if(drag&&active){
        if(drag.kind==='point')update({points:movePoint(active.points,drag.index,x,y)})
        else{update({points:movePolygon(active.points,x-drag.x,y-drag.y)});setDrag({kind:'shape',x,y})}
       }
      }}
      onPointerUp={e=>{
       if(rect){const r=rect;setRect(null);setMode('none');if(Math.abs(r.x1-r.x0)>0.2||Math.abs(r.y1-r.y0)>0.2)add(rectangleFromDrag(r.x0,r.y0,r.x1,r.y1));return}
       if(drag){setDrag(null);try{e.currentTarget.releasePointerCapture(e.pointerId)}catch{/* never captured */}}
      }}
      onPointerLeave={()=>{if(rect){setRect(null);setMode('none')}setDrag(null)}}>
      <g transform={preview?`translate(${box.left} ${box.top}) scale(${box.width/100} ${box.height/100})`:undefined}>
       <image href={media.url} width="100" height="100" preserveAspectRatio="none"/>
       {rows.map((r,i)=><g key={r.id}>
        <polygon
         onPointerDown={e=>{if(drawing||disabled||preview||mode!=='none')return;e.stopPropagation();setSelected(r.id);const [x,y]=at(e as unknown as {clientX:number;clientY:number;currentTarget:Element});setDrag({kind:'shape',x,y})}}
         style={{cursor:!preview&&!drawing&&mode==='none'?'move':undefined}}
         points={r.points.map(p=>p.join(',')).join(' ')}
         fill={hotspotColour(r.color)+(r.id===selected?'44':'18')}
         stroke={hotspotColour(r.color)} strokeOpacity={r.id===selected?1:0.65}
         strokeWidth={2} vectorEffect="non-scaling-stroke"/>
        <text x={r.points[0][0]} y={r.points[0][1]} fill="white" fontSize="3" pointerEvents="none">{i+1}</text>
       </g>)}
       {/* Drag handles on the selected shape — the direct way to fix an edge
           the trace got slightly wrong, instead of typing numbers. */}
       {!preview&&!drawing&&mode==='none'&&active?.points.map((pt,i)=><rect key={i}
        x={pt[0]-hW/2} y={pt[1]-hH/2} width={hW} height={hH} rx={hW/3}
        fill={drag&&drag.kind==='point'&&drag.index===i?'#fff':hotspotColour(active.color)} stroke="#120b1e" strokeWidth={1} vectorEffect="non-scaling-stroke"
        style={{cursor:'grab'}}
        onPointerDown={e=>{if(disabled)return;e.stopPropagation();capture(e.currentTarget.ownerSVGElement,e.pointerId);setDrag({kind:'point',index:i})}}/>)}
       {drawing&&<polyline points={points.map(p=>p.join(',')).join(' ')} fill="#a259ff33" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke"/>}
       {rect&&<rect x={Math.min(rect.x0,rect.x1)} y={Math.min(rect.y0,rect.y1)} width={Math.abs(rect.x1-rect.x0)} height={Math.abs(rect.y1-rect.y0)} fill="#a259ff33" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none"/>}
      </g>
      {preview&&<g fill="#17102099" pointerEvents="none">{side==='desktop'?<><rect x="0" y="110" width="250" height="370"/><rect x="750" y="405" width="250" height="157"/></>:<><rect x="0" y="0" width="1000" height="450"/><rect x="0" y="1640" width="1000" height="527"/></>}</g>}
     </svg>})()}
   </div>}
   {!preview&&active&&mode==='none'&&!drawing&&<p className="text-xs text-muted-foreground">Drag a handle to move a corner, or drag inside the shape to move the whole area.</p>}
   {preview&&<p className="text-xs text-muted-foreground">Shaded regions approximate website controls. Keep clickable posters clear of these areas; other screen sizes may crop differently.</p>}
  </>:<p className="text-xs text-muted-foreground">Add a still image to place clickable areas. Video hotspots are disabled because moving artwork would leave a fixed outline behind.</p>}
  <div className="flex gap-2 flex-wrap">{rows.map((r,i)=><button key={r.id} type="button" aria-pressed={r.id===selected} className="text-xs border rounded px-2 py-1" onClick={()=>setSelected(r.id)}>{i+1}. {r.label}</button>)}</div>
  {active&&<div className="space-y-3 border-t border-border pt-3">
   <label className="block text-xs">Hover label<input className="mt-1 w-full rounded border border-border bg-background p-2" maxLength={80} value={active.label} onChange={e=>update({label:e.target.value})}/></label>
   <div className="text-xs">
    <span className="block mb-1.5">Glow colour</span>
    <div className="flex gap-2 flex-wrap">{(Object.keys(HOTSPOT_COLOURS) as HotspotColour[]).map(key=>{
     const chosen=(active.color??DEFAULT_HOTSPOT_COLOUR)===key
     return <button key={key} type="button" aria-label={key} aria-pressed={chosen} title={key==='brand'?'Cirqle brand violet (default)':key}
      onClick={()=>update({color:key===DEFAULT_HOTSPOT_COLOUR?null:key})}
      className={`w-7 h-7 rounded-full border-2 transition-transform ${chosen?'border-foreground scale-110':'border-transparent'}`}
      style={{background:HOTSPOT_COLOURS[key],boxShadow:chosen?`0 0 10px ${HOTSPOT_COLOURS[key]}`:undefined}}/>
    })}</div>
    <p className="text-muted-foreground mt-1.5">The neon glow and outline shown when a visitor hovers this area. Brand violet unless you change it.</p>
   </div>
   <label className="block text-xs">Gallery<select className="mt-1 w-full rounded border border-border bg-background p-2" value={active.path} onChange={e=>update({path:e.target.value})}><option value="">Choose a gallery</option>{active.path&&!galleries.some(g=>g.path===active.path)&&<option value={active.path}>{active.path}</option>}{galleries.map(g=><option key={g.path} value={g.path}>{g.label}</option>)}</select></label>
   {loadError&&<p className="text-xs" role="alert">Could not load galleries. <button type="button" className="underline" onClick={()=>setAttempt(n=>n+1)}>Retry</button></p>}
   <details><summary className="text-xs cursor-pointer">Adjust outline points precisely</summary><p className="text-xs text-muted-foreground my-2">X and Y are percentages of the original image. Adjust these with the keyboard or redraw the outline.</p><div className="grid grid-cols-2 gap-2">{active.points.map((point,i)=><div key={i} className="flex gap-1">{point.map((n,axis)=><label key={axis} className="text-xs">{i+1} {axis===0?'X':'Y'}<input type="number" min={0} max={100} step={0.1} value={n} className="w-full bg-background border border-border rounded p-1" onChange={e=>{const copy=active.points.map(p=>[...p] as HotspotPoint);copy[i][axis]=Math.max(0,Math.min(100,Number(e.target.value)));update({points:copy})}}/></label>)}</div>)}</div></details>
   <button type="button" onClick={()=>{changeRows(rows.filter(r=>r.id!==selected));setSelected('')}} className="text-xs text-red-400 underline">Remove clickable area</button>
  </div>}
 </fieldset>
}
