'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Upload, Loader2, Trash2, Eye, EyeOff, ExternalLink, Plus, Pencil, GripVertical, ImageOff,
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
import type { PortfolioBrand, PortfolioCollection, PortfolioItem } from '@/lib/portfolio/types'
import { MAX_SOURCE_BYTES } from '@/lib/portfolio/types'
import { resizeForUpload, slugFromFilename, titleFromFilename } from '@/lib/portfolio/resize'
import {
  createWorkUploadUrls, deleteBrand, deleteWorkItem, reorderWorkItems, saveBrand, saveWorkItem,
  updateWorkItem,
} from './actions'

interface Props {
  configured: boolean
  collections: PortfolioCollection[]
  loadError: string | null
  canManage: boolean
  siteUrl: string
}

interface UploadProgress {
  name: string
  step: string
  failed?: boolean
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif'

export default function PortfolioClient({ configured, collections, loadError, canManage, siteUrl }: Props) {
  const router = useRouter()
  const toast = useToast()

  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? '')
  const collection = useMemo(
    () => collections.find((c) => c.id === collectionId) ?? collections[0],
    [collections, collectionId],
  )

  const [brandId, setBrandId] = useState(collection?.brands[0]?.id ?? '')
  const brand: PortfolioBrand | undefined = useMemo(
    () => collection?.brands.find((b) => b.id === brandId) ?? collection?.brands[0],
    [collection, brandId],
  )

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

  const [brandModal, setBrandModal] = useState<{ id?: string; name: string; tagline: string } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)

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

  if (loadError) {
    return (
      <div className="p-6">
        <Notice title="Could not load the portfolio" body={loadError} />
      </div>
    )
  }

  if (!collection) {
    return (
      <div className="p-6">
        <Notice
          title="No collections yet"
          body="Run cirqle-website/supabase/schema.sql in the website project's SQL editor. It creates the tables and the first collection."
        />
      </div>
    )
  }

  // ─── Upload ────────────────────────────────────────────────────────────────
  async function uploadFiles(files: FileList | File[]) {
    if (!brand || !collection) {
      toast.toastError('Pick a brand first', 'Create a brand to upload work into.')
      return
    }
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!list.length) return

    setBusy(true)
    setUploads(list.map((f) => ({ name: f.name, step: 'Waiting' })))

    let done = 0
    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      const mark = (step: string, failed?: boolean) =>
        setUploads((prev) => prev.map((u, n) => (n === i ? { ...u, step, failed } : u)))

      try {
        if (file.size > MAX_SOURCE_BYTES) {
          mark('Too large — export it smaller', true)
          continue
        }

        mark('Resizing')
        const { width, height, renditions } = await resizeForUpload(file)

        mark('Preparing upload')
        const slug = slugFromFilename(file.name)
        const prep = await createWorkUploadUrls({
          collectionSlug: collection.slug,
          brandSlug: brand.slug,
          slug,
          widths: renditions.map((r) => r.width),
        })
        if (!prep.ok || !prep.data) {
          mark(prep.error ?? 'Could not prepare the upload', true)
          continue
        }

        mark(`Uploading ${renditions.length} sizes`)
        const targets = prep.data
        for (const rendition of renditions) {
          const target = targets.find((t) => t.width === rendition.width)
          if (!target) continue
          const put = await fetch(target.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/webp' },
            body: rendition.blob,
          })
          if (!put.ok) throw new Error('Storage rejected the file.')
        }

        mark('Saving')
        const saved = await saveWorkItem({
          brandId: brand.id,
          slug,
          title: titleFromFilename(file.name),
          width,
          height,
          variants: renditions.map((r) => {
            const target = targets.find((t) => t.width === r.width)
            return { width: r.width, height: r.height, path: target?.path ?? '', bytes: r.blob.size }
          }).filter((v) => v.path),
        })
        if (!saved.ok) {
          mark(saved.error ?? 'Could not save', true)
          continue
        }

        mark('Published')
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

  async function commitRename() {
    if (!renaming) return
    const res = await updateWorkItem(renaming.id, { title: renaming.title })
    if (!res.ok) { toast.toastError('Could not rename', res.error); return }
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

  async function submitBrand() {
    if (!brandModal || !collection) return
    const res = await saveBrand({
      id: brandModal.id,
      collectionId: collection.id,
      name: brandModal.name,
      tagline: brandModal.tagline,
    })
    if (!res.ok) { toast.toastError('Could not save the brand', res.error); return }
    if (res.data && !brandModal.id) setBrandId(res.data.id)
    setBrandModal(null)
    toast.success('Brand saved')
    router.refresh()
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
          <a
            href={`${siteUrl}/portfolio/${collection.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="w-3.5 h-3.5" /> View live
          </a>
          {canManage && (
            <Button size="sm" onClick={() => setBrandModal({ name: '', tagline: '' })}>
              <Plus className="w-3.5 h-3.5" /> New brand
            </Button>
          )}
        </div>
      </div>

      {collections.length > 1 && (
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
      {collection.brands.length === 0 ? (
        <Notice
          title="No brands yet"
          body="Create a brand — a client whose work you want to show — then upload their creatives into it."
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {collection.brands.map((b) => {
            const hidden = b.items.filter((i) => !i.published).length
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => { setBrandId(b.id); setOrder(null) }}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-colors ${
                  b.id === brand?.id
                    ? 'bg-foreground text-background border-transparent'
                    : 'border-border bg-secondary text-muted-foreground hover:text-foreground'
                }`}
              >
                {b.name}
                <span className="opacity-60">{b.items.length}</span>
                {hidden > 0 && <span className="opacity-60">· {hidden} hidden</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* ─── Selected brand ─────────────────────────────────────────────── */}
      {brand && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-medium truncate">{brand.name}</h2>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => setBrandModal({ id: brand.id, name: brand.name, tagline: brand.tagline ?? '' })}
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
              <p className="text-sm">Drop images here, or click to choose</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Any size — they are converted to WebP at four widths before uploading. The file name becomes the title.
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
                      onRename={() => setRenaming({ id: item.id, title: item.title })}
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
          <div className="p-5 space-y-4 w-full max-w-sm">
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
            {!brandModal.id && (
              <p className="text-[11px] text-muted-foreground">
                The web address is made from the name and cannot be changed later.
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setBrandModal(null)}>Cancel</Button>
              <Button type="button" className="flex-1" onClick={() => void submitBrand()}>Save</Button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {renaming && (
        <ModalOverlay onClose={() => setRenaming(null)}>
          <div className="p-5 space-y-4 w-full max-w-sm">
            <h3 className="text-sm font-medium">Rename creative</h3>
            <Input
              value={renaming.title}
              onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void commitRename() }}
            />
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
  item, canManage, onToggle, onRename, onDelete,
}: {
  item: PortfolioItem
  canManage: boolean
  onToggle: () => void
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

      <div className="px-2.5 py-2">
        <p className="text-[11px] font-medium truncate" title={item.title}>{item.title}</p>
        <p className="text-[10px] text-muted-foreground">
          {item.width}×{item.height} · {item.variants.length} sizes
          {!item.published && ' · hidden'}
        </p>
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
