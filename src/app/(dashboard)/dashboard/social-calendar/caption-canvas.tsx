'use client'

/**
 * Free-drag layout board for a calendar item's copy.
 *
 * Images and short text labels are positioned anywhere on a fixed 640-wide
 * design surface. Storing DESIGN-SPACE coordinates (rather than percentages or
 * screen pixels) is what lets the PDF reproduce the board exactly: it renders
 * the same absolute layout and scales the whole thing into the plan table's
 * Content column.
 *
 * The board is a companion to the rich-text caption, not a replacement — the
 * caption remains the written brief; this is the visual arrangement of it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Type, ImagePlus, Clipboard, Trash2, BringToFront, SendToBack,
  Bold, AlignLeft, AlignCenter, AlignRight, Loader2, Minus, Plus,
} from 'lucide-react'
import {
  CANVAS_W, CANVAS_H, CANVAS_MAX_H, CANVAS_MAX_BLOCKS,
  type CaptionCanvas, type CanvasBlock, type CanvasTextBlock,
} from '@/lib/social/plan'

const SNAP = 8
const TEXT_COLORS = ['#111827', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ffffff']

const snap = (n: number) => Math.round(n / SNAP) * SNAP
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const newId = () => `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`

type DragState =
  | { mode: 'move'; id: string; dx: number; dy: number }
  | { mode: 'resize'; id: string; startX: number; startY: number; startW: number; startH: number }
  | null

export default function CaptionCanvasEditor({
  value, onChange, disabled = false, onUploadImage,
}: {
  value: CaptionCanvas | null
  onChange: (next: CaptionCanvas | null) => void
  disabled?: boolean
  /** Uploads a file and resolves to its public URL (null if it failed). */
  onUploadImage: (file: File) => Promise<string | null>
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  const [busy, setBusy] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  const board: CaptionCanvas = useMemo(
    () => value ?? { w: CANVAS_W, h: CANVAS_H, blocks: [] },
    [value],
  )
  const blocks = board.blocks
  const selected = blocks.find(b => b.id === selectedId) ?? null

  // Mirror of the live board for handlers that resume AFTER an await. An
  // upload takes seconds, and the render-time `blocks` closure captured before
  // it would overwrite anything the planner did meanwhile.
  const boardRef = useRef(board)
  useEffect(() => { boardRef.current = board }, [board])

  // The surface is authored at CANVAS_W and scaled down to whatever width the
  // modal gives it; every pointer delta is divided by this factor so dragging
  // tracks the cursor exactly at any size.
  //
  // wrapRef is a plain full-width box whose height is NOT derived from `scale`
  // — observing the sized element instead would let a scrollbar appearing at
  // one height feed back into the width and oscillate.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let lastW = 0
    const measure = () => {
      const w = el.clientWidth
      if (w && w !== lastW) { lastW = w; setScale(w / CANVAS_W) }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Making a block contentEditable is not enough — the double-click's own
  // focus pass already happened while it was still readonly, so place the
  // caret ourselves once React has flipped the attribute.
  useEffect(() => {
    if (!editingId) return
    const el = surfaceRef.current?.querySelector<HTMLElement>(`[data-block="${editingId}"] [contenteditable]`)
    if (!el) return
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, [editingId])

  const commit = useCallback((next: CanvasBlock[], h = board.h) => {
    onChange(next.length ? { w: CANVAS_W, h, blocks: next } : null)
  }, [board.h, onChange])

  const patchBlock = useCallback((id: string, patch: Partial<CanvasBlock>) => {
    commit(blocks.map(b => (b.id === id ? { ...b, ...patch } as CanvasBlock : b)))
  }, [blocks, commit])

  const removeBlock = useCallback((id: string) => {
    commit(blocks.filter(b => b.id !== id))
    setSelectedId(null)
  }, [blocks, commit])

  const topZ = blocks.reduce((m, b) => Math.max(m, b.z), 0)

  const addText = () => {
    if (disabled || blocks.length >= CANVAS_MAX_BLOCKS) return
    const id = newId()
    commit([...blocks, {
      id, type: 'text', x: 24, y: 24, w: 240, h: 40, z: topZ + 1,
      text: 'New label', size: 16,
    }])
    setSelectedId(id)
    setEditingId(id)
  }

  const addImage = useCallback(async (file: File) => {
    if (disabled || busy || boardRef.current.blocks.length >= CANVAS_MAX_BLOCKS) return
    setBusy(true)
    try {
      const url = await onUploadImage(file)
      if (!url) return
      // Re-read the board AFTER the upload: dragging, new labels and height
      // changes made during those seconds must survive, and a second image
      // must not be built on a snapshot that predates the first.
      const cur = boardRef.current
      if (cur.blocks.length >= CANVAS_MAX_BLOCKS) return
      const id = newId()
      const z = cur.blocks.reduce((m, b) => Math.max(m, b.z), 0) + 1
      onChange({
        w: CANVAS_W,
        h: cur.h,
        blocks: [...cur.blocks, { id, type: 'image', x: 24, y: 24, w: 240, h: 180, z, url }],
      })
      setSelectedId(id)
    } finally { setBusy(false) }
  }, [busy, disabled, onChange, onUploadImage])

  const addImageUrl = (url: string) => {
    const u = url.trim()
    if (disabled || !/^https?:\/\//i.test(u) || blocks.length >= CANVAS_MAX_BLOCKS) return
    const id = newId()
    commit([...blocks, { id, type: 'image', x: 24, y: 24, w: 240, h: 180, z: topZ + 1, url: u }])
    setSelectedId(id)
    setLinkUrl('')
  }

  // ── Dragging / resizing ────────────────────────────────────────────────────
  const onPointerDownBlock = (e: React.PointerEvent, b: CanvasBlock) => {
    if (disabled || editingId === b.id) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(b.id)
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = (e.clientX - rect.left) / scale
    const py = (e.clientY - rect.top) / scale
    dragRef.current = { mode: 'move', id: b.id, dx: px - b.x, dy: py - b.y }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerDownResize = (e: React.PointerEvent, b: CanvasBlock) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(b.id)
    dragRef.current = {
      mode: 'resize', id: b.id,
      startX: e.clientX, startY: e.clientY, startW: b.w, startH: b.h,
    }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || disabled) return
    const b = blocks.find(x => x.id === d.id)
    if (!b) return
    if (d.mode === 'move') {
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = (e.clientX - rect.left) / scale
      const py = (e.clientY - rect.top) / scale
      patchBlock(d.id, {
        x: clamp(snap(px - d.dx), 0, CANVAS_W - b.w),
        y: clamp(snap(py - d.dy), 0, board.h - b.h),
      })
    } else {
      const w = clamp(snap(d.startW + (e.clientX - d.startX) / scale), 24, CANVAS_W - b.x)
      const h = clamp(snap(d.startH + (e.clientY - d.startY) / scale), 20, board.h - b.y)
      patchBlock(d.id, { w, h })
    }
  }

  const endDrag = () => { dragRef.current = null }

  // Arrow keys nudge, Delete removes — expected of anything draggable.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || !selected || editingId) return
    const step = e.shiftKey ? 10 : 1
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    }
    if (moves[e.key]) {
      e.preventDefault()
      const [dx, dy] = moves[e.key]
      patchBlock(selected.id, {
        x: clamp(selected.x + dx, 0, CANVAS_W - selected.w),
        y: clamp(selected.y + dy, 0, board.h - selected.h),
      })
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      removeBlock(selected.id)
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const img = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
    if (img && !busy) { e.preventDefault(); void addImage(img) }
  }

  const setH = (raw: number) => {
    const h = clamp(raw, 160, CANVAS_MAX_H)
    // Re-fit every block: the server clamps to the board height on save, so
    // leaving them hanging below would silently squash the layout.
    commit(blocks.map(b => {
      const bh = Math.min(b.h, h)
      return { ...b, h: bh, y: clamp(b.y, 0, Math.max(0, h - bh)) } as CanvasBlock
    }), h)
  }

  const isText = (b: CanvasBlock | null): b is CanvasTextBlock => !!b && b.type === 'text'

  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-1 mb-1.5">
        <button type="button" onClick={addText}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-secondary text-xs hover:bg-background transition-colors">
          <Type className="w-3.5 h-3.5" /> Text
        </button>
        <label className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-secondary text-xs hover:bg-background transition-colors cursor-pointer">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} Image
          <input type="file" accept="image/*" className="hidden" disabled={busy}
            onChange={e => { const f = e.target.files?.[0]; if (f) void addImage(f); e.target.value = '' }} />
        </label>
        <button type="button" title="Paste an image from the clipboard" disabled={busy}
          onClick={async () => {
            try {
              for (const it of await navigator.clipboard.read()) {
                const t = it.types.find(x => x.startsWith('image/'))
                if (t) { void addImage(new File([await it.getType(t)], 'pasted.png', { type: t })); return }
              }
            } catch { /* permission denied — the ⌘V path on the board still works */ }
          }}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-secondary text-xs hover:bg-background transition-colors">
          <Clipboard className="w-3.5 h-3.5" /> Paste
        </button>
        <input
          value={linkUrl}
          onChange={e => setLinkUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addImageUrl(linkUrl) } }}
          placeholder="…or paste an image link + Enter"
          className="flex-1 min-w-[150px] bg-secondary border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:border-primary/50"
        />

        {/* Selection actions */}
        {selected && (
          <div className="flex items-center gap-1 pl-1 ml-auto border-l border-border">
            {isText(selected) && (
              <>
                <button type="button" title="Bold" onClick={() => patchBlock(selected.id, { bold: !selected.bold })}
                  className={`p-1 rounded ${selected.bold ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button type="button" title="Smaller" onClick={() => patchBlock(selected.id, { size: clamp((selected.size ?? 14) - 2, 9, 48) })}
                  className="p-1 rounded text-muted-foreground hover:text-foreground"><Minus className="w-3.5 h-3.5" /></button>
                <button type="button" title="Bigger" onClick={() => patchBlock(selected.id, { size: clamp((selected.size ?? 14) + 2, 9, 48) })}
                  className="p-1 rounded text-muted-foreground hover:text-foreground"><Plus className="w-3.5 h-3.5" /></button>
                {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([a, Icon]) => (
                  <button key={a} type="button" title={`Align ${a}`} onClick={() => patchBlock(selected.id, { align: a })}
                    className={`p-1 rounded ${(selected.align ?? 'left') === a ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                ))}
                {TEXT_COLORS.map(c => (
                  <button key={c} type="button" title={c} onClick={() => patchBlock(selected.id, { color: c })}
                    className="w-4 h-4 rounded-full border border-black/20" style={{ backgroundColor: c }} />
                ))}
              </>
            )}
            <button type="button" title="Bring to front" onClick={() => patchBlock(selected.id, { z: topZ + 1 })}
              className="p-1 rounded text-muted-foreground hover:text-foreground"><BringToFront className="w-3.5 h-3.5" /></button>
            <button type="button" title="Send to back" onClick={() => patchBlock(selected.id, { z: 0 })}
              className="p-1 rounded text-muted-foreground hover:text-foreground"><SendToBack className="w-3.5 h-3.5" /></button>
            <button type="button" title="Delete (Del)" onClick={() => removeBlock(selected.id)}
              className="p-1 rounded text-muted-foreground hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>

      {/* ── Surface ── */}
      <div
        ref={wrapRef}
        className="relative w-full rounded-lg border border-border bg-secondary overflow-hidden"
        style={{ height: board.h * scale }}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        tabIndex={0}
      >
        <div
          ref={surfaceRef}
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: CANVAS_W,
            height: board.h,
            transform: `scale(${scale})`,
            backgroundImage: 'radial-gradient(circle, rgba(127,127,127,.22) 1px, transparent 1px)',
            backgroundSize: `${SNAP * 2}px ${SNAP * 2}px`,
          }}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={() => { setSelectedId(null); setEditingId(null) }}
        >
          {blocks.slice().sort((a, b) => a.z - b.z).map(b => {
            const isSel = b.id === selectedId
            return (
              <div
                key={b.id}
                data-block={b.id}
                onPointerDown={e => onPointerDownBlock(e, b)}
                onDoubleClick={() => b.type === 'text' && setEditingId(b.id)}
                className={`absolute ${isSel ? 'outline outline-2 outline-primary' : ''} ${editingId === b.id ? 'cursor-text' : 'cursor-move'}`}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: b.z }}
              >
                {b.type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.url} alt="" draggable={false}
                    className="w-full h-full object-cover rounded pointer-events-none select-none" />
                ) : (
                  <div
                    contentEditable={editingId === b.id}
                    suppressContentEditableWarning
                    onBlur={e => {
                      setEditingId(null)
                      const text = (e.target as HTMLElement).innerText.slice(0, 400)
                      // The server drops blank labels; drop it here too rather
                      // than leave a block that disappears on save.
                      if (text.trim()) patchBlock(b.id, { text })
                      else removeBlock(b.id)
                    }}
                    className="w-full h-full px-1 leading-snug break-words focus:outline-none"
                    style={{
                      fontSize: b.size ?? 14,
                      fontWeight: b.bold ? 700 : 400,
                      color: b.color ?? '#111827',
                      textAlign: b.align ?? 'left',
                    }}
                  >
                    {b.text}
                  </div>
                )}
                {isSel && !disabled && (
                  <span
                    onPointerDown={e => onPointerDownResize(e, b)}
                    className="absolute -right-1 -bottom-1 w-3 h-3 rounded-sm bg-primary border border-white cursor-nwse-resize"
                  />
                )}
              </div>
            )
          })}

          {blocks.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-[11px] text-muted-foreground/70 text-center">
                Add text or images, then drag them anywhere.<br />
                You can also paste an image straight onto the board.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Height + hints ── */}
      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
        <span>Board height</span>
        <input
          type="range" min={160} max={CANVAS_MAX_H} step={20}
          value={board.h}
          onChange={e => setH(Number(e.target.value))}
          className="flex-1 max-w-[160px] accent-[var(--primary)]"
          disabled={!blocks.length}
        />
        <span>{board.h}px</span>
        <span className="ml-auto">
          {blocks.length}/{CANVAS_MAX_BLOCKS} blocks · double-click text to edit · arrows nudge · Del removes
        </span>
      </div>
    </div>
  )
}
