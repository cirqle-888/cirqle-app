'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Upload, Loader2, X, Film, Monitor, Smartphone, Eye, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { MAX_SOURCE_BYTES, MAX_VIDEO_BYTES, VIDEO_EXT_BY_TYPE } from '@/lib/portfolio/types'
import {
  DESKTOP_ASPECT, MOBILE_ASPECT, MAX_CATEGORY, MAX_CLIENT_NAME, MAX_DESCRIPTION,
  defaultAltText, mobileModeOf, resolveForViewport,
  type MobileMode, type ShowcaseEntry, type ShowcaseMedia, type ShowcaseMediaInput, type ShowcaseMediaType,
} from '@/lib/portfolio/showcase'
import { reserveShowcaseSlug, saveShowcase, setShowcasePublished } from './showcase-actions'
import { uploadShowcaseMedia } from './showcase-upload'
import HotspotEditor from './hotspot-editor'
import { readHotspots, validHotspots } from '@/lib/portfolio/hotspots'
import FocalPicker from './focal-picker'
import ScreenPreview from './screen-preview'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm,video/quicktime'
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
const CATEGORY_SUGGESTIONS = [
  'Brand identity', 'Social media', 'Outdoor & hoardings', 'Print', 'Packaging', 'UI / UX design', 'Video',
]

/** One side of the presentation while it is being edited. */
interface Slot {
  /** A file picked this session, not yet uploaded. */
  file: File | null
  /** Local preview of `file`. Revoked when replaced or when the editor closes. */
  objectUrl: string | null
  /** What is already saved, when editing. */
  existing: ShowcaseMedia | null
  type: ShowcaseMediaType
  focal: { x: number; y: number }
}

const emptySlot = (): Slot => ({ file: null, objectUrl: null, existing: null, type: 'image', focal: { x: 50, y: 50 } })
const slotFromMedia = (m: ShowcaseMedia): Slot => ({
  file: null, objectUrl: null, existing: m, type: m.type, focal: { x: m.focalX, y: m.focalY },
})

/** What the slot would show right now — the picked file if there is one, else what is saved. */
function slotMedia(slot: Slot): { type: ShowcaseMediaType; url: string; posterUrl: string | null } | null {
  if (slot.file && slot.objectUrl) return { type: slot.type, url: slot.objectUrl, posterUrl: null }
  if (slot.existing) return { type: slot.existing.type, url: slot.existing.url, posterUrl: slot.existing.posterUrl }
  return null
}

interface Props {
  /** Null to create a new presentation. */
  initial: ShowcaseEntry | null
  onClose: () => void
  onSaved: (entry: ShowcaseEntry, info: { created: boolean; published: boolean }) => void
}

export default function PresentationEditor({ initial, onClose, onSaved }: Props) {
  const datalistId = useId()
  const [hotspots, setHotspots] = useState(() => readHotspots(initial?.hotspots))
  const [clientName, setClientName] = useState(initial?.clientName ?? '')
  const [category, setCategory] = useState(initial?.category ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [altText, setAltText] = useState(initial?.altText && initial.altText !== defaultAltText(initial.clientName, initial.category) ? initial.altText : '')
  const [projectPath, setProjectPath] = useState(initial?.projectPath ?? '')

  const [desktop, setDesktop] = useState<Slot>(() => (initial ? slotFromMedia(initial.desktop) : emptySlot()))
  const initialMode: MobileMode = initial ? mobileModeOf(initial) : 'same'
  const [mobileMode, setMobileMode] = useState<MobileMode>(initialMode)
  /** The phone's own file, for mode "own". */
  const [mobile, setMobile] = useState<Slot>(() =>
    initial?.mobile && initialMode === 'own' ? slotFromMedia(initial.mobile) : emptySlot())
  /** The phone's crop of the desktop file, for mode "crop". */
  const [cropFocal, setCropFocal] = useState(() =>
    initial?.mobile && initialMode === 'crop' ? { x: initial.mobile.focalX, y: initial.mobile.focalY } : { x: 50, y: 50 })

  const [showOverlay, setShowOverlay] = useState(true)
  const [phase, setPhase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  // Object URLs hold the picked file in memory until revoked.
  const urls = useRef<Set<string>>(new Set())
  useEffect(() => {
    const live = urls.current
    return () => { live.forEach((u) => URL.revokeObjectURL(u)); live.clear() }
  }, [])

  const saving = phase !== null

  function pick(which: 'desktop' | 'mobile', file: File) {
    setError(null)
    const isVideo = file.type.startsWith('video/')
    if (!IMAGE_TYPES.has(file.type) && !(isVideo && VIDEO_EXT_BY_TYPE[file.type])) {
      setError('Use a JPG, PNG, WebP or AVIF image, or an MP4, WebM or MOV video.')
      return
    }
    const cap = isVideo ? MAX_VIDEO_BYTES : MAX_SOURCE_BYTES
    if (file.size > cap) {
      setError(`That file is too large — keep ${isVideo ? 'videos' : 'images'} under ${Math.round(cap / 1024 / 1024)} MB.`)
      return
    }
    const objectUrl = URL.createObjectURL(file)
    urls.current.add(objectUrl)
    setTouched(true)
    const apply = (prev: Slot): Slot => {
      if (prev.objectUrl) { URL.revokeObjectURL(prev.objectUrl); urls.current.delete(prev.objectUrl) }
      // A new file keeps the focal point already chosen: re-uploading a
      // corrected version of the same artwork should not undo the framing.
      return { ...prev, file, objectUrl, type: isVideo ? 'video' : 'image' }
    }
    if (which === 'desktop') setDesktop(apply)
    else setMobile(apply)
  }

  // What a visitor would see, built from the in-progress state and resolved
  // by the SAME rule the website uses, so the preview cannot disagree with it.
  const previewEntry = useMemo<ShowcaseEntry | null>(() => {
    const dm = slotMedia(desktop)
    if (!dm) return null
    const d: ShowcaseMedia = {
      ...dm, path: null, posterPath: null, focalX: desktop.focal.x, focalY: desktop.focal.y,
    }
    let m: ShowcaseMedia | null = null
    if (mobileMode === 'crop') {
      m = { ...d, focalX: cropFocal.x, focalY: cropFocal.y }
    } else if (mobileMode === 'own') {
      const mm = slotMedia(mobile)
      if (mm) m = { ...mm, path: null, posterPath: null, focalX: mobile.focal.x, focalY: mobile.focal.y }
    }
    return {
      id: '', slug: '', clientName, category, description, altText: '', projectPath: null,
      published: false, position: 0, desktop: d, mobile: m,
    }
  }, [desktop, mobile, mobileMode, cropFocal, clientName, category, description])

  const desktopView = previewEntry ? resolveForViewport(previewEntry, 'desktop') : null
  const mobileView = previewEntry ? resolveForViewport(previewEntry, 'mobile') : null

  function requestClose() {
    if (saving) return
    if (touched) setConfirmClose(true)
    else onClose()
  }

  async function save(publish: boolean) {
    setError(null)
    if (!validHotspots(hotspots)) { setError('Each clickable area needs a label, a gallery and a valid outline.'); return }
    const name = clientName.trim()
    if (!name) { setError('Give the presentation a client name.'); return }
    if (!slotMedia(desktop)) { setError('Add the desktop image or video first.'); return }
    if (mobileMode === 'own' && !slotMedia(mobile)) {
      setError('Add the phone image or video, or choose a different phone option.')
      return
    }

    try {
      setPhase('Preparing…')
      let slug = initial?.slug
      if (!slug) {
        const reserved = await reserveShowcaseSlug(name)
        if (!reserved.ok || !reserved.data) throw new Error(reserved.error ?? 'Could not reserve a web address.')
        slug = reserved.data
      }

      /** Upload a picked file, or keep what is already stored. */
      const resolveSlot = async (slot: Slot, which: 'desktop' | 'mobile'): Promise<ShowcaseMediaInput> => {
        if (slot.file) {
          const up = await uploadShowcaseMedia(slot.file, { slug: slug as string, slot: which }, setPhase, {
            // A phone video may borrow the desktop poster; a desktop video may not.
            requirePoster: which === 'desktop',
          })
          return { type: up.type, path: up.path, posterPath: up.posterPath, focalX: slot.focal.x, focalY: slot.focal.y }
        }
        const kept = slot.existing
        if (!kept?.path) throw new Error('Could not find the saved file. Reload the page and try again.')
        return { type: kept.type, path: kept.path, posterPath: kept.posterPath, focalX: slot.focal.x, focalY: slot.focal.y }
      }

      const desktopInput = await resolveSlot(desktop, 'desktop')
      let mobileInput: ShowcaseMediaInput | null = null
      if (mobileMode === 'crop') {
        // Same file, its own focal point — the website accepts a mobile URL
        // that equals the desktop one.
        mobileInput = { ...desktopInput, focalX: cropFocal.x, focalY: cropFocal.y }
      } else if (mobileMode === 'own') {
        mobileInput = await resolveSlot(mobile, 'mobile')
      }

      setPhase('Saving…')
      const res = await saveShowcase({
        id: initial?.id,
        slug,
        clientName,
        category,
        description,
        altText,
        projectPath: projectPath.trim() || null,
        desktop: desktopInput,
        mobile: mobileInput,
        published: publish,
        hotspots,
      })
      if (!res.ok || !res.data) throw new Error(res.error ?? 'Could not save the presentation.')

      let entry = res.data
      // Edits never change publish state on their own, so publishing an
      // existing draft is its own step.
      if (publish && initial && !initial.published) {
        const pub = await setShowcasePublished(initial.id, true)
        if (!pub.ok) throw new Error(pub.error ?? 'Saved, but could not publish it.')
        entry = { ...entry, published: true }
      }

      onSaved(entry, { created: !initial, published: entry.published })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
      setPhase(null)
    }
  }

  const label = 'block text-xs font-medium text-muted-foreground mb-1.5'

  return (
    <>
      <ModalOverlay onClose={requestClose} sheetOnMobile>
        <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[min(1120px,96vw)] max-h-[92dvh] flex flex-col shadow-2xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <div>
              <h2 className="font-semibold text-base">{initial ? 'Edit presentation' : 'New presentation'}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                One full-screen visual per client on cirqle.work/portfolio. Nothing here changes the gallery.
              </p>
            </div>
            <button
              type="button" onClick={requestClose} aria-label="Close" disabled={saving}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1 px-5 py-5">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              {/* ─── Left: the content ─────────────────────────────────── */}
              <div className="space-y-6 min-w-0">
                <section className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className={label} htmlFor="ps-client">Client name <span className="text-red-500">*</span></label>
                    <Input
                      id="ps-client" value={clientName} maxLength={MAX_CLIENT_NAME}
                      onChange={(e) => { setClientName(e.target.value); setTouched(true) }}
                      placeholder="Elara Perfumes"
                    />
                  </div>
                  <div>
                    <label className={label} htmlFor="ps-category">Category</label>
                    <Input
                      id="ps-category" value={category} maxLength={MAX_CATEGORY} list={datalistId}
                      onChange={(e) => { setCategory(e.target.value); setTouched(true) }}
                      placeholder="Brand identity"
                    />
                    <datalist id={datalistId}>
                      {CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}
                    </datalist>
                  </div>
                  <div className="sm:col-span-2">
                    <label className={label} htmlFor="ps-description">
                      Description <span className="opacity-60">· {description.length}/{MAX_DESCRIPTION}</span>
                    </label>
                    <Textarea
                      id="ps-description" value={description} maxLength={MAX_DESCRIPTION} rows={3}
                      onChange={(e) => { setDescription(e.target.value); setTouched(true) }}
                      placeholder="A visual identity for a perfume brand."
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={label} htmlFor="ps-link">Project link <span className="opacity-60">· optional</span></label>
                    <Input
                      id="ps-link" value={projectPath}
                      onChange={(e) => { setProjectPath(e.target.value); setTouched(true) }}
                      placeholder="/portfolio/brand-identity/elara-perfumes"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">Adds a “View project” link. Must start with /portfolio.</p>
                  </div>
                  <details className="sm:col-span-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Image description for screen readers</summary>
                    <Input
                      className="mt-2" value={altText} maxLength={200}
                      onChange={(e) => { setAltText(e.target.value); setTouched(true) }}
                      placeholder={defaultAltText(clientName, category) || 'Elara Perfumes — Brand identity'}
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">Left blank, it is filled in from the client name and category.</p>
                  </details>
                </section>

                {/* ─── Desktop media ─────────────────────────────────────── */}
                <MediaSection
                  icon={<Monitor className="w-4 h-4" />}
                  title="Desktop"
                  hint="Landscape works best — at least 1600px wide."
                  slot={desktop}
                  onFile={(f) => pick('desktop', f)}
                  onFocal={(focal) => { setDesktop((s) => ({ ...s, focal })); setTouched(true) }}
                  frameAspect={DESKTOP_ASPECT}
                  viewport="desktop"
                  disabled={saving}
                />

                {/* ─── Phone media ───────────────────────────────────────── */}
                <section className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4" />
                    <h3 className="text-sm font-semibold">Phone</h3>
                  </div>
                  <div role="radiogroup" aria-label="How phones get their picture" className="grid gap-2 sm:grid-cols-3">
                    {([
                      ['same', 'Same as desktop', 'Phones show the desktop picture, centred.'],
                      ['crop', 'Same picture, own crop', 'Re-frame the desktop picture for a tall screen.'],
                      ['own', 'Separate phone file', 'Upload a portrait image or video.'],
                    ] as [MobileMode, string, string][]).map(([mode, title, body]) => (
                      <button
                        key={mode} type="button" role="radio" aria-checked={mobileMode === mode} disabled={saving}
                        onClick={() => { setMobileMode(mode); setTouched(true) }}
                        className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                          mobileMode === mode
                            ? 'border-violet-500/60 bg-violet-500/10'
                            : 'border-border bg-secondary/30 hover:bg-secondary/60'
                        }`}
                      >
                        <span className="block text-xs font-medium">{title}</span>
                        <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{body}</span>
                      </button>
                    ))}
                  </div>

                  {mobileMode === 'crop' && (
                    slotMedia(desktop) ? (
                      <FocalPicker
                        key={slotMedia(desktop)!.url}
                        media={slotMedia(desktop)!}
                        focal={cropFocal}
                        onChange={(f) => { setCropFocal(f); setTouched(true) }}
                        frameAspect={MOBILE_ASPECT}
                        viewport="mobile"
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">Add the desktop picture first.</p>
                    )
                  )}

                  {mobileMode === 'own' && (
                    <MediaSection
                      title="Phone file"
                      hint="Portrait works best — at least 900px wide."
                      slot={mobile}
                      onFile={(f) => pick('mobile', f)}
                      onFocal={(focal) => { setMobile((s) => ({ ...s, focal })); setTouched(true) }}
                      frameAspect={MOBILE_ASPECT}
                      viewport="mobile"
                      disabled={saving}
                      bare
                    />
                  )}
                </section>
                <HotspotEditor value={hotspots} onChange={v => { setHotspots(v); setTouched(true) }} desktop={desktopView} mobile={mobileView} disabled={saving}/>
              </div>

              {/* ─── Right: live preview ───────────────────────────────── */}
              <aside className="min-w-0 lg:sticky lg:top-0 self-start space-y-4" aria-label="Live preview">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Live preview</h3>
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)}
                      className="accent-violet-500"
                    />
                    Website overlay
                  </label>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground mb-1.5 inline-flex items-center gap-1"><Monitor className="w-3 h-3" /> Desktop</p>
                  <ScreenPreview viewport="desktop" media={desktopView} clientName={clientName} category={category} description={description} showOverlay={showOverlay} />
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground mb-1.5 inline-flex items-center gap-1"><Smartphone className="w-3 h-3" /> Phone</p>
                  <ScreenPreview viewport="mobile" media={mobileView} clientName={clientName} category={category} description={description} showOverlay={showOverlay} />
                  {mobileView?.fellBack && mobileMode === 'same' && (
                    <p className="text-[11px] text-muted-foreground mt-2 text-center">
                      Phones show the desktop picture. Choose “own crop” to frame it for a tall screen.
                    </p>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Drawn with the same cropping rules as the website, so what you see here is what visitors get.
                </p>
              </aside>
            </div>
          </div>

          <div className="px-5 py-3.5 border-t border-border shrink-0 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[180px] text-xs">
              {saving ? (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> {phase}
                </span>
              ) : error ? (
                <span role="alert" className="text-destructive">{error}</span>
              ) : null}
            </div>
            <Button variant="outline" onClick={requestClose} disabled={saving}>Cancel</Button>
            <Button variant={initial?.published ? 'default' : 'outline'} onClick={() => save(false)} disabled={saving}>
              {initial ? 'Save changes' : 'Save as draft'}
            </Button>
            {!initial?.published && (
              <Button onClick={() => save(true)} disabled={saving}>
                <Eye className="w-3.5 h-3.5" /> Save &amp; publish
              </Button>
            )}
          </div>
        </div>
      </ModalOverlay>

      {confirmClose && (
        <ConfirmDialog
          title="Discard your changes?"
          body="You have unsaved changes to this presentation. Closing now throws them away."
          confirmLabel="Discard"
          danger
          onConfirm={() => { setConfirmClose(false); onClose() }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  )
}

// ─── One side's drop zone and focal picker ───────────────────────────────────

function MediaSection({
  icon, title, hint, slot, onFile, onFocal, frameAspect, viewport, disabled, bare = false,
}: {
  icon?: React.ReactNode
  title: string
  hint: string
  slot: Slot
  onFile: (file: File) => void
  onFocal: (focal: { x: number; y: number }) => void
  frameAspect: number
  viewport: 'desktop' | 'mobile'
  disabled?: boolean
  /** No heading — used when nested under another section's heading. */
  bare?: boolean
}) {
  const media = slotMedia(slot)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  function take(files: FileList | null) {
    const f = files?.[0]
    if (f) onFile(f)
    if (input.current) input.current.value = ''
  }

  return (
    <section className="space-y-3">
      {!bare && (
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold">{title}</h3>
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        </div>
      )}
      {bare && <p className="text-[11px] text-muted-foreground">{hint}</p>}

      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => take(e.target.files)} />

      {media ? (
        <>
          <FocalPicker
            key={media.url}
            media={media}
            focal={slot.focal}
            onChange={onFocal}
            frameAspect={frameAspect}
            viewport={viewport}
          />
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 min-w-0">
              {slot.type === 'video' ? <Film className="w-3 h-3 shrink-0" /> : <ImageIcon className="w-3 h-3 shrink-0" />}
              <span className="truncate">{slot.file ? slot.file.name : slot.type === 'video' ? 'Saved video' : 'Saved image'}</span>
              {slot.file && <span className="shrink-0 text-violet-500">· will upload on save</span>}
            </span>
            <button
              type="button" disabled={disabled} onClick={() => input.current?.click()}
              className="shrink-0 inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
            >
              <Upload className="w-3 h-3" /> Replace
            </button>
          </div>
        </>
      ) : (
        <div
          role="button" tabIndex={0} aria-label={`Choose the ${viewport} file`}
          onClick={() => !disabled && input.current?.click()}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) { e.preventDefault(); input.current?.click() } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) take(e.dataTransfer.files) }}
          className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-10 text-center cursor-pointer transition-colors ${
            over ? 'border-violet-500 bg-violet-500/10' : 'border-border bg-secondary/30 hover:bg-secondary/60'
          }`}
        >
          <Upload className="w-5 h-5 text-muted-foreground" />
          <p className="text-xs font-medium">Drop a file here, or click to choose</p>
          <p className="text-[11px] text-muted-foreground">JPG, PNG, WebP or AVIF image · MP4, WebM or MOV video</p>
        </div>
      )}
    </section>
  )
}
