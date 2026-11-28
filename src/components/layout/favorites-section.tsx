'use client'

/**
 * Renders the pinned Favorites at the top of the sidebar, drag-to-reorder via
 * @dnd-kit (same DndContext/SortableContext/useSortable/arrayMove pattern as
 * src/app/(dashboard)/dashboard/tasks/tasks-client.tsx).
 */
import { useEffect, useId, useState } from 'react'
import {
  DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import Link from 'next/link'
import { ChevronDown, ChevronUp, GripVertical, X, type LucideIcon } from 'lucide-react'
import { useFavorites } from '@/contexts/favorites-context'
import { usePermissions } from '@/contexts/permission-context'
import { canOpenHref } from '@/lib/nav-sections'
import { SAVED_VIEW_ENTITY_TYPE } from '@/lib/saved-views/model'
import { resolveFavoriteIcon } from '@/lib/favorites/icon-map'
import type { FavoriteEntry } from '@/lib/favorites/queries'

function SortableFavoriteRow({
  fav, icon: Icon, isCollapsed, active, onNavClick, onUnpin,
}: {
  fav: FavoriteEntry; icon: LucideIcon; isCollapsed: boolean; active: boolean; onNavClick?: () => void; onUnpin: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: fav.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="relative group"
    >
      <Link
        href={fav.href}
        onClick={onNavClick}
        title={isCollapsed ? fav.label : undefined}
        className={`flex items-center rounded-lg text-sm font-medium transition-[color,background-color,padding,gap] duration-200 ease-out-strong ${
          isCollapsed ? 'justify-center p-2.5' : 'gap-2 pl-1.5 pr-3 py-2.5'
        } ${
          active
            ? 'bg-primary/15 text-primary'
            : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        }`}
      >
        {!isCollapsed && (
          <span
            {...attributes}
            {...listeners}
            onClick={e => e.stopPropagation()}
            className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity touch-none p-1"
            title="Drag to reorder"
          >
            <GripVertical className="w-3 h-3" />
          </span>
        )}
        <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className={`flex-1 truncate whitespace-nowrap transition-[width,opacity,padding] duration-200 ease-out-strong ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'} ${isCollapsed ? '' : 'pr-4'}`}>
          {fav.label}
        </span>
      </Link>
      {!isCollapsed && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onUnpin() }}
          title="Remove from Favorites"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

/**
 * How many pins show before "Show N more". A long list (fifteen pins) filled
 * the whole sidebar and pushed the menu below the fold, mostly as a second
 * copy of its rows. Order is the person's own (drag to reorder), so the ones
 * they use most stay on top; the choice to show all is remembered.
 */
const FAVORITES_SHOWN = 6
const SHOW_ALL_KEY = 'sidebar-favorites-all'

export function FavoritesSection({
  isCollapsed, activeHref, onNavClick,
}: {
  isCollapsed: boolean; activeHref: string | null; onNavClick?: () => void
}) {
  const { favorites, reorder, toggleFavorite } = useFavorites()
  const { can, user } = usePermissions()
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
  // SSR-stable id: without it dnd-kit auto-numbers its aria-describedby ids,
  // which don't line up between server and client when the sidebar renders
  // two instances (desktop + mobile) → hydration-mismatch warnings.
  const dndId = useId()
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    try { setShowAll(localStorage.getItem(SHOW_ALL_KEY) === '1') } catch { /* private mode */ }
  }, [])
  const toggleShowAll = () => setShowAll(prev => {
    try { localStorage.setItem(SHOW_ALL_KEY, prev ? '0' : '1') } catch { /* private mode */ }
    return !prev
  })

  // A favourite must never outrank a permission. Pins are stored rows: they
  // survive a designation change, so a page someone could open last month can
  // still be pinned after the key is revoked. The nav sections are gated but
  // this list was not, which meant a stale pin rendered a link the router then
  // refused — looking like a permission leak.
  //
  // Gated with `canOpenHref` — the same rule the dashboard layout's
  // denied-route guard applies — so a rendered pin can never lead somewhere
  // the router then bounces. An exact-href lookup was not enough: it missed
  // every pin carrying a query string (a record deep-link, and now a saved
  // view), because `/dashboard/invoices?status=overdue` is not a nav href.
  // `canOpenHref` strips the query and resolves the most specific nav item,
  // so those are gated too. A pin to something outside navSections has no
  // permission to check and is left alone.
  //
  // Saved views are favourites rows as well, but they belong to the screen
  // whose filters they restore and render as chips there — not in this list.
  const visibleFavorites = favorites.filter(fav =>
    fav.entityType !== SAVED_VIEW_ENTITY_TYPE && canOpenHref(fav.href, can, user.isAdmin, (user.unitRoutesOnly ?? false)),
  )

  if (visibleFavorites.length === 0) return null

  // One over the limit shows in full — a "1 more" button is as long as the row.
  // The page you are on always shows, wherever it sits in the list.
  const foldable = visibleFavorites.length > FAVORITES_SHOWN + 1
  const shownFavorites = !foldable || showAll
    ? visibleFavorites
    : visibleFavorites.filter((f, i) => i < FAVORITES_SHOWN || f.href === activeHref)
  const hiddenCount = visibleFavorites.length - shownFavorites.length

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = favorites.map(f => f.id)
    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    reorder(arrayMove(ids, oldIndex, newIndex))
  }

  return (
    <div className="mb-4">
      {!isCollapsed && (
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 px-3 mb-1.5 whitespace-nowrap">
          Favorites
        </p>
      )}
      <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={shownFavorites.map(f => f.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5">
            {shownFavorites.map(fav => (
              <SortableFavoriteRow
                key={fav.id}
                fav={fav}
                icon={resolveFavoriteIcon(fav.iconKey)}
                isCollapsed={isCollapsed}
                active={fav.href === activeHref}
                onNavClick={onNavClick}
                // toggleFavorite matches by entityType+entityId, so passing the
                // row's own identity removes it — including legacy rows saved
                // with a null entityId before the per-page id fix.
                onUnpin={() => toggleFavorite({
                  entityType: fav.entityType,
                  entityId: fav.entityId,
                  href: fav.href,
                  label: fav.label,
                  iconKey: fav.iconKey,
                })}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {foldable && (
        <button
          type="button"
          onClick={toggleShowAll}
          aria-expanded={showAll}
          title={isCollapsed ? (showAll ? 'Show fewer favorites' : `Show ${hiddenCount} more favorites`) : undefined}
          className={`mt-0.5 flex w-full items-center rounded-lg text-xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors ${isCollapsed ? 'justify-center p-2' : 'gap-2 px-3 py-1.5'}`}
        >
          {showAll ? <ChevronUp className="w-3.5 h-3.5 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0" />}
          {!isCollapsed && <span>{showAll ? 'Show fewer' : `Show ${hiddenCount} more`}</span>}
        </button>
      )}
    </div>
  )
}
