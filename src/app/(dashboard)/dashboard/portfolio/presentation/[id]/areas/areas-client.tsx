'use client'

/**
 * The clickable-areas editor.
 *
 * Six ways to make an area, because no single one works on every artwork:
 *
 *   · Pick element  — colour-region growing with an edge barrier. Good where
 *                     an element has a real boundary, poor where it blends in.
 *   · Brush / Erase — paint the shape by hand. The last resort that always
 *                     works, and the first resort for a shape nothing else
 *                     can describe.
 *   · Remove background — the U²-Net cut-out already in this app, turned into
 *                     a selection: its alpha becomes paint you can then fix.
 *   · Upload mask   — paint the areas in Photoshop and drop the file in.
 *   · Drag a box    — for a rectangle.
 *   · Draw outline  — click the corners.
 *
 * Painted, uploaded and removed-background masks all reach the areas through
 * `regionsFromMask`, so they cannot disagree about what counts as a shape.
 *
 * Everything is undoable. The history holds whole snapshots of the areas (see
 * lib/portfolio/history) — a handful of polygons, so a snapshot is cheap — and
 * one brush DRAG is one undo step rather than one per sampled point.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Undo2, Redo2, Wand2, Square, PenLine, Brush, Eraser,
  Upload, Scissors, Save, Trash2, Loader2, Check, ZoomIn,
} from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  type ShowcaseEntry, type ResolvedMedia, resolveForViewport,
} from '@/lib/portfolio/showcase'
import {
  type PresentationHotspot, type PresentationHotspots, type HotspotPoint, type HotspotColour,
  readHotspots, hotspotGlowStrength, hotspotColour, hotspotGlow, hasGradient, normaliseGlowColour,
  HOTSPOT_COLOURS, DEFAULT_HOTSPOT_COLOUR,
} from '@/lib/portfolio/hotspots'
import { magicSelect, rectangleFromDrag, movePolygon, movePoint, type Bitmap } from '@/lib/portfolio/trace'
import { detectMaskRegions, regionsFromMask } from '@/lib/portfolio/mask-regions'
import {
  createPaintMask, clearPaint, isPaintEmpty, strokeBrush, paintFromAlpha,
  type PaintMask,
} from '@/lib/portfolio/brush'
import {
  initHistory, pushHistory, undo as undoHistory, redo as redoHistory,
  canUndo, canRedo, resetHistory, type History,
} from '@/lib/portfolio/history'
import { saveShowcaseHotspots } from '../../../showcase-actions'

/** Sampling resolution for reading artwork pixels. */
const SAMPLE_MAX = 640
/** The stored format's ceiling, per side. */
const MAX_AREAS = 8

type Tool = 'none' | 'magic' | 'rect' | 'outline' | 'brush' | 'erase'
type Side = 'desktop' | 'mobile'

export default function AreasClient({
  showcase, galleries,
}: {
  showcase: ShowcaseEntry
  galleries: { label: string; path: string }[]
}) {
  const router = useRouter()
  const toast = useToast()

  const [history, setHistory] = useState<History<PresentationHotspots>>(
    () => initHistory(readHotspots(showcase.hotspots)),
  )
  const hotspots = history.present
  const [saved, setSaved] = useState<PresentationHotspots>(hotspots)
  const dirty = JSON.stringify(hotspots) !== JSON.stringify(saved)

  const [side, setSide] = useState<Side>('desktop')
  const [selected, setSelected] = useState('')
  const [tool, setTool] = useState<Tool>('none')
  const [tolerance, setTolerance] = useState(12)
  const [brushSize, setBrushSize] = useState(6)
  const [zoom, setZoom] = useState(1)
  const [focus, setFocus] = useState<HotspotPoint>([50, 50])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [saving, setSaving] = useState(false)

  const [outline, setOutline] = useState<HotspotPoint[]>([])
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [drag, setDrag] = useState<
    | { kind: 'point'; index: number }
    | { kind: 'shape'; x: number; y: number }
    | { kind: 'pan'; x: number; y: number }
    | { kind: 'paint'; last: HotspotPoint; stroke: string }
    | null
  >(null)

  /**
   * The paint buffer lives in a ref, not in state.
   *
   * A stroke mutates it hundreds of times per drag, and every one of those
   * handlers closes over the render it was created in — so a buffer kept in
   * state is read stale, each dab lands on a different copy, and the one that
   * survives has almost nothing on it. A ref is the single buffer every
   * handler writes to; `paintVersion` is the state that tells React something
   * changed.
   */
  const paintRef = useRef<PaintMask | null>(null)
  const [paintVersion, setPaintVersion] = useState(0)
  /**
   * Whether the buffer is blank, mirrored into state.
   *
   * Derived rather than read off the ref during render: a ref read while
   * rendering is not reactive and is not safe under concurrent rendering, so
   * the buttons that depend on "is anything painted" track it here instead.
   */
  const [noPaint, setNoPaint] = useState(true)

  /**
   * Display size of the artwork, in pixels, measured rather than left to CSS.
   *
   * An SVG with a viewBox has no intrinsic size, so `height:100%` inside a
   * shrink-to-fit flex child resolves against a parent whose own height
   * depends on the child — and the element lays out at 0×0. Every pointer
   * coordinate then divides by a zero-width rect, which is silent: the tools
   * simply do nothing. Measuring the stage and computing the fit is one
   * ResizeObserver and no CSS puzzle.
   */
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box) setStage({ width: box.width, height: box.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const bitmapRef = useRef<{ url: string; bitmap: Bitmap } | null>(null)
  const maskInput = useRef<HTMLInputElement>(null)
  const replaceMaskInput = useRef<HTMLInputElement>(null)
  const importContext = useRef('')
  const paintCanvas = useRef<HTMLCanvasElement>(null)

  const media: ResolvedMedia | null = useMemo(() => {
    const resolved = resolveForViewport(showcase, side)
    // On phones with no own file the website shows the desktop media; areas
    // are still stored separately, so editing that is legitimate.
    return resolved.url ? resolved : null
  }, [showcase, side])

  const [dimensions, setDimensions] = useState({ url: '', width: 1, height: 1 })
  useEffect(() => {
    if (!media?.url) return
    let live = true
    const img = new Image()
    img.onload = () => { if (live) setDimensions({ url: media.url, width: img.naturalWidth, height: img.naturalHeight }) }
    img.src = media.url
    return () => { live = false }
  }, [media?.url])

  const rows = hotspots[side]
  const active = rows.find(r => r.id === selected)
  const contextKey = JSON.stringify([side, media?.url, hotspots, selected])
  useEffect(() => { importContext.current = contextKey; return () => { importContext.current = '' } }, [contextKey])

  // ── Editing the areas, always through the history ────────────────────────
  const commit = useCallback((next: PresentationHotspots, tag?: string) => {
    setHistory(h => pushHistory(h, next, tag))
  }, [])
  const setRows = useCallback((next: PresentationHotspot[], tag?: string) => {
    commit({ ...hotspots, [side]: next }, tag)
  }, [commit, hotspots, side])
  const update = useCallback((patch: Partial<PresentationHotspot>, tag?: string) => {
    setRows(rows.map(r => (r.id === selected ? { ...r, ...patch } : r)), tag)
  }, [rows, selected, setRows])

  const stopTool = useCallback(() => {
    setTool('none'); setOutline([]); setRect(null); setDrag(null)
  }, [])

  function addAreas(polygons: HotspotPoint[][]): number {
    const room = MAX_AREAS - rows.length
    if (room <= 0) { setNote(`This view already has the maximum of ${MAX_AREAS} areas.`); return 0 }
    const made = polygons.slice(0, room).map(points => ({
      id: crypto.randomUUID(), label: 'Explore this work', path: '', points, color: null, colorTo: null,
    }))
    setRows([...rows, ...made])
    if (made.length) setSelected(made[made.length - 1].id)
    stopTool()
    return made.length
  }

  // ── Pixels ───────────────────────────────────────────────────────────────
  const readBitmap = useCallback(async (url: string, skipCache = false): Promise<Bitmap | null> => {
    if (!skipCache && bitmapRef.current?.url === url) return bitmapRef.current.bitmap
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('load')); img.src = url })
      const scale = Math.min(1, (skipCache ? 1600 : SAMPLE_MAX) / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * scale))
      const h = Math.max(1, Math.round(img.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(img, 0, 0, w, h)
      const bitmap = { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h }
      if (!skipCache) bitmapRef.current = { url, bitmap }
      return bitmap
    } catch { return null }
  }, [])

  async function pickElement(x: number, y: number) {
    if (!media?.url) return
    const bitmap = await readBitmap(media.url)
    if (!bitmap) { setNote('This picture cannot be read for automatic outlining. Use the brush or a mask instead.'); return }
    const found = magicSelect(bitmap, x, y, { tolerance })
    if (!found) { setNote('No distinct element there. Click inside the artwork, or move the tolerance slider.'); return }
    setNote('')
    addAreas([found])
  }

  // ── Paint ────────────────────────────────────────────────────────────────
  const ensurePaint = useCallback((): PaintMask => {
    if (!paintRef.current) paintRef.current = createPaintMask(dimensions.width, dimensions.height)
    return paintRef.current
  }, [dimensions])

  /** The buffer changed: redraw the overlay and re-derive whether it is blank. */
  const touchPaint = useCallback(() => {
    const mask = paintRef.current
    setNoPaint(!mask || isPaintEmpty(mask))
    setPaintVersion(v => v + 1)
  }, [])

  function paintAt(from: HotspotPoint, to: HotspotPoint, erase: boolean) {
    strokeBrush(ensurePaint(), from, to, brushSize, erase)
    touchPaint()
  }

  const wipePaint = useCallback(() => {
    paintRef.current = paintRef.current ? clearPaint(paintRef.current) : null
    touchPaint()
  }, [touchPaint])

  function areasFromPaint() {
    const paint = paintRef.current
    if (!paint || isPaintEmpty(paint)) { setNote('Nothing is painted yet.'); return }
    const { regions, ignoredSpecks } = regionsFromMask(paint.data, paint.width, paint.height, {
      maxRegions: MAX_AREAS - rows.length,
    })
    if (!regions.length) { setNote('The painted shape is too small to become an area.'); return }
    const made = addAreas(regions)
    wipePaint()
    setNote(`Made ${made} area${made === 1 ? '' : 's'} from the paint.${ignoredSpecks ? ` ${ignoredSpecks} speck${ignoredSpecks === 1 ? '' : 's'} ignored.` : ''}`)
  }

  /** Background removal, used as a selection rather than as an image edit. */
  async function cutOutSubject() {
    if (!media?.url) return
    setNote('')
    setBusy('Finding the subject… the first run downloads the model.')
    try {
      const { removeBackground } = await import('@/lib/images/remove-background')
      const source = await fetch(media.url).then(r => r.blob())
      const cut = await removeBackground(source)
      const url = URL.createObjectURL(cut)
      try {
        const bitmap = await readBitmap(url, true)
        if (!bitmap) { setNote('Could not read the cut-out.'); return }
        const next = paintFromAlpha(bitmap.data, bitmap.width, bitmap.height)
        if (isPaintEmpty(next)) { setNote('Nothing stood out from the background here.'); return }
        paintRef.current = next
        touchPaint()
        setTool('brush')
        setNote('Subject painted. Tidy it with the brush or eraser, then "Make areas from paint".')
      } finally { URL.revokeObjectURL(url) }
    } catch {
      setNote('Background removal failed. Use the brush or upload a mask instead.')
    } finally { setBusy('') }
  }

  async function importMask(file: File, replaceId?: string) {
    const startedContext = importContext.current
    setNote('')
    setBusy('Reading the mask…')
    const url = URL.createObjectURL(file)
    try {
      const bitmap = await readBitmap(url, true)
      if (!bitmap) { setNote('That file could not be read as an image.'); return }
      if (startedContext !== importContext.current) { setNote('The artwork or selection changed. Please upload the mask again.'); return }
      if (dimensions.url !== media?.url || Math.abs((bitmap.width / bitmap.height) / (dimensions.width / dimensions.height) - 1) > 0.01) {
        setNote('Use the full artwork canvas with the same aspect ratio. Do not crop the mask around the object.'); return
      }
      const { regions, ignoredSpecks, ignoredOverflow } = detectMaskRegions(bitmap, { maxRegions: replaceId ? 2 : MAX_AREAS - rows.length, maxPoints: 256 })
      if (!regions.length) {
        setNote('No painted shapes found. Paint the areas in a flat colour that differs from the rest, or export with the background deleted.')
        return
      }
      if (replaceId) {
        if (regions.length !== 1 || ignoredOverflow) { setNote('Use a mask containing one connected object to replace this outline. Separate logo letters need separate areas.'); return }
        setRows(rows.map(row => row.id === replaceId ? { ...row, points: regions[0] } : row))
        stopTool()
        setNote('Outline replaced. Gallery, label and glow kept. Review the edge, then save. Use Undo to restore it.')
        return
      }
      const made = addAreas(regions)
      const extra = [ignoredOverflow && `${ignoredOverflow} more did not fit`, ignoredSpecks && `${ignoredSpecks} stray mark${ignoredSpecks === 1 ? '' : 's'} ignored`].filter(Boolean).join(' · ')
      setNote(`Added ${made} area${made === 1 ? '' : 's'} from the mask.${extra ? ' ' + extra + '.' : ''}`)
    } catch { setNote('Could not import this mask. Your existing areas are unchanged.'); } finally { setBusy(''); URL.revokeObjectURL(url) }
  }

  // ── Paint overlay ────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = paintCanvas.current
    const paint = paintRef.current
    if (!canvas || !paint) return
    canvas.width = paint.width; canvas.height = paint.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(paint.width, paint.height)
    for (let i = 0; i < paint.data.length; i++) {
      if (!paint.data[i]) continue
      img.data[i * 4] = 124; img.data[i * 4 + 1] = 92; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 110
    }
    ctx.putImageData(img, 0, 0)
  }, [paintVersion])

  // ── Keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName || '')
      if (typing) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        setHistory(h => (e.shiftKey ? redoHistory(h) : undoHistory(h)))
      }
      if (e.key === 'Escape') stopTool()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stopTool])

  // ── Saving ───────────────────────────────────────────────────────────────
  async function save() {
    setSaving(true)
    const res = await saveShowcaseHotspots(showcase.id, hotspots)
    setSaving(false)
    if (!res.ok) { toast.error('Could not save the areas', res.error); return }
    setSaved(hotspots)
    setHistory(h => resetHistory(h.present))
    toast.success('Areas saved')
    router.refresh()
  }

  // Leaving with unsaved areas is the one thing that loses real work here.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // ── View geometry ────────────────────────────────────────────────────────
  const span = 100 / zoom
  const vx = Math.max(0, Math.min(100 - span, focus[0] - span / 2))
  const vy = Math.max(0, Math.min(100 - span, focus[1] - span / 2))
  const hH = 2.4 / zoom
  const hW = hH * ((dimensions.height / dimensions.width) || 1)
  const painting = tool === 'brush' || tool === 'erase'
  /** Largest box with the artwork's ratio that fits the measured stage. */
  const fit = useMemo(() => {
    const ratio = (dimensions.width || 1) / (dimensions.height || 1)
    const available = { width: Math.max(0, stage.width), height: Math.max(0, stage.height) }
    if (!available.width || !available.height) return { width: 0, height: 0 }
    const byWidth = { width: available.width, height: available.width / ratio }
    return byWidth.height <= available.height
      ? byWidth
      : { width: available.height * ratio, height: available.height }
  }, [stage, dimensions])

  const at = (e: { clientX: number; clientY: number; currentTarget: Element }): HotspotPoint => {
    const el = e.currentTarget.tagName === 'svg' ? e.currentTarget : (e.currentTarget as SVGElement).ownerSVGElement
    const r = (el ?? e.currentTarget).getBoundingClientRect()
    return [
      Math.round((vx + (e.clientX - r.left) / r.width * span) * 100) / 100,
      Math.round((vy + (e.clientY - r.top) / r.height * span) * 100) / 100,
    ]
  }
  const capture = (el: Element | null | undefined, id: number) => {
    try { el?.setPointerCapture(id) } catch { /* the drag works without it */ }
  }

  const toolButton = (value: Tool, label: string, Icon: typeof Wand2) => (
    <button
      type="button"
      aria-pressed={tool === value}
      onClick={() => { stopTool(); setTool(value); setNote('') }}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs transition-colors ${
        tool === value ? 'border-violet-400 bg-violet-500/15 text-violet-200' : 'border-border hover:bg-secondary'
      }`}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )

  return (
    <div className="flex flex-col h-[calc(100dvh-var(--bottom-nav-h,0px))] min-h-0">
      {/* Header */}
      <header className="flex items-center gap-3 flex-wrap px-4 py-3 border-b border-border shrink-0">
        <Link href="/dashboard/portfolio" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Portfolio
        </Link>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate">{showcase.clientName} · clickable areas</h1>
          <p className="text-[11px] text-muted-foreground">Saved separately from the rest of the presentation.</p>
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <button type="button" title="Undo (⌘Z)" aria-label="Undo" disabled={!canUndo(history)}
            onClick={() => setHistory(undoHistory)}
            className="p-2 rounded-lg border border-border disabled:opacity-35 hover:bg-secondary"><Undo2 className="w-4 h-4" /></button>
          <button type="button" title="Redo (⌘⇧Z)" aria-label="Redo" disabled={!canRedo(history)}
            onClick={() => setHistory(redoHistory)}
            className="p-2 rounded-lg border border-border disabled:opacity-35 hover:bg-secondary"><Redo2 className="w-4 h-4" /></button>
          <span className="text-[11px] text-muted-foreground px-1">{dirty ? 'Unsaved' : 'Saved'}</span>
          <button type="button" onClick={save} disabled={saving || !dirty}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg gradient-bg text-white text-sm font-semibold disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* ── Stage ─────────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex flex-col bg-black/40">
          <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-border/60 shrink-0">
            {(['desktop', 'mobile'] as const).map(v => (
              <button key={v} type="button" aria-pressed={side === v}
                onClick={() => { setSide(v); setSelected(''); stopTool(); paintRef.current = null; touchPaint() }}
                className={`px-3 py-1.5 rounded-lg text-xs border ${side === v ? 'border-violet-400 bg-violet-500/15' : 'border-border'}`}>
                {v === 'desktop' ? 'Desktop' : 'Phone'} ({hotspots[v].length})
              </button>
            ))}
            <span className="w-px h-5 bg-border mx-1" />
            {toolButton('magic', 'Pick element', Wand2)}
            {toolButton('brush', 'Brush', Brush)}
            {toolButton('erase', 'Erase', Eraser)}
            {toolButton('rect', 'Box', Square)}
            {toolButton('outline', 'Outline', PenLine)}
            <button type="button" disabled={!!busy || rows.length >= MAX_AREAS} onClick={() => maskInput.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs hover:bg-secondary disabled:opacity-40">
              <Upload className="w-3.5 h-3.5" /> Mask
            </button>
            <button type="button" onClick={cutOutSubject} disabled={!!busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs hover:bg-secondary disabled:opacity-40">
              <Scissors className="w-3.5 h-3.5" /> Remove background
            </button>
            <input ref={maskInput} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importMask(f) }} />
            <label className="flex items-center gap-1.5 text-xs ml-auto">
              <ZoomIn className="w-3.5 h-3.5" />
              <input type="range" min={1} max={8} step={0.5} value={zoom} onChange={e => setZoom(Number(e.target.value))} className="w-28" />
              <span className="tabular-nums w-9">{zoom.toFixed(1)}×</span>
            </label>
          </div>

          {/* Tool strip */}
          <div className="px-3 py-2 text-xs text-muted-foreground shrink-0 space-y-1.5">
            {tool === 'magic' && (
              <label className="flex items-center gap-2">Tolerance
                <input type="range" min={4} max={70} step={2} value={tolerance} onChange={e => setTolerance(Number(e.target.value))} className="w-40" />
                <span className="tabular-nums w-7">{tolerance}</span>
                <span>Lower picks out a flat label; higher takes in shading.</span>
              </label>
            )}
            {painting && (
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-2">Brush
                  <input type="range" min={1} max={25} step={1} value={brushSize} onChange={e => setBrushSize(Number(e.target.value))} className="w-32" />
                  <span className="tabular-nums w-7">{brushSize}</span>
                </label>
                <button type="button" onClick={areasFromPaint} disabled={noPaint}
                  className="px-3 py-1.5 rounded-lg border border-violet-400 bg-violet-500/15 text-violet-200 disabled:opacity-40">
                  Make areas from paint
                </button>
                <button type="button" onClick={wipePaint} disabled={noPaint} className="underline disabled:opacity-40">Clear paint</button>
              </div>
            )}
            {tool === 'outline' && (
              <div className="flex items-center gap-3 flex-wrap">
                <span>Click the corners in order (3–16 points).</span>
                <button type="button" disabled={outline.length < 3} onClick={() => { addAreas([outline]); setOutline([]) }} className="underline disabled:opacity-40">Finish</button>
                <button type="button" onClick={() => setOutline(outline.slice(0, -1))} className="underline">Undo point</button>
                <button type="button" onClick={stopTool} className="underline">Cancel</button>
              </div>
            )}
            {tool === 'rect' && <span>Drag across the artwork to box an area.</span>}
            {zoom > 1 && <span>Shift-drag to pan.</span>}
            {busy && <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />{busy}</span>}
            {note && <span className="text-amber-400 block" role="status">{note}</span>}
          </div>

          {/* Artwork */}
          <div ref={stageRef} className="flex-1 min-h-0 p-3 overflow-hidden flex items-center justify-center">
            {media && dimensions.url === media.url && fit.width > 0 ? (
              <div className="relative" style={{ width: fit.width, height: fit.height }}>
                <svg
                  role="img" aria-label="Clickable areas editor"
                  viewBox={`${vx} ${vy} ${span} ${span}`} preserveAspectRatio="none"
                  className="block"
                  style={{
                    width: fit.width, height: fit.height,
                    touchAction: 'none',
                    cursor: painting ? 'crosshair' : tool !== 'none' ? 'crosshair' : undefined,
                  }}
                  onPointerDown={e => {
                    const [x, y] = at(e)
                    if (e.shiftKey && zoom > 1) { capture(e.currentTarget, e.pointerId); setDrag({ kind: 'pan', x, y }); return }
                    if (painting) {
                      capture(e.currentTarget, e.pointerId)
                      paintAt([x, y], [x, y], tool === 'erase')
                      setDrag({ kind: 'paint', last: [x, y], stroke: crypto.randomUUID() })
                      return
                    }
                    if (tool === 'magic') { void pickElement(x, y); return }
                    if (tool === 'rect') { capture(e.currentTarget, e.pointerId); setRect({ x0: x, y0: y, x1: x, y1: y }); return }
                    if (tool === 'outline' && outline.length < 16) { setOutline([...outline, [x, y]]); return }
                  }}
                  onPointerMove={e => {
                    if (!drag && !rect) return
                    const [x, y] = at(e)
                    if (rect) { setRect(r => r && { ...r, x1: x, y1: y }); return }
                    if (drag?.kind === 'pan') {
                      setFocus(([fx, fy]) => [
                        Math.max(0, Math.min(100, fx - (x - drag.x))),
                        Math.max(0, Math.min(100, fy - (y - drag.y))),
                      ])
                      return
                    }
                    if (drag?.kind === 'paint') {
                      paintAt(drag.last, [x, y], tool === 'erase')
                      setDrag({ ...drag, last: [x, y] })
                      return
                    }
                    if (drag && active) {
                      // Tagged with the drag so the whole gesture is one undo.
                      if (drag.kind === 'point') update({ points: movePoint(active.points, drag.index, x, y) }, `pt-${selected}-${drag.index}`)
                      else { update({ points: movePolygon(active.points, x - drag.x, y - drag.y) }, `mv-${selected}`); setDrag({ kind: 'shape', x, y }) }
                    }
                  }}
                  onPointerUp={() => {
                    if (rect) {
                      const r = rect
                      setRect(null)
                      if (Math.abs(r.x1 - r.x0) > 0.2 || Math.abs(r.y1 - r.y0) > 0.2) addAreas([rectangleFromDrag(r.x0, r.y0, r.x1, r.y1)])
                      return
                    }
                    setDrag(null)
                  }}
                  onPointerLeave={() => { setRect(null); setDrag(null) }}
                >
                  <defs>
                    {rows.filter(hasGradient).map(r => {
                      const g = hotspotGlow(r)
                      return (
                        <linearGradient key={r.id} id={`ag-${r.id}`} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor={g.from} /><stop offset="100%" stopColor={g.to} />
                        </linearGradient>
                      )
                    })}
                  </defs>
                  <image href={media.url} width="100" height="100" preserveAspectRatio="none" />
                  {rows.map((r, i) => (
                    <g key={r.id}>
                      <polygon
                        onPointerDown={e => {
                          if (tool !== 'none') return
                          e.stopPropagation()
                          setSelected(r.id)
                          const [x, y] = at(e as unknown as { clientX: number; clientY: number; currentTarget: Element })
                          setDrag({ kind: 'shape', x, y })
                        }}
                        style={{ cursor: tool === 'none' ? 'move' : undefined }}
                        points={r.points.map(p => p.join(',')).join(' ')}
                        fill="transparent" pointerEvents="all"
                        stroke={hasGradient(r) ? `url(#ag-${r.id})` : hotspotColour(r.color)}
                        strokeOpacity={r.id === selected ? 1 : 0.65}
                        strokeWidth={1.6} vectorEffect="non-scaling-stroke"
                      />
                      <text x={r.points[0][0]} y={r.points[0][1]} fill="white" fontSize={3 / zoom} pointerEvents="none">{i + 1}</text>
                    </g>
                  ))}
                  {tool === 'none' && active?.points.map((pt, i) => (
                    <rect key={i} x={pt[0] - hW / 2} y={pt[1] - hH / 2} width={hW} height={hH} rx={hW / 3}
                      fill={drag?.kind === 'point' && drag.index === i ? '#fff' : hotspotColour(active.color)}
                      stroke="#120b1e" strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ cursor: 'grab' }}
                      onPointerDown={e => {
                        e.stopPropagation()
                        capture(e.currentTarget.ownerSVGElement, e.pointerId)
                        setDrag({ kind: 'point', index: i })
                      }} />
                  ))}
                  {outline.length > 0 && (
                    <polyline points={outline.map(p => p.join(',')).join(' ')} fill="#7c5cff33" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  )}
                  {rect && (
                    <rect x={Math.min(rect.x0, rect.x1)} y={Math.min(rect.y0, rect.y1)}
                      width={Math.abs(rect.x1 - rect.x0)} height={Math.abs(rect.y1 - rect.y0)}
                      fill="#7c5cff33" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                  )}
                </svg>
                {/* Paint sits over the artwork and under the pointer: it is a
                    preview of a selection, never a target for events. */}
                <canvas ref={paintCanvas} aria-hidden
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  style={{ imageRendering: 'pixelated', opacity: noPaint ? 0 : 1 }} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {media ? 'Loading the artwork…' : 'This view has no still image. Areas need one.'}
              </p>
            )}
          </div>
        </div>

        {/* ── Inspector ─────────────────────────────────────────────────── */}
        <aside className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-border overflow-y-auto p-4 space-y-4">
          <div>
            <h2 className="text-xs font-semibold mb-2">Areas ({rows.length}/{MAX_AREAS})</h2>
            {rows.length === 0 && <p className="text-xs text-muted-foreground">None yet. Pick an element, paint one, or upload a mask.</p>}
            <div className="space-y-1">
              {rows.map((r, i) => (
                <button key={r.id} type="button" onClick={() => setSelected(r.id)}
                  className={`w-full flex items-center gap-2 text-left text-xs px-2 py-1.5 rounded-lg border ${r.id === selected ? 'border-violet-400 bg-violet-500/10' : 'border-border'}`}>
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: hotspotColour(r.color) }} />
                  <span className="truncate flex-1">{i + 1}. {r.label}</span>
                  {!r.path && <span className="text-amber-400 shrink-0">no gallery</span>}
                </button>
              ))}
            </div>
          </div>

          {active && (
            <div className="space-y-3 border-t border-border pt-3">
              <button type="button" disabled={!!busy} onClick={() => replaceMaskInput.current?.click()}
                className="w-full rounded-lg border border-violet-400/50 px-3 py-2 text-xs hover:bg-violet-500/10 disabled:opacity-40">Replace outline from mask</button>
              <input ref={replaceMaskInput} type="file" accept="image/*" className="hidden"
                onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importMask(file, active.id) }} />
              <p className="text-xs text-muted-foreground">Fix rounded edges using a full-canvas mask of one object. Your gallery, label and glow stay the same. Review, then save.</p>
              <label className="block text-xs">Hover label
                <input className="mt-1 w-full rounded border border-border bg-background p-2" maxLength={80}
                  value={active.label} onChange={e => update({ label: e.target.value })} />
              </label>
              <label className="block text-xs">Gallery
                <select className="mt-1 w-full rounded border border-border bg-background p-2"
                  value={active.path} onChange={e => update({ path: e.target.value })}>
                  <option value="">Choose a gallery</option>
                  {active.path && !galleries.some(g => g.path === active.path) && <option value={active.path}>{active.path}</option>}
                  {galleries.map(g => <option key={g.path} value={g.path}>{g.label}</option>)}
                </select>
              </label>

              {(() => {
                const glow = hotspotGlow(active)
                const gradient = hasGradient(active)
                const swatches = (end: 'color' | 'colorTo', value: string) => (
                  <div className="flex gap-1.5 flex-wrap items-center">
                    {(Object.keys(HOTSPOT_COLOURS) as HotspotColour[]).map(key => {
                      const hex = HOTSPOT_COLOURS[key]
                      const chosen = value.toLowerCase() === hex
                      return (
                        <button key={key} type="button" aria-label={`${end === 'color' ? 'From' : 'To'} ${key}`} aria-pressed={chosen}
                          onClick={() => update({ [end]: end === 'color' && key === DEFAULT_HOTSPOT_COLOUR && !gradient ? null : key })}
                          className={`w-6 h-6 rounded-full border-2 ${chosen ? 'border-foreground scale-110' : 'border-transparent'}`}
                          style={{ background: hex }} />
                      )
                    })}
                    <input type="color" aria-label={`${end === 'color' ? 'From' : 'To'} colour picker`} value={value}
                      onChange={e => update({ [end]: e.target.value.toLowerCase() })}
                      className="w-6 h-6 rounded-full border border-border bg-transparent p-0 cursor-pointer" />
                    <input type="text" aria-label={`${end === 'color' ? 'From' : 'To'} colour code`} value={value} maxLength={7} spellCheck={false}
                      onChange={e => { const v = e.target.value.trim(); update({ [end]: normaliseGlowColour(v) ?? v }) }}
                      className={`w-20 rounded border bg-background p-1 font-mono text-xs ${normaliseGlowColour(value) ? 'border-border' : 'border-destructive'}`} />
                  </div>
                )
                return (
                  <div className="text-xs space-y-2">
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Glow presets">
      {([['Subtle',.65],['Balanced',1.2],['Highlight',2.2]] as const).map(([label,strength])=><button key={label} type="button" aria-pressed={active.glowStrength===strength} onClick={()=>update({glowStrength:strength})} className={`rounded-md border px-2 py-1.5 ${active.glowStrength===strength?'border-violet-400 bg-violet-500/15':'border-border'}`}>{label}</button>)}
     </div>
     <label className="block">Outer glow strength · {Math.round(hotspotGlowStrength(active.glowStrength)*100)}%
      <input aria-label="Outer glow strength" type="range" min={25} max={300} step={5}
       value={Math.round(hotspotGlowStrength(active.glowStrength)*100)} onChange={e=>update({glowStrength:Number(e.target.value)/100})}
       className="block w-full mt-2 accent-violet-500" />
     </label>
     <p className="text-muted-foreground">Adjusts the soft outer halo. The solid outline stays thin at every strength. A gentle pulse reveals the area on touch devices; desktop hover holds the glow steady. Desktop and Phone settings are separate.</p>
     <button type="button" className="underline" onClick={()=>update({glowStrength:null})}>Reset glow strength</button>
     <div className="flex items-center justify-center rounded-lg bg-black/60 py-7" aria-label="Outer glow sample">
      <span className="rounded-lg px-4 py-2 text-xs" style={{border:`1px solid ${glow.from}`,boxShadow:`0 0 ${3*hotspotGlowStrength(active.glowStrength)}px ${glow.from}, 0 0 ${7*hotspotGlowStrength(active.glowStrength)}px ${glow.to}`}}>Glow preview</span>
     </div>
     {rows.length>1&&<button type="button" className="block text-xs underline underline-offset-4" onClick={()=>setRows(rows.map(r=>({...r,color:active.color,colorTo:active.colorTo,glowStrength:active.glowStrength})))}>Apply this glow to all areas in this view</button>}
     <p className="text-muted-foreground">Presets change only glow strength. Apply to all copies colour and strength within the selected Desktop or Phone view; gallery links and outlines stay unchanged.</p>
     <span className="block">Glow colour</span>
                    {swatches('color', glow.from)}
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={gradient} className="accent-violet-500"
                        onChange={e => update({ colorTo: e.target.checked ? (glow.from === '#4cc3ff' ? '#ff4fd8' : '#4cc3ff') : null })} />
                      Gradient
                    </label>
                    {gradient && <>
                      {swatches('colorTo', glow.to)}
                      <div className="h-5 rounded-md border border-border" aria-hidden
                        style={{ background: `linear-gradient(135deg, ${glow.from}, ${glow.to})` }} />
                    </>}
                  </div>
                )
              })()}

              <button type="button" onClick={() => { setRows(rows.filter(r => r.id !== selected)); setSelected('') }}
                className="flex items-center gap-1.5 text-xs text-red-400 hover:underline">
                <Trash2 className="w-3.5 h-3.5" /> Remove this area
              </button>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground border-t border-border pt-3">
            Areas are saved per view: the phone list is independent of the desktop one, even when both use the same picture.
            An area with no gallery is not saved — the website needs somewhere to send the visitor.
          </p>
          {!dirty && <p className="text-[11px] text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> All changes saved</p>}
        </aside>
      </div>

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
  )
}
