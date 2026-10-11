'use client'

/**
 * Generic Favorites context — pins whole nav pages ('nav_page') or specific
 * records (business_partner, campaign, employee, ...) for quick access.
 *
 * The DB (employee_favorites, via the server-loaded `initialFavorites` prop)
 * is the source of truth — the dashboard layout is a Server Component so the
 * first paint already has real data, no client fetch/flicker. localStorage
 * is written on every change purely as a cache (e.g. for a future
 * non-SSR surface), never read back as the primary source.
 */
import { createContext, useContext, useState, useMemo, useEffect, useCallback, type ReactNode } from 'react'
import { addFavorite, removeFavorite, reorderFavorites, type FavoriteInput } from '@/lib/favorites/actions'
import type { FavoriteEntry } from '@/lib/favorites/queries'

const STORAGE_KEY = 'cirqle-favorites-cache'

interface FavoritesContextValue {
  favorites: FavoriteEntry[]
  isFavorited: (entityType: string, entityId?: string | null) => boolean
  toggleFavorite: (input: FavoriteInput) => Promise<void>
  /**
   * Save-or-overwrite, for entries that are edited rather than toggled.
   *
   * Saved views need this: re-saving "Unpaid this month" after changing a
   * filter must update the stored href, where `toggleFavorite` would delete
   * the view instead. The server action already upserts on
   * (employee_id, entity_type, entity_id), so this is the same round trip.
   *
   * Resolves `true` when the write succeeded.
   */
  upsertFavorite: (input: FavoriteInput) => Promise<boolean>
  /** Unconditional delete, where `toggleFavorite` would re-create a missing entry. */
  removeFavoriteEntry: (entityType: string, entityId?: string | null) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
}

const Ctx = createContext<FavoritesContextValue | null>(null)

export function FavoritesProvider({ initialFavorites, children }: { initialFavorites: FavoriteEntry[]; children: ReactNode }) {
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(initialFavorites)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites)) } catch { /* best effort cache — DB stays source of truth */ }
  }, [favorites])

  const isFavorited = useCallback((entityType: string, entityId?: string | null) => {
    return favorites.some(f => f.entityType === entityType && (f.entityId ?? '') === (entityId ?? ''))
  }, [favorites])

  const toggleFavorite = useCallback(async (input: FavoriteInput) => {
    const already = favorites.find(f => f.entityType === input.entityType && (f.entityId ?? '') === (input.entityId ?? ''))
    if (already) {
      setFavorites(prev => prev.filter(f => f.id !== already.id))
      await removeFavorite(input.entityType, input.entityId ?? null)
      return
    }
    const tempId = `temp-${Date.now()}`
    const optimistic: FavoriteEntry = {
      id: tempId, entityType: input.entityType, entityId: input.entityId ?? null,
      href: input.href, label: input.label, iconKey: input.iconKey, position: favorites.length,
    }
    setFavorites(prev => [...prev, optimistic])
    const res = await addFavorite(input)
    if (res.ok && res.data) {
      setFavorites(prev => prev.map(f => (f.id === tempId ? { ...f, id: res.data!.id } : f)))
    } else {
      setFavorites(prev => prev.filter(f => f.id !== tempId)) // rollback on failure
    }
  }, [favorites])

  const upsertFavorite = useCallback(async (input: FavoriteInput) => {
    const existing = favorites.find(
      f => f.entityType === input.entityType && (f.entityId ?? '') === (input.entityId ?? ''),
    )
    const optimistic: FavoriteEntry = {
      id: existing?.id ?? `temp-${Date.now()}`,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      href: input.href,
      label: input.label,
      iconKey: input.iconKey,
      position: existing?.position ?? favorites.length,
    }
    setFavorites(prev => (existing
      ? prev.map(f => (f.id === existing.id ? optimistic : f))
      : [...prev, optimistic]))

    const res = await addFavorite(input)
    if (res.ok && res.data) {
      setFavorites(prev => prev.map(f => (f.id === optimistic.id ? { ...f, id: res.data!.id } : f)))
      return true
    }
    // Roll back to exactly what was there before — restoring the old entry
    // rather than dropping it, so a failed re-save does not look like a delete.
    setFavorites(prev => (existing
      ? prev.map(f => (f.id === optimistic.id ? existing : f))
      : prev.filter(f => f.id !== optimistic.id)))
    return false
  }, [favorites])

  const removeFavoriteEntry = useCallback(async (entityType: string, entityId?: string | null) => {
    const existing = favorites.find(
      f => f.entityType === entityType && (f.entityId ?? '') === (entityId ?? ''),
    )
    if (!existing) return
    setFavorites(prev => prev.filter(f => f.id !== existing.id))
    const res = await removeFavorite(entityType, entityId ?? null)
    if (!res.ok) setFavorites(prev => [...prev, existing]) // rollback
  }, [favorites])

  const reorder = useCallback(async (orderedIds: string[]) => {
    setFavorites(prev => {
      const byId = new Map(prev.map(f => [f.id, f]))
      return orderedIds.map(id => byId.get(id)).filter((f): f is FavoriteEntry => !!f)
    })
    await reorderFavorites(orderedIds)
  }, [])

  const value = useMemo<FavoritesContextValue>(
    () => ({ favorites, isFavorited, toggleFavorite, upsertFavorite, removeFavoriteEntry, reorder }),
    [favorites, isFavorited, toggleFavorite, upsertFavorite, removeFavoriteEntry, reorder],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useFavorites(): FavoritesContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useFavorites must be used inside <FavoritesProvider>')
  return ctx
}
