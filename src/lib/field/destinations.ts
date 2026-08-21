'use client'

/**
 * Saved return-route destinations (§11) — Home / Office / Warehouse / custom.
 * Stored per-browser in localStorage (no schema change); a server-backed
 * `field_saved_destinations` table is an optional later upgrade. Each carries a
 * lat/lng so "On The Way" can route to it.
 */
import { useCallback, useEffect, useState } from 'react'

export type DestinationKind = 'home' | 'office' | 'warehouse' | 'custom'
export interface SavedDestination {
  id: string
  label: string
  kind: DestinationKind
  latitude: number
  longitude: number
}

const KEY = 'field.savedDestinations.v1'

function read(): SavedDestination[] {
  if (typeof localStorage === 'undefined') return []
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function write(list: SavedDestination[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* quota/private mode — ignore */ }
}

export function useSavedDestinations() {
  const [list, setList] = useState<SavedDestination[]>([])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setList(read()) }, [])

  const add = useCallback((d: Omit<SavedDestination, 'id'>) => {
    setList(prev => {
      const next = [...prev, { ...d, id: `dest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }]
      write(next); return next
    })
  }, [])
  const remove = useCallback((id: string) => {
    setList(prev => { const next = prev.filter(d => d.id !== id); write(next); return next })
  }, [])

  return { list, add, remove }
}
