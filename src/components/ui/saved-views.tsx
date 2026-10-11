'use client'

/**
 * Named saved views for a list screen.
 *
 * Mount it under a list toolbar and it needs nothing else: every Cirqle list
 * screen already keeps its filter/sort/column state in the URL, so this reads
 * `usePathname()` + `useSearchParams()`, stores the pair under a name, and
 * restores it with `router.push`. No per-screen wiring, no new state.
 *
 * Storage and the identity rules live in `@/lib/saved-views/model`; this file
 * is only the control. It renders nothing at all when the screen has no views
 * and no filters worth saving, so it is safe to mount unconditionally.
 *
 * ACCESS: views are stored links and outlive the permission that made them, so
 * every chip is gated with `canOpenHref` — the same rule the dashboard
 * layout's denied-route guard applies. A view saved before a key was revoked
 * stops appearing rather than rendering a link the router then refuses.
 *
 * SHARING: a view is a URL, so sharing it is copying the link. Nothing about
 * the saved view carries the sharer's access with it — the recipient's own
 * route gate decides whether it opens.
 *
 * Visual vocabulary matches `list-toolbar.tsx`: 30px row-2 height, quiet
 * violet tint for the active state.
 */
import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { Bookmark, BookmarkPlus, Check, Link2, X, Undo2 } from 'lucide-react'
import { useFavorites } from '@/contexts/favorites-context'
import { usePermissions } from '@/contexts/permission-context'
import { canOpenHref } from '@/lib/nav-sections'
import {
  SAVED_VIEW_ENTITY_TYPE, SAVED_VIEW_ICON_KEY, MAX_SAVED_VIEW_NAME,
  listSavedViews, activeSavedView, savedViewSlug, buildSavedViewHref,
  hasSavableFilters, normalizeViewName, type SavedView,
} from '@/lib/saved-views/model'

const ON = 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30'
const OFF = 'bg-secondary text-muted-foreground border-foreground/15 hover:text-foreground'

export function SavedViews({ className = '' }: { className?: string }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { favorites, upsertFavorite, removeFavoriteEntry } = useFavorites()
  const { can, user } = usePermissions()

  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const search = searchParams.toString()
  const here = `${pathname}?${search}`

  /**
   * Feedback that belongs to one particular screen state: the error from the
   * last save, the "Copied" flash, and the view just deleted so Undo can put
   * it back.
   *
   * Stamped with the URL it was raised against and discarded during render
   * once that changes, rather than cleared from an effect — a stale Undo would
   * otherwise restore a view into a screen the user has since re-filtered.
   */
  const [feedback, setFeedback] = useState<{
    at: string; error: string | null; copied: boolean; undoable: SavedView | null
  }>({ at: here, error: null, copied: false, undoable: null })
  const { error, copied, undoable } = feedback.at === here
    ? feedback
    : { error: null, copied: false, undoable: null }
  const setError = useCallback((v: string | null) =>
    setFeedback({ at: here, error: v, copied: false, undoable: null }), [here])
  const setCopied = useCallback((v: boolean) =>
    setFeedback({ at: here, error: null, copied: v, undoable: null }), [here])
  const setUndoable = useCallback((v: SavedView | null) =>
    setFeedback({ at: here, error: null, copied: false, undoable: v }), [here])

  const views = useMemo(
    // Gated here rather than when saving: permissions change after the fact,
    // which is the whole reason a stored link needs checking on every render.
    () => listSavedViews(favorites, pathname).filter(v => canOpenHref(v.href, can, user.isAdmin)),
    [favorites, pathname, can, user.isAdmin],
  )
  const active = useMemo(() => activeSavedView(views, search), [views, search])
  const savable = hasSavableFilters(search)

  useEffect(() => { if (naming) inputRef.current?.focus() }, [naming])

  /**
   * Restore a view.
   *
   * This is a full document navigation, not `router.push`, and deliberately
   * so. The list clients read their filters from `searchParams` once, in
   * `useState` initialisers, then push state changes back out with
   * `router.replace`. A soft push to the same route does not remount them, so
   * their unchanged state would win the race and immediately rewrite the URL
   * back — the view would appear not to restore at all. Reloading the screen
   * re-runs those initialisers, which is what makes the stored link the
   * single source of truth. Restoring a view is a deliberate, occasional
   * action on a list screen with no unsaved input, so the cost is a reload
   * the user asked for rather than a rewrite of five filter implementations.
   */
  const applyView = useCallback((view: SavedView) => {
    window.location.assign(view.href)
  }, [])

  const closeNaming = useCallback(() => { setNaming(false); setDraftName(''); setError(null) }, [setError])

  async function save() {
    const name = normalizeViewName(draftName)
    if (!name) { setError('Give the view a name.'); return }
    const slug = savedViewSlug(pathname, name)
    const ok = await upsertFavorite({
      entityType: SAVED_VIEW_ENTITY_TYPE,
      entityId: slug,
      href: buildSavedViewHref(pathname, search),
      label: name,
      iconKey: SAVED_VIEW_ICON_KEY,
    })
    if (!ok) { setError('Could not save. Try again.'); return }
    closeNaming()
  }

  async function remove(view: SavedView) {
    setUndoable(view)
    await removeFavoriteEntry(SAVED_VIEW_ENTITY_TYPE, view.slug)
  }

  async function undo() {
    if (!undoable) return
    const view = undoable
    setUndoable(null)
    await upsertFavorite({
      entityType: SAVED_VIEW_ENTITY_TYPE,
      entityId: view.slug,
      href: view.href,
      label: view.name,
      iconKey: SAVED_VIEW_ICON_KEY,
    })
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${active ? active.href : buildSavedViewHref(pathname, search)}`,
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Copying is blocked in this browser — use the address bar.')
    }
  }

  // Nothing to show and nothing to offer: stay out of the way entirely.
  if (views.length === 0 && !savable && !undoable) return null

  /** Overwriting an existing name rather than creating a new view. */
  const willOverwrite = naming
    && !!normalizeViewName(draftName)
    && views.some(v => v.slug === savedViewSlug(pathname, normalizeViewName(draftName)))

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`}>
      {views.length > 0 && (
        <Bookmark className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" aria-hidden />
      )}

      {views.map(view => {
        const isActive = active?.slug === view.slug
        return (
          <span
            key={view.slug}
            className={`inline-flex items-center h-[30px] pl-2.5 pr-1 rounded-full border text-[11px] font-medium transition-colors ${isActive ? ON : OFF}`}
          >
            <button
              type="button"
              onClick={() => applyView(view)}
              aria-current={isActive ? 'true' : undefined}
              title={isActive ? `${view.name} (showing)` : `Show ${view.name}`}
              className="max-w-[170px] truncate cursor-pointer"
            >
              {view.name}
            </button>
            <button
              type="button"
              onClick={() => remove(view)}
              aria-label={`Delete saved view ${view.name}`}
              title="Delete this view"
              className="ml-1 p-1 rounded-full hover:bg-foreground/10 hover:text-destructive transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        )
      })}

      {naming ? (
        <span className="inline-flex items-center h-[30px] gap-1 pl-2 pr-1 rounded-full border border-violet-500/30 bg-violet-500/10">
          <input
            ref={inputRef}
            value={draftName}
            maxLength={MAX_SAVED_VIEW_NAME}
            onChange={e => { setDraftName(e.target.value); setError(null) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); void save() }
              if (e.key === 'Escape') { e.preventDefault(); closeNaming() }
            }}
            placeholder="Name this view"
            aria-label="Name this view"
            className="w-36 bg-transparent text-[11px] font-medium outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={() => void save()}
            title={willOverwrite ? 'Update this view' : 'Save this view'}
            className="p-1 rounded-full text-violet-700 dark:text-violet-300 hover:bg-violet-500/25 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={closeNaming}
            aria-label="Cancel"
            className="p-1 rounded-full text-muted-foreground hover:bg-foreground/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      ) : savable && (
        <button
          type="button"
          onClick={() => { setNaming(true); setDraftName(active?.name ?? '') }}
          title={active ? `Update "${active.name}" or save under a new name` : 'Save these filters as a named view'}
          className={`inline-flex items-center h-[30px] gap-1 px-2.5 rounded-full border text-[11px] font-medium transition-colors cursor-pointer ${OFF}`}
        >
          <BookmarkPlus className="w-3.5 h-3.5 shrink-0" />
          {active ? 'Save as…' : 'Save view'}
        </button>
      )}

      {savable && !naming && (
        <button
          type="button"
          onClick={() => void copyLink()}
          title="Copy a link to these filters"
          className={`inline-flex items-center h-[30px] gap-1 px-2.5 rounded-full border text-[11px] font-medium transition-colors cursor-pointer ${OFF}`}
        >
          {copied ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Link2 className="w-3.5 h-3.5 shrink-0" />}
          {copied ? 'Copied' : 'Copy link'}
        </button>
      )}

      {undoable && (
        <button
          type="button"
          onClick={() => void undo()}
          className="inline-flex items-center h-[30px] gap-1 px-2.5 rounded-full text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <Undo2 className="w-3.5 h-3.5 shrink-0" />
          Undo “{undoable.name}”
        </button>
      )}

      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  )
}
