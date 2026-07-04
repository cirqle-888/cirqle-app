'use client'

/**
 * Renders the pinned Favorites at the top of the sidebar, drag-to-reorder via
 * @dnd-kit (same DndContext/SortableContext/useSortable/arrayMove pattern as
 * src/app/(dashboard)/dashboard/tasks/tasks-client.tsx).
 */
import { useId } from 'react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import Link from 'next/link'
import { GripVertical, X, type LucideIcon } from 'lucide-react'
import { useFavorites } from '@/contexts/favorites-context'
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
        className={`flex items-center rounded-lg text-sm font-medium transition-all duration-300 ${
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
        <span className={`flex-1 truncate whitespace-nowrap transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'} ${isCollapsed ? '' : 'pr-4'}`}>
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

export function FavoritesSection({
  isCollapsed, activeHref, onNavClick,
}: {
  isCollapsed: boolean; activeHref: string | null; onNavClick?: () => void
}) {
  const { favorites, reorder, toggleFavorite } = useFavorites()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  // SSR-stable id: without it dnd-kit auto-numbers its aria-describedby ids,
  // which don't line up between server and client when the sidebar renders
  // two instances (desktop + mobile) → hydration-mismatch warnings.
  const dndId = useId()

  if (favorites.length === 0) return null

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
        <SortableContext items={favorites.map(f => f.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5">
            {favorites.map(fav => (
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
    </div>
  )
}
