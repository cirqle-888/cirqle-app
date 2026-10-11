'use client'

import { useId, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Eye, EyeOff, Pencil, Trash2, GripVertical, Loader2, Film, Smartphone, AlertTriangle } from 'lucide-react'
import {
  DndContext, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, verticalListSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { MOBILE_ASPECT, objectPosition, mobileModeOf, resolveForViewport, type ShowcaseEntry } from '@/lib/portfolio/showcase'
import { deleteShowcase, reorderShowcases, setShowcasePublished } from './showcase-actions'
import PresentationEditor from './presentation-editor'

interface Props {
  showcases: ShowcaseEntry[]
  error: string | null
  canManage: boolean
  siteUrl: string
  onToast: (kind: 'success' | 'error', title: string, body?: string) => void
}

/**
 * Website presentation — the full-screen client showcase at the top of
 * cirqle.work/portfolio. The order here is the order of the client list on the
 * site. The gallery (the Work tab) is a separate thing and is not touched.
 */
export default function PresentationPanel({ showcases, error, canManage, siteUrl, onToast }: Props) {
  const router = useRouter()
  const [order, setOrder] = useState<string[] | null>(null)
  const [editing, setEditing] = useState<ShowcaseEntry | 'new' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // dnd-kit numbers its aria-describedby ids from a global counter, which does
  // not line up between the server render and the client — a hydration
  // mismatch. A stable id from React avoids it, as in the Flyers panel.
  const dndId = useId()

  const entries = useMemo(() => {
    if (!order) return showcases
    const byId = new Map(showcases.map((s) => [s.id, s]))
    const sorted = order.map((id) => byId.get(id)).filter(Boolean) as ShowcaseEntry[]
    // A stale local order (something was added or removed) is discarded rather
    // than half-applied.
    return sorted.length === showcases.length ? sorted : showcases
  }, [showcases, order])

  const liveCount = entries.filter((e) => e.published).length

  if (error) {
    return (
      <div className="rounded-2xl border border-border bg-secondary/40 px-5 py-6 max-w-2xl">
        <h2 className="text-sm font-medium mb-1">Could not load the presentations</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">{error}</p>
      </div>
    )
  }

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = entries.map((s) => s.id)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    setOrder(next)
    const res = await reorderShowcases(next)
    if (!res.ok) {
      setOrder(null)
      onToast('error', 'Could not save the new order', res.error)
      return
    }
    router.refresh()
  }

  async function togglePublished(entry: ShowcaseEntry) {
    setBusyId(entry.id)
    const res = await setShowcasePublished(entry.id, !entry.published)
    setBusyId(null)
    if (!res.ok) { onToast('error', 'Could not change that', res.error); return }
    onToast('success', entry.published ? 'Unpublished' : 'Published', entry.published
      ? `${entry.clientName} is no longer on the website.`
      : `${entry.clientName} is live on the website.`)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground max-w-xl leading-relaxed">
          The full-screen showcase at the top of <span className="text-foreground">cirqle.work/portfolio</span>.
          One visual per client, with a separate crop for phones. Drag to set the order of the client list.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="w-3.5 h-3.5" /> New presentation
          </Button>
        )}
      </div>

      {entries.length > 0 && liveCount === 0 && (
        <div role="status" className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed">
            <span className="font-medium">Nothing is published.</span>{' '}
            Visitors to <a className="underline" href={`${siteUrl}/portfolio`} target="_blank" rel="noopener noreferrer">cirqle.work/portfolio</a>{' '}
            see a link to the gallery instead of the showcase. Publish at least one presentation to turn it on.
          </p>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-secondary/20 px-6 py-12 text-center">
          <p className="text-sm font-medium">No presentations yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto leading-relaxed">
            Add a client with a desktop visual, and optionally a phone version. It stays a draft until you publish it.
          </p>
          {canManage && (
            <Button size="sm" className="mt-4" onClick={() => setEditing('new')}>
              <Plus className="w-3.5 h-3.5" /> New presentation
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            {liveCount} of {entries.length} live on the website
          </p>
          <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={entries.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {entries.map((entry, i) => (
                  <PresentationRow
                    key={entry.id}
                    entry={entry}
                    index={i + 1}
                    canManage={canManage}
                    busy={busyId === entry.id}
                    onEdit={() => setEditing(entry)}
                    onToggle={() => togglePublished(entry)}
                    onDelete={() => setConfirm({
                      title: `Delete “${entry.clientName}”?`,
                      body: 'This removes the presentation and its uploaded files from the website. The gallery is not affected. It cannot be undone.',
                      run: async () => {
                        const res = await deleteShowcase(entry.id)
                        if (!res.ok) { onToast('error', 'Could not delete', res.error); return }
                        onToast('success', 'Deleted', `${entry.clientName} was removed.`)
                        router.refresh()
                      },
                    })}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </>
      )}

      {editing && (
        <PresentationEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(entry, info) => {
            setEditing(null)
            setOrder(null)
            onToast('success', info.created ? 'Presentation created' : 'Changes saved',
              info.published ? `${entry.clientName} is live on the website.` : `${entry.clientName} is saved as a draft.`)
            router.refresh()
          }}
        />
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

// ─── One row ─────────────────────────────────────────────────────────────────

function PresentationRow({
  entry, index, canManage, busy, onEdit, onToggle, onDelete,
}: {
  entry: ShowcaseEntry
  index: number
  canManage: boolean
  busy: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id, disabled: !canManage,
  })
  const desktop = resolveForViewport(entry, 'desktop')
  const phone = resolveForViewport(entry, 'mobile')
  const mode = mobileModeOf(entry)

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 ${
        entry.published ? 'border-border' : 'border-dashed border-border/80'
      }`}
    >
      {canManage && (
        <button
          type="button" {...attributes} {...listeners}
          aria-label={`Reorder ${entry.clientName}. Press space, then use the arrow keys.`}
          className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground touch-none p-1"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      )}
      <span className="shrink-0 w-5 text-center text-[11px] tabular-nums text-muted-foreground">{index}</span>

      <div className="flex items-center gap-2 shrink-0">
        <Thumb media={desktop} aspect={16 / 9} className="w-32" />
        {mode === 'same'
          ? (
            <span
              title="Phones show the desktop picture"
              className="hidden sm:flex items-center justify-center w-9 h-14 rounded-md border border-dashed border-border text-muted-foreground/60"
            >
              <Smartphone className="w-3.5 h-3.5" />
            </span>
          )
          : <Thumb media={phone} aspect={MOBILE_ASPECT} className="hidden sm:block w-9" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{entry.clientName}</p>
          <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${
            entry.published
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'
              : 'bg-secondary text-muted-foreground border-border'
          }`}>
            {entry.published ? 'Live' : 'Draft'}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground truncate">
          {entry.category || 'No category'}
          <span className="opacity-60">
            {' · '}{mode === 'same' ? 'Phone: same picture' : mode === 'crop' ? 'Phone: own crop' : 'Phone: own file'}
          </span>
        </p>
      </div>

      {canManage && (
        <div className="shrink-0 flex items-center gap-0.5">
          <RowBtn label={entry.published ? 'Unpublish' : 'Publish'} onClick={onToggle} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : entry.published ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </RowBtn>
          <RowBtn label="Edit" onClick={onEdit}><Pencil className="w-3.5 h-3.5" /></RowBtn>
          <RowBtn label="Delete" onClick={onDelete} danger><Trash2 className="w-3.5 h-3.5" /></RowBtn>
        </div>
      )}
    </li>
  )
}

function Thumb({
  media, aspect, className = '',
}: {
  media: { type: 'image' | 'video'; url: string; posterUrl: string | null; focalX: number; focalY: number }
  aspect: number
  className?: string
}) {
  const style: React.CSSProperties = { objectFit: 'cover', objectPosition: objectPosition(media.focalX, media.focalY), width: '100%', height: '100%' }
  return (
    <div className={`relative overflow-hidden rounded-md border border-border bg-secondary shrink-0 ${className}`} style={{ aspectRatio: String(aspect) }}>
      {media.type === 'video' && !media.posterUrl ? (
        <video src={media.url} muted playsInline preload="metadata" style={style} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.type === 'video' ? (media.posterUrl as string) : media.url} alt="" loading="lazy" style={style} />
      )}
      {media.type === 'video' && (
        <Film className="absolute right-1 bottom-1 w-3 h-3 text-white drop-shadow" aria-hidden />
      )}
    </div>
  )
}

function RowBtn({
  label, onClick, children, danger = false, disabled = false,
}: {
  label: string; onClick: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className={`p-1.5 rounded-lg transition-colors disabled:opacity-40 ${
        danger
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
      }`}
    >
      {children}
    </button>
  )
}
