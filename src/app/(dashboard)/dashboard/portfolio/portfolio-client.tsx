'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Upload, Loader2, Trash2, Eye, EyeOff, ExternalLink, Plus, Pencil, GripVertical, ImageOff,
  Play, Link2, Film,
} from 'lucide-react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast, ToastContainer } from '@/components/ui/toast'
import type { FlyerRow, PortfolioBrand, PortfolioCollection, PortfolioItem, WorkFormat } from '@/lib/portfolio/types'
import { WORK_FORMAT_LABEL, formatsFor } from '@/lib/portfolio/types'
import { prepareLogoForUpload, slugFromFilename, titleFromFilename } from '@/lib/portfolio/resize'
import type { PreparedLogo } from '@/lib/portfolio/resize'
import FlyersPanel from './flyers-panel'
import { uploadMedia } from './upload-media'
import {
  createWorkUploadUrls, deleteBrand, deleteWorkItem, reorderBrands, reorderCollectionItems,
  reorderWorkItems, saveBrand, saveBrandLogo, saveWorkItem, updateWorkItem,
} from './actions'

interface Props {
  configured: boolean
  collections: PortfolioCollection[]
  flyers: FlyerRow[]
  flyerError: string | null
  loadError: string | null
  canManage: boolean
  siteUrl: string
}

interface UploadProgress {
  name: string
  step: string
  failed?: boolean
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm,video/quicktime'

export default function PortfolioClient({
  configured, collections, flyers, flyerError, loadError, canManage, siteUrl,
}: Props) {
  const router = useRouter()
  const toast = useToast()

  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? '')
  const collection = useMemo(
    () => collections.find((c) => c.id === collectionId) ?? collections[0],
    [collections, collectionId],
  )

  // A sentinel rather than a nullable brand: "no brand chosen" already means
  // "fall back to the first one" everywhere below, and the All view has to be
  // a deliberate choice, not the absence of one.
  const ALL = '__all__'
  const [brandId, setBrandId] = useState(collection?.brands[0]?.id ?? '')
  const showingAll = brandId === ALL
  const brand: PortfolioBrand | undefined = useMemo(
    () => (showingAll ? undefined : collection?.brands.find((b) => b.id === brandId) ?? collection?.brands[0]),
    [collection, brandId, showingAll],
  )

  // Every creative in the collection, in the order the website's All view puts
  // them: hand-placed first, then everything never dragged, in brand order.
  const [allOrder, setAllOrder] = useState<string[] | null>(null)
  const [brandOrder, setBrandOrder] = useState<string[] | null>(null)
  const brands = useMemo(() => {
    const list = collection?.brands ?? []
    if (!brandOrder) return list
    const byId = new Map(list.map((b) => [b.id, b]))
    const picked = brandOrder.map((id) => byId.get(id)).filter(Boolean) as PortfolioBrand[]
    return picked.length === list.length ? picked : list
  }, [collection, brandOrder])

  const allItems = useMemo(() => {
    const flat = (collection?.brands ?? []).flatMap((b) =>
      b.items.map((i) => ({ ...i, brandName: b.name })),
    )
    const sorted = flat
      .slice()
      .sort(
        (a, z) =>
          (a.collectionPosition ?? Number.MAX_SAFE_INTEGER) -
          (z.collectionPosition ?? Number.MAX_SAFE_INTEGER),
      )
    if (!allOrder) return sorted
    const byId = new Map(sorted.map((i) => [i.id, i]))
    const picked = allOrder.map((id) => byId.get(id)).filter(Boolean) as typeof sorted
    return picked.length === sorted.length ? picked : sorted
  }, [collection, allOrder])

  // Local order so a drag feels instant; the server call follows.
  const [order, setOrder] = useState<string[] | null>(null)
  const items = useMemo(() => {
    const list = brand?.items ?? []
    if (!order) return list
    const byId = new Map(list.map((i) => [i.id, i]))
    const sorted = order.map((id) => byId.get(id)).filter(Boolean) as PortfolioItem[]
    return sorted.length === list.length ? sorted : list
  }, [brand, order])

  const [uploads, setUploads] = useState<UploadProgress[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [tab, setTab] = useState<'work' | 'flyers'>('work')
  const [linkModal, setLinkModal] = useState<{ url: string; title: string; cover: File | null } | null>(null)
  const [linkBusy, setLinkBusy] = useState<string | null>(null)
  const coverRef = useRef<HTMLInputElement>(null)
  const [brandModal, setBrandModal] = useState<
    {
      id?: string
      name: string
      tagline: string
      logoUrl: string | null
      logo: File | null
      /** What will actually be uploaded, and what the preview shows. */
      prepared?: { logo: PreparedLogo; url: string } | null
      removePlate?: boolean
      clearLogo?: boolean
    } | null
  >(null)
  const [brandBusy, setBrandBusy] = useState<string | null>(null)
  const logoRef = useRef<HTMLInputElement>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string; caption: string } | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // ─── Setup states ──────────────────────────────────────────────────────────
  if (!configured) {
    return (
      <div className="p-6">
        <Notice
          title="Website project not connected"
          body="Portfolio content lives in the website's own Supabase project. Add WEBSITE_SUPABASE_URL and WEBSITE_SUPABASE_SERVICE_ROLE_KEY to this app's environment, then reload. Setup steps are in cirqle-website/supabase/README.md."
        />
      </div>
    )
  }

  // A failed work query used to return early, which also took the flyers tab
  // with it — flyers are a separate query and may be perfectly healthy.
  const workNotice = loadError
    ? { title: 'Could not load the portfolio', body: loadError }
    : !collection
      ? {
          title: 'No collections yet',
          body: "Run cirqle-website/supabase/schema.sql in the website project's SQL editor. It creates the tables and the first collection.",
        }
      : null

  // ─── Upload ────────────────────────────────────────────────────────────────
  async function uploadFiles(files: FileList | File[]) {
    if (!brand || !collection) {
      toast.toastError('Pick a brand first', 'Create a brand to upload work into.')
      return
    }
    const list = Array.from(files).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
    )
    if (!list.length) return

    setBusy(true)
    setUploads(list.map((f) => ({ name: f.name, step: 'Waiting' })))

    let done = 0
    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      const mark = (step: string, failed?: boolean) =>
        setUploads((prev) => prev.map((u, n) => (n === i ? { ...u, step, failed } : u)))

      const isVideo = file.type.startsWith('video/')

      try {
        const slug = slugFromFilename(file.name)
        const media = await uploadMedia(
          file,
          { collectionSlug: collection.slug, brandSlug: brand.slug, slug },
          mark,
        )

        mark('Saving')
        const saved = await saveWorkItem({
          brandId: brand.id,
          collectionSlug: collection.slug,
          slug,
          title: titleFromFilename(file.name),
          kind: isVideo ? 'video' : 'image',
          mediaPath: media.mediaPath,
          durationSeconds: media.durationSeconds,
          width: media.width,
          height: media.height,
          variants: media.variants,
        })
        if (!saved.ok) {
          mark(saved.error ?? 'Could not save', true)
          continue
        }

        mark(media.posterMissing ? 'Published (no poster)' : 'Published')
        done++
      } catch (e) {
        // Without this the user watches a spinner forever on a dropped connection.
        mark(e instanceof Error ? e.message : 'Upload failed', true)
      }
    }

    setBusy(false)
    if (done) {
      toast.success(`${done} ${done === 1 ? 'creative' : 'creatives'} published`, 'Live on the website now.')
      setOrder(null)
      router.refresh()
    }
    window.setTimeout(() => setUploads([]), done === list.length ? 2500 : 8000)
  }

  // ─── Item actions ──────────────────────────────────────────────────────────
  async function togglePublished(item: PortfolioItem) {
    const res = await updateWorkItem(item.id, { published: !item.published })
    if (!res.ok) { toast.toastError('Could not update', res.error); return }
    toast.success(item.published ? 'Hidden from the website' : 'Visible on the website')
    router.refresh()
  }

  async function onAllDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = allItems.map((i) => i.id)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    setAllOrder(next)
    const res = await reorderCollectionItems(next)
    if (!res.ok) {
      setAllOrder(null)
      toast.toastError('Could not save the new order', res.error)
      return
    }
    router.refresh()
  }

  async function onBrandDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !collection) return
    const ids = collection.brands.map((b) => b.id)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    setBrandOrder(next)
    const res = await reorderBrands(next)
    if (!res.ok) {
      setBrandOrder(null)
      toast.toastError('Could not save the brand order', res.error)
      return
    }
    router.refresh()
  }

  /**
   * Retag a creative. The website groups by brand AND by format, so this is
   * what decides whether a piece shows up under Reels or Stories there.
   */
  async function setFormat(item: PortfolioItem, format: WorkFormat) {
    if (format === item.format) return
    const res = await updateWorkItem(item.id, { format })
    if (!res.ok) { toast.toastError('Could not change the format', res.error); return }
    router.refresh()
  }

  async function commitRename() {
    if (!renaming) return
    const res = await updateWorkItem(renaming.id, { title: renaming.title, caption: renaming.caption })
    if (!res.ok) { toast.toastError('Could not save', res.error); return }
    setRenaming(null)
    router.refresh()
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = items.map((i) => i.id)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    setOrder(next)
    const res = await reorderWorkItems(next)
    if (!res.ok) {
      setOrder(null)
      toast.toastError('Could not save the new order', res.error)
      return
    }
    router.refresh()
  }

  /**
   * Publish a reel that lives on Instagram, YouTube or similar.
   *
   * Nothing can be pulled from the link itself - those platforms block
   * cross-origin reads - so the cover is whatever the user attaches. A short
   * muted clip is best: it plays on hover and in the viewer, while the button
   * still sends people to the real post.
   */
  async function submitLink() {
    if (!linkModal || !brand || !collection) return
    const title = linkModal.title.trim()
    const url = linkModal.url.trim()
    if (!title) { toast.toastError('Give it a title', 'This is what visitors read under the tile.'); return }
    if (!/^https:\/\//i.test(url)) { toast.toastError('Check the link', 'It must start with https://'); return }

    const slug = slugFromFilename(title) || `reel-${Date.now().toString(36)}`
    setLinkBusy('Saving')
    try {
      let media = null
      if (linkModal.cover) {
        media = await uploadMedia(
          linkModal.cover,
          { collectionSlug: collection.slug, brandSlug: brand.slug, slug },
          (step) => setLinkBusy(step),
        )
      }

      setLinkBusy('Saving')
      const res = await saveWorkItem({
        brandId: brand.id,
        collectionSlug: collection.slug,
        slug,
        title,
        kind: 'reel',
        externalUrl: url,
        mediaPath: media?.mediaPath ?? null,
        durationSeconds: media?.durationSeconds ?? null,
        // Portrait is the safe default for a reel with no cover yet.
        width: media?.width || 1080,
        height: media?.height || 1920,
        variants: media?.variants ?? [],
      })
      if (!res.ok) { toast.toastError('Could not save the reel', res.error); return }

      setLinkModal(null)
      toast.success(
        'Reel added',
        media?.mediaPath ? 'Its clip plays on hover.' : media ? 'Cover uploaded.' : 'Add a cover later so it is not a blank tile.',
      )
      router.refresh()
    } catch (e) {
      toast.toastError('Could not add the reel', e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setLinkBusy(null)
    }
  }

  /**
   * Re-render the logo preview from the chosen file.
   *
   * The preview IS the upload: the same prepared blob is what goes to storage,
   * so what the dialog shows on its dark pill is exactly what the website chip
   * will draw. Guessing from the original file would let the two drift.
   */
  /** The logo already in storage, back as a File so it can be reprocessed. */
  async function fetchStoredLogo(url: string): Promise<File> {
    const res = await fetch(url, { cache: 'reload' })
    if (!res.ok) throw new Error(`Could not read the stored logo (${res.status}).`)
    return new File([await res.blob()], 'logo.webp', { type: 'image/webp' })
  }

  async function prepareLogo(file: File, removePlate: boolean | undefined, previous?: string) {
    const logo = await prepareLogoForUpload(file, { removePlate })
    if (previous) URL.revokeObjectURL(previous)
    return { logo, url: URL.createObjectURL(logo.blob) }
  }

  async function submitBrand() {
    if (!brandModal || !collection) return
    setBrandBusy('Saving')
    try {
      const res = await saveBrand({
        id: brandModal.id,
        collectionId: collection.id,
        name: brandModal.name,
        tagline: brandModal.tagline,
      })
      if (!res.ok) { toast.toastError('Could not save the brand', res.error); return }
      const saved = res.data
      if (saved && !brandModal.id) setBrandId(saved.id)

      // The logo goes up only after the brand exists, because its storage path
      // is built from the brand's slug — which the server decides, not us.
      if (saved && brandModal.prepared) {
        setBrandBusy('Uploading the logo')
        const logoPath = await uploadBrandLogo(brandModal.prepared.logo, collection.slug, saved.slug)
        const linked = await saveBrandLogo(saved.id, logoPath)
        if (!linked.ok) { toast.toastError('Saved the brand, but not its logo', linked.error); return }
      } else if (saved && brandModal.clearLogo) {
        const cleared = await saveBrandLogo(saved.id, null)
        if (!cleared.ok) { toast.toastError('Saved the brand, but could not remove its logo', cleared.error); return }
      }

      setBrandModal(null)
      toast.success('Brand saved')
      router.refresh()
    } catch (e) {
      toast.toastError('Could not save the brand', e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setBrandBusy(null)
    }
  }

  /**
   * Put a brand logo in storage and return its path.
   *
   * One small rendition is enough — it is drawn about 20 pixels tall on a chip.
   * A flat background is erased on the way, because the site uses the file's
   * alpha channel as a mask for the monochrome version: a logo still sitting
   * on its white rectangle would mask as a white rectangle.
   */
  async function uploadBrandLogo(logo: PreparedLogo, collectionSlug: string, brandSlug: string): Promise<string> {
    const targets = await createWorkUploadUrls({
      collectionSlug,
      brandSlug,
      slug: 'logo',
      widths: [logo.width],
    })
    if (!targets.ok || !targets.data?.length) throw new Error(targets.error ?? 'Could not prepare the upload.')

    const target = targets.data[0]
    const put = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: logo.blob,
    })
    if (!put.ok) throw new Error(`The logo did not upload (${put.status}).`)
    return target.path
  }

  const brandUrl = brand ? `${siteUrl}/portfolio/${collection.slug}/${brand.slug}` : null

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Website Portfolio</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Work published on cirqle.work. Uploads are resized in your browser and go live immediately.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {collection && <a
            href={`${siteUrl}/portfolio/${collection.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="w-3.5 h-3.5" /> View live
          </a>}
          {canManage && tab === 'work' && collection && (
            <Button size="sm" onClick={() => setBrandModal({ name: '', tagline: '', logoUrl: null, logo: null })}>
              <Plus className="w-3.5 h-3.5" /> New brand
            </Button>
          )}
        </div>
      </div>

      {/* Work and flyers are both published to the website, so they live
          behind one nav entry rather than two. */}
      <div className="flex items-center gap-1 border-b border-border">
        {([
          { id: 'work' as const, label: 'Work', count: collections.reduce((n, c) => n + c.brands.reduce((m, b) => m + b.items.length, 0), 0) },
          { id: 'flyers' as const, label: 'Supermarket flyers', count: flyers.length },
        ]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-violet-500 text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label} <span className="opacity-60">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'flyers' && (
        <FlyersPanel
          flyers={flyers}
          error={flyerError}
          canManage={canManage}
          siteUrl={siteUrl}
          onToast={(kind, title, body) =>
            kind === 'success' ? toast.success(title, body) : toast.toastError(title, body)
          }
        />
      )}

      {tab === 'work' && workNotice && <Notice title={workNotice.title} body={workNotice.body} />}

      {tab === 'work' && collection && collections.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => { setCollectionId(c.id); setBrandId(c.brands[0]?.id ?? ''); setOrder(null) }}
              className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                c.id === collection.id
                  ? 'bg-foreground text-background border-transparent'
                  : 'border-border bg-secondary text-muted-foreground hover:text-foreground'
              }`}
            >
              {c.title}
            </button>
          ))}
        </div>
      )}

      {/* ─── Brands ─────────────────────────────────────────────────────── */}
      {tab === 'work' && collection && (collection.brands.length === 0 ? (
        <Notice
          title="No brands yet"
          body="Create a brand — a client whose work you want to show — then upload their creatives into it."
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {/* The website's All view, and the only place its order can be set. */}
          <button
            type="button"
            onClick={() => { setBrandId(ALL); setOrder(null) }}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-colors ${
              showingAll
                ? 'bg-foreground text-background border-transparent'
                : 'border-border bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            All work
            <span className="opacity-60">{allItems.length}</span>
          </button>

          <span className="w-px h-5 bg-border" aria-hidden />

          {/* Brand chips are draggable: their order is the order the website
              lists brands in, and the order All falls back to. */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onBrandDragEnd}>
            <SortableContext items={brands.map((b) => b.id)} strategy={rectSortingStrategy}>
              {brands.map((b) => (
                <BrandChip
                  key={b.id}
                  brand={b}
                  active={b.id === brand?.id}
                  canManage={canManage}
                  onSelect={() => { setBrandId(b.id); setOrder(null) }}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      ))}

      {/* ─── All work: the order the website's "All" chip shows ─────────── */}
      {tab === 'work' && collection && showingAll && (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-medium">All work</h2>
            <p className="text-xs text-muted-foreground mt-1">
              {canManage
                ? 'Drag to set the order of the All view on the website. Each brand keeps its own order on its own page — this is only the mixed list.'
                : 'The order of the All view on the website.'}
            </p>
          </div>

          {allItems.length === 0 ? (
            <div className="text-center py-12 text-xs text-muted-foreground">
              <ImageOff className="w-5 h-5 mx-auto mb-2 opacity-50" />
              Nothing published in this collection yet.
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onAllDragEnd}>
              <SortableContext items={allItems.map((i) => i.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {allItems.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      brandName={item.brandName}
                      canManage={canManage}
                      onToggle={() => void togglePublished(item)}
                      onFormat={(f) => void setFormat(item, f)}
                      formats={formatsFor(collection.slug)}
                      onRename={() => setRenaming({ id: item.id, title: item.title, caption: item.caption })}
                      onDelete={() =>
                        setConfirm({
                          title: `Delete "${item.title}"?`,
                          body: 'This removes it from the website and deletes its image files. It cannot be undone.',
                          run: async () => {
                            const res = await deleteWorkItem(item.id)
                            if (!res.ok) { toast.toastError('Could not delete', res.error); return }
                            setAllOrder(null)
                            toast.success('Deleted')
                            router.refresh()
                          },
                        })
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}

      {/* ─── Selected brand ─────────────────────────────────────────────── */}
      {tab === 'work' && brand && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-medium truncate">{brand.name}</h2>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => setBrandModal({ id: brand.id, name: brand.name, tagline: brand.tagline ?? '', logoUrl: brand.logoUrl, logo: null })}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Edit brand"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {brandUrl && (
                <a
                  href={brandUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-muted-foreground hover:text-foreground break-all"
                >
                  {brandUrl}
                </a>
              )}
            </div>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setConfirm({
                    title: `Delete ${brand.name}?`,
                    body: `This removes the brand, its ${brand.items.length} creative(s) and their image files from the website. It cannot be undone.`,
                    run: async () => {
                      const res = await deleteBrand(brand.id)
                      if (!res.ok) { toast.toastError('Could not delete the brand', res.error); return }
                      setBrandId('')
                      toast.success('Brand deleted')
                      router.refresh()
                    },
                  })
                }
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete brand
              </Button>
            )}
          </div>

          {/* Drop zone */}
          {canManage && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(e.dataTransfer.files) }}
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl px-6 py-8 flex flex-col items-center justify-center cursor-pointer transition-colors ${
                dragOver ? 'border-violet-500 bg-violet-500/5' : 'border-border hover:border-violet-500/40 hover:bg-secondary/30'
              } ${busy ? 'opacity-60 pointer-events-none' : ''}`}
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin mb-2" /> : <Upload className="w-5 h-5 mb-2 text-muted-foreground" />}
              <p className="text-sm">Drop images or videos here, or click to choose</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Images are converted to WebP at four widths before uploading. Videos go up as they are, up to 50 MB,
                and a poster frame is taken automatically. The file name becomes the title.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => { const f = e.target.files; e.target.value = ''; if (f?.length) void uploadFiles(f) }}
              />
            </div>
          )}

          {/* A reel lives on Instagram or YouTube rather than in our storage,
              but it still belongs to THIS brand — so the button sits with the
              brand's own drop zone, not up in the page header where it read as
              a global action. */}
          {canManage && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span>Published somewhere else?</span>
              <button
                type="button"
                onClick={() => setLinkModal({ url: '', title: '', cover: null })}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-secondary text-xs text-muted-foreground hover:text-foreground hover:border-violet-500/40"
              >
                <Link2 className="w-3.5 h-3.5" /> Add a reel link to {brand.name}
              </button>
            </div>
          )}

          {uploads.length > 0 && (
            <div className="rounded-xl border border-border bg-secondary/40 divide-y divide-border">
              {uploads.map((u) => (
                <div key={u.name} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="truncate">{u.name}</span>
                  <span className={u.failed ? 'text-red-500 shrink-0' : 'text-muted-foreground shrink-0'}>{u.step}</span>
                </div>
              ))}
            </div>
          )}

          {/* Items */}
          {items.length === 0 ? (
            <div className="text-center py-12 text-xs text-muted-foreground">
              <ImageOff className="w-5 h-5 mx-auto mb-2 opacity-50" />
              Nothing published for this brand yet.
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {items.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      canManage={canManage}
                      onToggle={() => void togglePublished(item)}
                      onFormat={(f) => void setFormat(item, f)}
                      formats={formatsFor(collection.slug)}
                      onRename={() => setRenaming({ id: item.id, title: item.title, caption: item.caption })}
                      onDelete={() =>
                        setConfirm({
                          title: `Delete "${item.title}"?`,
                          body: 'This removes it from the website and deletes its image files. It cannot be undone.',
                          run: async () => {
                            const res = await deleteWorkItem(item.id)
                            if (!res.ok) { toast.toastError('Could not delete', res.error); return }
                            setOrder(null)
                            toast.success('Deleted')
                            router.refresh()
                          },
                        })
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}

      {/* ─── Modals ─────────────────────────────────────────────────────── */}
      {brandModal && (
        <ModalOverlay onClose={() => setBrandModal(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-5 space-y-4 w-full max-w-sm overflow-y-auto">
            <h3 className="text-sm font-medium">{brandModal.id ? 'Edit brand' : 'New brand'}</h3>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={brandModal.name}
                onChange={(e) => setBrandModal({ ...brandModal, name: e.target.value })}
                placeholder="Cell World"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Tagline</label>
              <Input
                value={brandModal.tagline}
                onChange={(e) => setBrandModal({ ...brandModal, tagline: e.target.value })}
                placeholder="Mobile retail · Akkikkavu &amp; Karikkad"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Logo</label>

              {/* The preview is the chip, not a thumbnail: same dark pill, same
                  one-colour mask, same size. What is judged here is what ships. */}
              {(brandModal.prepared || (brandModal.logoUrl && !brandModal.clearLogo)) && (
                <div className="flex items-center gap-3 py-1">
                  <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#1b1430] text-white/85">
                    <span
                      className="block w-[84px] h-5 bg-current"
                      style={{
                        WebkitMaskImage: `url(${brandModal.prepared?.url ?? brandModal.logoUrl})`,
                        maskImage: `url(${brandModal.prepared?.url ?? brandModal.logoUrl})`,
                        WebkitMaskRepeat: 'no-repeat',
                        maskRepeat: 'no-repeat',
                        WebkitMaskPosition: 'center',
                        maskPosition: 'center',
                        WebkitMaskSize: 'contain',
                        maskSize: 'contain',
                      }}
                    />
                    <span className="text-[10px] opacity-60">12</span>
                  </span>
                  <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#1b1430]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- blob preview */}
                    <img
                      src={brandModal.prepared?.url ?? brandModal.logoUrl!}
                      alt=""
                      className="block w-[84px] h-5 object-contain"
                    />
                    <span className="text-[10px] text-white/60">12</span>
                  </span>
                  <span className="text-[10px] text-muted-foreground leading-tight">
                    resting<br />hover
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => logoRef.current?.click()}
                  className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border bg-secondary/40 text-xs text-muted-foreground hover:text-foreground hover:border-violet-500/40"
                >
                  <Upload className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {brandModal.logo
                      ? brandModal.logo.name
                      : brandModal.logoUrl && !brandModal.clearLogo
                        ? 'Replace the logo'
                        : 'Choose a logo'}
                  </span>
                </button>
                {(brandModal.prepared || (brandModal.logoUrl && !brandModal.clearLogo)) && (
                  <IconBtn
                    label="Remove the logo"
                    onClick={() => setBrandModal({ ...brandModal, logo: null, prepared: null, clearLogo: true })}
                  >
                    <Trash2 className="w-3 h-3" />
                  </IconBtn>
                )}
              </div>
              <input
                ref={logoRef}
                type="file"
                accept="image/png,image/webp,image/jpeg,image/avif"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0] ?? null
                  e.target.value = ''
                  if (!f) return
                  try {
                    // Undefined, not false: let the detector decide, then show
                    // what it decided in the checkbox so it can be overruled.
                    const prepared = await prepareLogo(f, undefined, brandModal.prepared?.url)
                    setBrandModal({
                      ...brandModal,
                      logo: f,
                      prepared,
                      removePlate: prepared.logo.plateRemoved,
                      clearLogo: false,
                    })
                  } catch (err) {
                    toast.toastError('Could not read that image', err instanceof Error ? err.message : undefined)
                  }
                }}
              />

              {(brandModal.logo || (brandModal.logoUrl && !brandModal.clearLogo)) && (
                <label className="flex items-start gap-2 text-[11px] text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!brandModal.removePlate}
                    className="mt-0.5"
                    onChange={async (e) => {
                      const removePlate = e.target.checked
                      try {
                        // Works on a logo already in storage as well as on a
                        // freshly chosen file: it is fetched back and treated
                        // as the source, so a plate can be taken off without
                        // hunting down the original artwork again.
                        const file = brandModal.logo ?? (await fetchStoredLogo(brandModal.logoUrl!))
                        const prepared = await prepareLogo(file, removePlate, brandModal.prepared?.url)
                        setBrandModal({ ...brandModal, logo: file, removePlate, prepared })
                      } catch (err) {
                        toast.toastError('Could not read that image', err instanceof Error ? err.message : undefined)
                      }
                    }}
                  />
                  <span>
                    Remove the plate behind the mark — the white shape the logo is drawn on. Found and removed
                    automatically; untick it if the logo has white letters sitting on a coloured shape, since those go
                    with it. Watch the resting preview.
                  </span>
                </label>
              )}

              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Shown on the website in place of the brand name: one flat colour that matches the page, turning full
                colour when someone points at it. Every logo is drawn at the same size. The name is still what screen
                readers and search engines get.
              </p>
            </div>

            {!brandModal.id && (
              <p className="text-[11px] text-muted-foreground">
                The web address is made from the name and cannot be changed later.
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" disabled={!!brandBusy} onClick={() => setBrandModal(null)}>Cancel</Button>
              <Button type="button" className="flex-1" disabled={!!brandBusy} onClick={() => void submitBrand()}>
                {brandBusy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {brandBusy}</> : 'Save'}
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {linkModal && (
        <ModalOverlay onClose={() => setLinkModal(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-5 space-y-4 w-full max-w-sm overflow-y-auto">
            <div>
              <h3 className="text-sm font-medium">
                Add a reel by link{brand ? ` to ${brand.name}` : ''}
              </h3>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                For work already published on Instagram, YouTube or TikTok. Nothing is uploaded, so it costs no
                storage. YouTube plays on the site; the others show a cover and send the visitor to the post.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Title</label>
              <Input
                value={linkModal.title}
                onChange={(e) => setLinkModal({ ...linkModal, title: e.target.value })}
                placeholder="Nabidina Reel"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Link</label>
              <Input
                value={linkModal.url}
                onChange={(e) => setLinkModal({ ...linkModal, url: e.target.value })}
                placeholder="https://www.instagram.com/reel/..."
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Cover</label>
              <button
                type="button"
                onClick={() => coverRef.current?.click()}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border bg-secondary/40 text-xs text-muted-foreground hover:text-foreground hover:border-violet-500/40"
              >
                <Upload className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{linkModal.cover ? linkModal.cover.name : 'Choose an image or a short clip'}</span>
              </button>
              <input
                ref={coverRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  e.target.value = ''
                  if (f) setLinkModal({ ...linkModal, cover: f })
                }}
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Instagram will not let us read the reel, so the cover has to come from you. A 3-6 second muted clip
                is best - it plays on hover and in the viewer, and the button still opens the real post. A still
                image works too.
              </p>
            </div>
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" disabled={!!linkBusy} onClick={() => setLinkModal(null)}>Cancel</Button>
              <Button type="button" className="flex-1" disabled={!!linkBusy} onClick={() => void submitLink()}>
                {linkBusy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {linkBusy}</> : 'Add reel'}
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {renaming && (
        <ModalOverlay onClose={() => setRenaming(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-5 space-y-4 w-full max-w-sm overflow-y-auto">
            <h3 className="text-sm font-medium">Edit creative</h3>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Caption</label>
              <Input
                value={renaming.caption}
                onChange={(e) => setRenaming({ ...renaming, caption: e.target.value })}
                placeholder="Eid al-Fitr greeting"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') void commitRename() }}
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                What the website shows under this piece. Leave it empty and the tile carries the brand name alone —
                which is better than a file name.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">File name</label>
              <Input
                value={renaming.title}
                onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void commitRename() }}
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Only used here, to find this piece again. Never shown to visitors.
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="button" className="flex-1" onClick={() => void commitRename()}>Save</Button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel="Delete"
          danger
          onConfirm={async () => { const run = confirm.run; setConfirm(null); await run() }}
          onCancel={() => setConfirm(null)}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-border bg-secondary/40 px-5 py-6 max-w-2xl">
      <h2 className="text-sm font-medium mb-1">{title}</h2>
      <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
    </div>
  )
}

function ItemCard({
  item, brandName, canManage, onToggle, onFormat, formats, onRename, onDelete,
}: {
  item: PortfolioItem
  /** Set only in the All view, where one grid mixes every brand. */
  brandName?: string
  canManage: boolean
  onToggle: () => void
  onFormat: (format: WorkFormat) => void
  /** What this collection publishes — social posts, identity pieces, … */
  formats: readonly WorkFormat[]
  onRename: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canManage,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="group relative rounded-xl overflow-hidden border border-border bg-secondary"
    >
      <div className="aspect-[4/5] bg-background/40">
        {item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the website project's storage host is not in next.config images
          <img
            src={item.previewUrl}
            alt={item.title}
            loading="lazy"
            className={`w-full h-full object-cover ${item.published ? '' : 'opacity-40 grayscale'}`}
          />
        ) : (
          <div className="w-full h-full grid place-items-center text-muted-foreground">
            <ImageOff className="w-4 h-4" />
          </div>
        )}
      </div>

      {item.kind !== 'image' && (
        <span
          className="absolute top-1.5 left-8 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-background/85 text-[10px] text-muted-foreground"
          title={item.kind === 'video' ? 'Plays on the website' : 'Opens on the platform'}
        >
          {item.kind === 'video' ? <Play className="w-2.5 h-2.5" /> : <Film className="w-2.5 h-2.5" />}
          {item.kind === 'video' ? 'Video' : 'Reel'}
        </span>
      )}

      <div className="px-2.5 py-2 space-y-1.5">
        <p className="text-[11px] font-medium truncate" title={item.caption || item.title}>
          {item.caption || item.title}
        </p>
        <p className="text-[10px] text-muted-foreground truncate">
          {brandName ? `${brandName} · ` : ''}
          {item.kind === 'reel'
            ? hostOf(item.externalUrl)
            : `${item.width}×${item.height} · ${item.variants.length} sizes`}
          {!item.published && ' · hidden'}
        </p>
        {canManage ? (
          // Always visible rather than hover-revealed: this is the one field a
          // creative can be filed under wrongly without anyone noticing.
          <select
            value={item.format}
            onChange={(e) => onFormat(e.target.value as WorkFormat)}
            aria-label={`Format for ${item.title}`}
            className="w-full text-[10px] rounded-md border border-border bg-background/60 px-1.5 py-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500"
          >
            {/* A creative uploaded before this collection had its own
                vocabulary can hold a format the list does not offer. Without
                it here the select would show the FIRST option while the row
                still said something else — the one state worse than wrong. */}
            {(formats.includes(item.format) ? formats : [item.format, ...formats]).map((f) => (
              <option key={f} value={f}>{WORK_FORMAT_LABEL[f]}</option>
            ))}
          </select>
        ) : (
          <p className="text-[10px] text-muted-foreground">{WORK_FORMAT_LABEL[item.format]}</p>
        )}
      </div>

      {canManage && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconBtn label={item.published ? 'Hide from the website' : 'Show on the website'} onClick={onToggle}>
            {item.published ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </IconBtn>
          <IconBtn label="Rename" onClick={onRename}><Pencil className="w-3 h-3" /></IconBtn>
          <IconBtn label="Delete" onClick={onDelete}><Trash2 className="w-3 h-3" /></IconBtn>
        </div>
      )}

      {canManage && (
        <button
          type="button"
          className="absolute top-1.5 left-1.5 p-1 rounded-md bg-background/80 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

/**
 * A brand chip that can be dragged to reorder the brands.
 *
 * Drag and click share one element on purpose — a separate grip on something
 * this small is fiddly. dnd-kit's PointerSensor is configured with a distance
 * threshold, so a plain click still selects the brand and only a real drag
 * moves it.
 */
function BrandChip({
  brand, active, canManage, onSelect,
}: {
  brand: PortfolioBrand
  active: boolean
  canManage: boolean
  onSelect: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: brand.id,
    disabled: !canManage,
  })
  const hidden = brand.items.filter((i) => !i.published).length

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onSelect}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-colors ${
        canManage ? 'cursor-grab active:cursor-grabbing' : ''
      } ${
        active
          ? 'bg-foreground text-background border-transparent'
          : 'border-border bg-secondary text-muted-foreground hover:text-foreground'
      }`}
      {...attributes}
      {...listeners}
    >
      {brand.logoUrl ? (
        // The name stays in the title attribute: the chip is how the website
        // will look, but the editor still has to be able to say which brand
        // this is when a logo is a wordmark nobody recognises out of context.
        // eslint-disable-next-line @next/next/no-img-element -- the website project's storage host is not in next.config images
        <img src={brand.logoUrl} alt={brand.name} title={brand.name} className="h-4 max-w-[84px] object-contain" />
      ) : (
        brand.name
      )}
      <span className="opacity-60">{brand.items.length}</span>
      {hidden > 0 && <span className="opacity-60">· {hidden} hidden</span>}
    </button>
  )
}

/**
 * Host of a stored link, for the card subtitle. Never throws: a malformed URL
 * saved before validation tightened would otherwise crash the whole page.
 */
function hostOf(url: string | null): string {
  if (!url) return 'link'
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'invalid link'
  }
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="p-1 rounded-md bg-background/80 text-muted-foreground hover:text-foreground"
    >
      {children}
    </button>
  )
}
