'use client'

/**
 * Arrange grid — design the profile layout, then get the shortest way to make
 * it real.
 *
 * Instagram's Grid Reorder and pinning are app-only; Meta's media endpoint
 * takes one writable field and it is comment_enabled. So this never touches
 * Instagram. It works out the fewest moves from what we believe is live to
 * what you arranged, and hands them over as a numbered list to follow on a
 * phone.
 *
 * ONLY PUBLISHED POSTS GET INSTRUCTIONS. A planned tile does not exist on
 * Instagram, so it cannot be dragged there and cannot be pinned. Planned tiles
 * still sit in the layout so you can see how the grid will look once they go
 * out — they are just skipped when the moves are computed.
 */

import { useCallback, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Pin, PinOff, Check, Loader2, Info, RotateCcw, ArrowRight, Play,
} from 'lucide-react'
import type { FeedTile } from '@/lib/social/feed-grid'
import {
  minimalMoves, pinChanges, effectiveTarget, gridPosition, MAX_PINNED,
} from '@/lib/social/feed-reorder'
import { saveGridTarget, markGridApplied, resetGridTarget } from './actions'

interface Props {
  accountId: string
  tiles: FeedTile[]
  initialTarget: string[]
  initialPinned: string[]
  liveSnapshot: string[]
  livePinned: string[]
  appliedAt: string | null
  tileAspect: string
  canPlan: boolean
  onToast: (title: string, body?: string) => void
  onError: (title: string, body?: string) => void
}

export default function GridArranger({
  accountId, tiles, initialTarget, initialPinned, liveSnapshot, livePinned,
  appliedAt, tileAspect, canPlan, onToast, onError,
}: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)

  const byKey = useMemo(() => new Map(tiles.map(t => [t.key, t])), [tiles])

  // Start from the saved layout, dropping anything that has since disappeared
  // and appending anything new, so a fresh upload or a deleted post never
  // leaves a hole or an orphan.
  const [order, setOrder] = useState<string[]>(() => {
    const known = initialTarget.filter(k => byKey.has(k))
    const rest = tiles.map(t => t.key).filter(k => !known.includes(k))
    return [...known, ...rest]
  })
  const [pinned, setPinned] = useState<string[]>(
    () => initialPinned.filter(k => byKey.get(k)?.kind === 'published').slice(0, MAX_PINNED),
  )
  const [dirty, setDirty] = useState(false)

  // Pinned posts are locked to the top by Instagram, so the layout on screen
  // has to show that or it is describing a grid that cannot exist.
  const shown = useMemo(() => effectiveTarget(order, pinned), [order, pinned])

  // ── What it would take to make this real ────────────────────────────────
  // useCallback so the memos below can depend on it honestly; as a plain
  // arrow it was rebuilt every render and the dependency arrays were lying.
  const isPublished = useCallback(
    (k: string) => byKey.get(k)?.kind === 'published',
    [byKey],
  )

  const believedLive = useMemo(() => {
    const saved = liveSnapshot.filter(k => byKey.has(k) && isPublished(k))
    if (saved.length) {
      // Anything published since the snapshot goes on top, as Instagram does.
      const fresh = tiles.filter(t => t.kind === 'published' && !saved.includes(t.key)).map(t => t.key)
      return [...fresh, ...saved]
    }
    return tiles.filter(t => t.kind === 'published').map(t => t.key)
  }, [liveSnapshot, tiles, byKey, isPublished])

  const moves = useMemo(
    () => minimalMoves(believedLive, shown.filter(isPublished)),
    [believedLive, shown, isPublished],
  )
  const pins = useMemo(
    () => pinChanges(livePinned.filter(isPublished), pinned),
    [livePinned, pinned, isPublished],
  )
  const totalSteps = moves.length + pins.pin.length + pins.unpin.length

  // ── Drag ────────────────────────────────────────────────────────────────
  function handleDrop(targetKey: string) {
    const from = dragKey
    setDragKey(null); setOverKey(null)
    if (!from || from === targetKey) return
    setOrder(prev => {
      const next = prev.filter(k => k !== from)
      const at = next.indexOf(targetKey)
      next.splice(at === -1 ? next.length : at, 0, from)
      return next
    })
    setDirty(true)
  }

  function togglePin(key: string) {
    if (!isPublished(key)) {
      onError('Not live yet', 'Only a published post can be pinned on Instagram.')
      return
    }
    setPinned(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key)
      if (prev.length >= MAX_PINNED) {
        onError(`Instagram allows ${MAX_PINNED} pins`, 'Unpin one first.')
        return prev
      }
      return [...prev, key]
    })
    setDirty(true)
  }

  const save = () => start(async () => {
    const res = await saveGridTarget({ accountId, targetOrder: shown, pinnedKeys: pinned })
    if (!res.ok) { onError('Could not save the layout', res.error); return }
    setDirty(false)
    onToast('Layout saved', 'Follow the steps below on your phone.')
    router.refresh()
  })

  const applied = () => start(async () => {
    const res = await markGridApplied(accountId)
    if (!res.ok) { onError('Could not record that', res.error); return }
    onToast('Recorded as applied', 'This layout is now what Cirqle treats as live.')
    router.refresh()
  })

  const reset = () => start(async () => {
    const res = await resetGridTarget(accountId)
    if (!res.ok) { onError('Could not reset', res.error); return }
    onToast('Layout cleared')
    router.refresh()
  })

  return (
    <div className="space-y-3">
      {/* What this is, stated once and plainly. */}
      <div className="rounded-xl border border-border bg-secondary/30 p-3 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="text-xs text-muted-foreground leading-relaxed">
          <span className="text-foreground font-medium">Instagram has no API for reordering or pinning</span>
          {' '}— both are done in the app by hand. Arrange the grid here and Cirqle works out
          the fewest moves to get there. Cirqle also cannot read your live order, so it goes by
          what was last recorded as applied.
        </div>
      </div>

      {/* ── The grid ── */}
      <div className="rounded-xl border border-border bg-card p-2">
        <div className="grid grid-cols-3 gap-1">
          {shown.map(key => {
            const t = byKey.get(key)
            if (!t) return null
            const isPinned = pinned.includes(key)
            const live = t.kind === 'published'
            return (
              <div
                key={key}
                draggable={canPlan}
                onDragStart={() => setDragKey(key)}
                onDragEnd={() => { setDragKey(null); setOverKey(null) }}
                onDragOver={e => { if (dragKey) { e.preventDefault(); setOverKey(key) } }}
                onDrop={e => { if (dragKey) { e.preventDefault(); handleDrop(key) } }}
                className={`relative ${tileAspect} group overflow-hidden bg-secondary transition-all ${
                  dragKey === key ? 'opacity-30' : ''
                } ${overKey === key && dragKey && dragKey !== key ? 'ring-2 ring-primary ring-inset' : ''} ${
                  canPlan ? 'cursor-grab active:cursor-grabbing' : ''
                }`}
              >
                {t.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.imageUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground px-2 text-center">
                    No image
                  </div>
                )}

                {!live && <div className="absolute inset-0 ring-1 ring-inset ring-violet-500/40 pointer-events-none" />}
                {t.isVideo && <Play className="absolute bottom-1.5 right-1.5 w-3.5 h-3.5 text-white drop-shadow" />}

                {isPinned && (
                  <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-amber-500 text-amber-950 font-semibold leading-none flex items-center gap-0.5">
                    <Pin className="w-2.5 h-2.5" /> Pinned
                  </span>
                )}
                {!live && !isPinned && (
                  <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-violet-500/90 text-white leading-none">
                    Not live
                  </span>
                )}

                {canPlan && live && (
                  <button
                    onClick={() => togglePin(key)}
                    title={isPinned ? 'Unpin' : 'Pin to top'}
                    className="absolute bottom-1 left-1 p-1 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    {isPinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Actions ── */}
      {canPlan && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={save} disabled={pending || !dirty} className="flex-1 min-w-[8rem]">
            {pending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
            {dirty ? 'Save layout' : 'Saved'}
          </Button>
          <Button
            type="button" variant="outline" onClick={applied}
            disabled={pending || totalSteps === 0 || dirty}
            className="flex-1 min-w-[10rem]"
          >
            <Check className="w-4 h-4 mr-1.5" />
            I applied this on Instagram
          </Button>
          <Button type="button" variant="outline" onClick={reset} disabled={pending} className="min-w-[6rem]">
            <RotateCcw className="w-4 h-4 mr-1.5" />
            Reset
          </Button>
        </div>
      )}

      {/* ── The checklist ── */}
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold">
            {totalSteps === 0 ? 'Nothing to do' : `${totalSteps} step${totalSteps === 1 ? '' : 's'} on your phone`}
          </h3>
          {appliedAt && (
            <span className="text-[11px] text-muted-foreground">
              Last applied {new Date(appliedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {totalSteps === 0 ? (
          <p className="text-xs text-muted-foreground">
            Your Instagram grid already matches this layout, as far as Cirqle knows.
          </p>
        ) : (
          <ol className="space-y-1.5">
            {pins.unpin.map((key, i) => (
              <Step key={`unpin-${key}`} n={i + 1} tile={byKey.get(key)}>
                <span className="text-foreground font-medium">Unpin</span> this post
              </Step>
            ))}
            {pins.pin.map((key, i) => (
              <Step key={`pin-${key}`} n={pins.unpin.length + i + 1} tile={byKey.get(key)}>
                <span className="text-foreground font-medium">Pin</span> this post to your profile
              </Step>
            ))}
            {moves.map((m, i) => {
              const { row, col } = gridPosition(m.toIndex)
              return (
                <Step key={`move-${m.key}`} n={pins.unpin.length + pins.pin.length + i + 1} tile={byKey.get(m.key)}>
                  Hold, choose <span className="text-foreground font-medium">Reorder grid</span>, drag to{' '}
                  <span className="text-foreground font-medium">row {row}, position {col}</span>
                  {m.afterKey && <span className="text-muted-foreground"> (just after the one below)</span>}
                </Step>
              )
            })}
          </ol>
        )}

        {dirty && totalSteps > 0 && (
          <p className="mt-2 text-[11px] text-amber-500">
            Save the layout to keep these steps.
          </p>
        )}
      </div>
    </div>
  )
}

function Step({ n, tile, children }: { n: number; tile?: FeedTile; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-xs">
      <span className="w-5 h-5 rounded-full bg-secondary text-muted-foreground grid place-items-center text-[10px] font-medium shrink-0">
        {n}
      </span>
      {tile?.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={tile.imageUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
      ) : (
        <span className="w-8 h-8 rounded bg-secondary shrink-0" />
      )}
      <span className="text-muted-foreground leading-snug min-w-0">{children}</span>
      <ArrowRight className="w-3 h-3 text-muted-foreground/40 shrink-0 ml-auto" />
    </li>
  )
}
