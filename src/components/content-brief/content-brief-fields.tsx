'use client'

/**
 * Content Brief — the shared planning block used by the Social Calendar's
 * "Plan an item" and the Requests "New design request" form.
 *
 *   Title · Content type (+ one page-specific field beside it)
 *   [page-specific workflow fields — passed as children]
 *   Caption / copy (formatted editor; optional Canvas)
 *   Reference images · Notes for designer · Links
 *
 * Everything content-related lives here so both pages brief a designer the
 * same way, and a calendar item pushed to Requests arrives exactly as written
 * (see src/lib/content-brief.ts).
 */

import { useState } from 'react'
import { ChevronDown, Clipboard, Link2, Loader2, Plus, Trash2, Upload, X } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import RichTextEditor, { readImageFromClipboard } from './rich-text-editor'
import CaptionCanvasEditor from '@/app/(dashboard)/dashboard/social-calendar/caption-canvas'
import { getBriefImageUploadUrl } from '@/app/(dashboard)/dashboard/content-brief-actions'
import { CONTENT_TYPES, CONTENT_TYPE_LABEL, type CaptionCanvas } from '@/lib/social/plan'
import { MAX_BRIEF_IMAGES, MAX_BRIEF_LINKS, cleanImageUrls, type ContentBriefDraft } from '@/lib/content-brief'

const LABEL = 'block text-xs font-medium text-foreground/80 mb-1.5'
const FIELD = 'w-full h-10 bg-background border border-border rounded-lg px-3 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/15 transition-colors disabled:opacity-60'

/** Upload one image to the shared bucket; resolves to its public URL. */
export async function uploadBriefImage(file: File): Promise<{ url?: string; error?: string }> {
  try {
    const res = await getBriefImageUploadUrl(file.name, file.type)
    if (!res.ok || !res.data) return { error: res.error || 'Upload failed.' }
    const put = await fetch(res.data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
    if (!put.ok) return { error: 'Storage rejected the file.' }
    return { url: res.data.publicUrl }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Upload failed.' }
  }
}

/** A folded row: shows what it holds when closed, so folding never hides data. */
function Fold({ label, summary, open, onToggle, children }: {
  label: string; summary?: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground transition-colors">
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        {label}
        {summary
          ? <span className="text-primary font-semibold">· {summary}</span>
          : <span className="text-muted-foreground/60 font-normal">(optional)</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

export interface ContentBriefFieldsProps {
  title: string
  onTitleChange: (title: string) => void
  value: ContentBriefDraft
  onChange: (next: ContentBriefDraft) => void
  disabled?: boolean
  /** Calendar items must have a type; requests may leave it "Not set". */
  contentTypeRequired?: boolean
  /**
   * Hide the Content type picker. The Requests form asks for the Service
   * instead and the server reads the content type off it — one question,
   * not two (see suggestContentType in lib/social/plan).
   */
  showContentType?: boolean
  /** One page-specific field shown beside Content type (Date / Service). */
  typeSide?: React.ReactNode
  /** Page-specific workflow fields, shown between the type row and the copy. */
  children?: React.ReactNode
  titlePlaceholder?: string
  autoFocusTitle?: boolean
  /** Reports upload problems to the page's toast. */
  onError?: (title: string, detail?: string) => void
}

export default function ContentBriefFields({
  title, onTitleChange, value, onChange, disabled = false, contentTypeRequired = false,
  showContentType = true, typeSide, children, titlePlaceholder = 'e.g. Onam offer poster', autoFocusTitle, onError,
}: ContentBriefFieldsProps) {
  const set = (patch: Partial<ContentBriefDraft>) => onChange({ ...value, ...patch })
  const [copyTab, setCopyTab] = useState<'text' | 'canvas'>(value.captionCanvas?.blocks?.length && !value.caption ? 'canvas' : 'text')
  const [uploading, setUploading] = useState(false)
  const [imageLink, setImageLink] = useState('')
  // A section opens itself when it has content; the user can still fold it.
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, hasContent: boolean) => openOverride[key] ?? hasContent
  const toggle = (key: string, hasContent: boolean) => setOpenOverride(p => ({ ...p, [key]: !(p[key] ?? hasContent) }))

  const images = value.referenceImages
  const canAddImage = !disabled && images.length < MAX_BRIEF_IMAGES

  const addImages = (urls: string[]) => onChange({ ...value, referenceImages: cleanImageUrls([...value.referenceImages, ...urls]) })

  async function uploadFiles(files: File[]) {
    const imgs = files.filter(f => f.type.startsWith('image/')).slice(0, MAX_BRIEF_IMAGES - images.length)
    if (!imgs.length) return
    setUploading(true)
    const urls: string[] = []
    for (const f of imgs) {
      const r = await uploadBriefImage(f)
      if (r.url) urls.push(r.url)
      else onError?.('Upload failed', r.error)
    }
    setUploading(false)
    if (urls.length) {
      addImages(urls)
      setOpenOverride(p => ({ ...p, refs: true }))
    }
  }

  async function pasteImage() {
    const file = await readImageFromClipboard()
    if (!file) { onError?.('No image on the clipboard', 'Copy an image or screenshot first, then press Paste.'); return }
    await uploadFiles([file])
  }

  async function uploadForCanvas(file: File): Promise<string | null> {
    const r = await uploadBriefImage(file)
    if (!r.url) { onError?.('Upload failed', r.error); return null }
    return r.url
  }

  const canvasCount = value.captionCanvas?.blocks?.length ?? 0
  const links = value.links

  return (
    <div className="space-y-4">
      <div>
        <label className={LABEL}>Title <span className="text-red-500">*</span></label>
        <input value={title} disabled={disabled} autoFocus={autoFocusTitle}
          onChange={e => onTitleChange(e.target.value)} placeholder={titlePlaceholder} className={FIELD} />
      </div>

      {(showContentType || typeSide) && (
      <div className={`grid gap-3 ${showContentType && typeSide ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {showContentType && (
        <div>
          <label className={LABEL}>Content type{contentTypeRequired && <span className="text-red-500"> *</span>}</label>
          <AppSelect value={value.contentType} disabled={disabled}
            onChange={e => set({ contentType: e.target.value })}>
            {!contentTypeRequired && <option value="">Not set</option>}
            {CONTENT_TYPES.map(t => <option key={t} value={t}>{CONTENT_TYPE_LABEL[t]}</option>)}
          </AppSelect>
        </div>
        )}
        {typeSide && <div>{typeSide}</div>}
      </div>
      )}

      {children}

      {/* ── Caption / copy ── */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <label className="block text-xs font-medium text-foreground/80">Caption / copy</label>
          <div className="flex items-center gap-1 ml-auto">
            {([['text', 'Text'], ['canvas', 'Canvas']] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setCopyTab(key)}
                title={key === 'canvas' ? 'Free layout board — arrange images and text labels' : 'Formatted caption'}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${
                  copyTab === key
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}>
                {label}
                {key === 'canvas' && canvasCount > 0 && <span className="ml-1 text-[9px] opacity-70">{canvasCount}</span>}
              </button>
            ))}
          </div>
        </div>
        {copyTab === 'text' ? (
          <RichTextEditor
            value={value.caption}
            onChange={caption => set({ caption })}
            disabled={disabled}
            placeholder="Caption, offer text, headline — exactly as it should read…"
            onPasteImage={f => void uploadFiles([f])}
          />
        ) : (
          <CaptionCanvasEditor
            value={value.captionCanvas}
            onChange={(c: CaptionCanvas | null) => set({ captionCanvas: c })}
            disabled={disabled}
            onUploadImage={uploadForCanvas}
          />
        )}
      </div>

      {/* ── Reference images ── */}
      <Fold label="Reference images"
        summary={images.length ? `${images.length} image${images.length === 1 ? '' : 's'}` : ''}
        open={isOpen('refs', images.length > 0)} onToggle={() => toggle('refs', images.length > 0)}>
        <div
          onDragOver={e => { if (canAddImage) e.preventDefault() }}
          onDrop={e => { if (!canAddImage) return; e.preventDefault(); void uploadFiles(Array.from(e.dataTransfer.files)) }}
          className="space-y-2"
        >
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((url, i) => (
                <div key={`${url}-${i}`} className="relative group">
                  <a href={url} target="_blank" rel="noreferrer" title="Open full size">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`Reference ${i + 1}`} className="w-20 h-20 rounded-lg object-cover border border-border bg-secondary" />
                  </a>
                  {!disabled && (
                    <button type="button" onClick={() => set({ referenceImages: images.filter((_, j) => j !== i) })}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-card border border-border text-muted-foreground hover:text-red-500 flex items-center justify-center shadow sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                      title="Remove image" aria-label="Remove image">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canAddImage && (
            <div className="flex flex-wrap items-center gap-1.5">
              <label className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-card text-xs text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload
                <input type="file" accept="image/*" multiple className="hidden" disabled={uploading}
                  onChange={e => { const fs = Array.from(e.target.files || []); e.target.value = ''; void uploadFiles(fs) }} />
              </label>
              <button type="button" onClick={() => void pasteImage()} disabled={uploading}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-card text-xs text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50 transition-colors"
                title="Paste a copied image or screenshot">
                <Clipboard className="w-3.5 h-3.5" /> Paste
              </button>
              <div className="relative flex-1 min-w-[160px]">
                <Link2 className="w-3.5 h-3.5 text-muted-foreground/50 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input type="url" value={imageLink} onChange={e => setImageLink(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addImages([imageLink]); setImageLink('') } }}
                  placeholder="…or an image link + Enter"
                  className="w-full h-9 bg-background border border-border rounded-lg pl-8 pr-3 text-xs focus:outline-none focus:border-violet-500/50" />
              </div>
            </div>
          )}
          {canAddImage && <p className="text-[10px] text-muted-foreground/70">You can also drop images here, or paste one straight into the caption.</p>}
        </div>
      </Fold>

      {/* ── Notes for designer ── */}
      <Fold label="Notes for designer" summary={value.notes.trim() ? '✓' : ''}
        open={isOpen('notes', !!value.notes.trim())} onToggle={() => toggle('notes', !!value.notes.trim())}>
        <textarea rows={3} value={value.notes} disabled={disabled}
          onChange={e => set({ notes: e.target.value })}
          placeholder="Sizes, colours, what to highlight, what to avoid…"
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/15 disabled:opacity-60" />
      </Fold>

      {/* ── Links ── */}
      <Fold label="Links" summary={links.filter(l => l.url.trim()).length ? `${links.filter(l => l.url.trim()).length}` : ''}
        open={isOpen('links', links.length > 0)} onToggle={() => toggle('links', links.length > 0)}>
        <div className="space-y-1.5">
          {links.map((l, i) => (
            <div key={i} className="flex gap-1.5">
              <input value={l.label} disabled={disabled} placeholder="Label (optional)"
                onChange={e => set({ links: links.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })}
                className="w-32 h-9 bg-background border border-border rounded-lg px-2.5 text-xs focus:outline-none focus:border-violet-500/50 disabled:opacity-60" />
              <input value={l.url} disabled={disabled} placeholder="https://drive.google.com/…"
                onChange={e => set({ links: links.map((x, j) => j === i ? { ...x, url: e.target.value } : x) })}
                className="flex-1 min-w-0 h-9 bg-background border border-border rounded-lg px-2.5 text-xs focus:outline-none focus:border-violet-500/50 disabled:opacity-60" />
              {!disabled && (
                <button type="button" onClick={() => set({ links: links.filter((_, j) => j !== i) })}
                  aria-label="Remove link" title="Remove link"
                  className="h-9 px-2.5 rounded-lg border border-border text-muted-foreground hover:text-red-500 transition-colors shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
          {!disabled && links.length < MAX_BRIEF_LINKS && (
            <button type="button" onClick={() => { set({ links: [...links, { label: '', url: '' }] }); setOpenOverride(p => ({ ...p, links: true })) }}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <Plus className="w-3.5 h-3.5" /> Add link
            </button>
          )}
          <p className="text-[10px] text-muted-foreground/70">Drive folders, Canva designs, product pages…</p>
        </div>
      </Fold>
    </div>
  )
}
