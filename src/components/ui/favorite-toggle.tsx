'use client'

/**
 * Drop this on any page/record to make it favoritable — no other code needed
 * for a new module to support Favorites. See src/contexts/favorites-context.tsx.
 */
import { Star } from 'lucide-react'
import { useFavorites } from '@/contexts/favorites-context'
import type { FavoriteInput } from '@/lib/favorites/actions'

interface Props extends FavoriteInput {
  className?: string
  size?: number
}

export function FavoriteToggle({ className = '', size = 16, ...input }: Props) {
  const { isFavorited, toggleFavorite } = useFavorites()
  const active = isFavorited(input.entityType, input.entityId ?? null)

  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(input) }}
      title={active ? 'Remove from Favorites' : 'Add to Favorites'}
      className={`shrink-0 rounded-md p-1 transition-colors ${active ? 'text-amber-400 hover:text-amber-500' : 'text-muted-foreground/50 hover:text-amber-400'} ${className}`}
    >
      <Star className="transition-transform" style={{ width: size, height: size }} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}
