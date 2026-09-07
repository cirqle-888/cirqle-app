'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, Loader2, Trash2, Eye, EyeOff, GripVertical, ImageOff, Pencil } from 'lucide-react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { FlyerRow } from '@/lib/portfolio/types'
import { MAX_SOURCE_BYTES } from '@/lib/portfolio/types'
import { resizeForUpload, slugFromFilename, titleFromFilename } from '@/lib/portfolio/resize'
import { createFlyerUploadUrls, deleteFlyer, reorderFlyers, saveFlyer, updateFlyer } from './actions'

interface Props {
  flyers: FlyerRow[]
  error: string | null
  canManage: boolean
  siteUrl: string
  onToast: (kind: 'success' | 'error', title: string, body?: string) => void
}

interface UploadProgress {
  name: string
  step: string
  failed?: boolean
}

/**
 * Supermarket flyers. The website flips through these like a printed
 * brochure, so the order here is page order.
 */
export default function FlyersPanel({ flyers, error, canManage, siteUrl, onToast }: Props) {
  const router = useRouter()
  const [order, setOrder] = useState<string[] | null>(null)
  const [uploads, setUploads] = useState<UploadProgress[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const pages = useMemo(() => {
    if (!order) return flyers
    const byId = new Map(flyers.map((f) => [f.id, f]))
    const sorted = order.map((id) => byId.get(id)).filter(Boolean) as FlyerRow[]
    return sorted.length === flyers.length ? sorted : flyers
  }, [flyers, order])

  if (error) {
    return (
      <div className="rounded-2xl border border-border bg-secondary/40 px-5 py-6 max-w-2xl">
        <h2 className="text-sm font-medium mb-1">Could not load the flyers</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">{error}</p>
      </div>
    )
  }

  async function uploadFiles(files: FileList | File[]) {
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
        if (file.size > MAX_SOURCE_BYTES) { mark('Too large — export it smaller', true); continue }

        mark('Resizing')
        const { width, height, renditions } = await resizeForUpload(file)

        mark('Preparing upload')
        const prep = await createFlyerUploadUrls({
          slug: slugFromFilename(file.name),
          widths: renditions.map((r) => r.width),
        })
        if (!prep.ok || !prep.data) { mark(prep.error ?? 'Could not prepare the upload', true); continue }

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
        const saved = await saveFlyer({
          title: titleFromFilename(file.name),
          width,
          height,
          variants: renditions
            .map((r) => {
              const target = targets.find((t) => t.width === r.width)
              return { width: r.width, height: r.height, path: target?.path ?? '', bytes: r.blob.size }
            })
            .filter((v) => v.path),
        })
        if (!saved.ok) { mark(saved.error ?? 'Could not save', true); continue }

        mark('Published')
        done++
      } catch (e) {
        // A dropped connection would otherwise leave a spinner forever.
        mark(e instanceof Error ? e.message : 'Upload failed', true)
      }
    }

    setBusy(false)
    if (done) {
      onToast('success', `${done} flyer page${done === 1 ? '' : 's'} published`, 'Live on the website now.')
      setOrder(null)
      router.refresh()
    }
    window.setTimeout(() => setUploads([]), done === list.length ? 2500 : 8000)
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = pages.map((p) => p.id)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    setOrder(next)
    const res = await reorderFlyers(next)
    if (!res.ok) { setOrder(null); onToast('error', 'Could not save the page order', res.error); return }
    router.refresh()
  }

  async function commitRename() {
    if (!renaming) return
    const res = await updateFlyer(renaming.id, { title: renaming.title })
    if (!res.ok) { onToast('error', 'Could not rename', res.error); return }
    setRenaming(null)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Supermarket flyers</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Shown as a flip-through brochure, so the order below is the page order. Drag to rearrange.
          </p>
        </div>
        <a
          href={`${siteUrl}/highlights/supermarket-campaign`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
        >
          View live
        </a>
      </div>

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
          <p className="text-sm">Drop flyer pages here, or click to choose</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Select the whole week in one go — they are added in file-name order and resized for you.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
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

      {pages.length === 0 ? (
        <div className="text-center py-12 text-xs text-muted-foreground">
          <ImageOff className="w-5 h-5 mx-auto mb-2 opacity-50" />
          No flyer pages yet. The website shows a placeholder until you add some.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              {pages.map((flyer, i) => (
                <FlyerCard
                  key={flyer.id}
                  flyer={flyer}
                  page={i + 1}
                  canManage={canManage}
                  onToggle={async () => {
                    const res = await updateFlyer(flyer.id, { published: !flyer.published })
                    if (!res.ok) { onToast('error', 'Could not update', res.error); return }
                    router.refresh()
                  }}
                  onRename={() => setRenaming({ id: flyer.id, title: flyer.title })}
                  onDelete={() =>
                    setConfirm({
                      title: `Delete page ${i + 1}?`,
                      body: 'This removes the page from the website and deletes its image files. It cannot be undone.',
                      run: async () => {
                        const res = await deleteFlyer(flyer.id)
                        if (!res.ok) { onToast('error', 'Could not delete', res.error); return }
                        setOrder(null)
                        onToast('success', 'Page deleted')
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

      {renaming && (
        <ModalOverlay onClose={() => setRenaming(null)}>
          <div className="p-5 space-y-4 w-full max-w-sm">
            <h3 className="text-sm font-medium">Rename flyer page</h3>
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
    </div>
  )
}

function FlyerCard({
  flyer, page, canManage, onToggle, onRename, onDelete,
}: {
  flyer: FlyerRow
  page: number
  canManage: boolean
  onToggle: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: flyer.id,
    disabled: !canManage,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="group relative rounded-xl overflow-hidden border border-border bg-secondary"
    >
      <div className="aspect-[3/4] bg-background/40">
        {flyer.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the website project's storage host is not in next.config images
          <img
            src={flyer.previewUrl}
            alt={flyer.title || `Flyer page ${page}`}
            loading="lazy"
            className={`w-full h-full object-cover ${flyer.published ? '' : 'opacity-40 grayscale'}`}
          />
        ) : (
          <div className="w-full h-full grid place-items-center text-muted-foreground">
            <ImageOff className="w-4 h-4" />
          </div>
        )}
      </div>

      <div className="px-2.5 py-2">
        <p className="text-[11px] font-medium truncate" title={flyer.title}>Page {page}</p>
        <p className="text-[10px] text-muted-foreground truncate">
          {flyer.title || 'Untitled'}{!flyer.published && ' · hidden'}
        </p>
      </div>

      {canManage && (
        <>
          <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <IconBtn label={flyer.published ? 'Hide from the website' : 'Show on the website'} onClick={onToggle}>
              {flyer.published ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            </IconBtn>
            <IconBtn label="Rename" onClick={onRename}><Pencil className="w-3 h-3" /></IconBtn>
            <IconBtn label="Delete" onClick={onDelete}><Trash2 className="w-3 h-3" /></IconBtn>
          </div>
          <button
            type="button"
            className="absolute top-1.5 left-1.5 p-1 rounded-md bg-background/80 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="w-3 h-3" />
          </button>
        </>
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
