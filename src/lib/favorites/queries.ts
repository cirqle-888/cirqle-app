/**
 * Favorites read queries — server-side only.
 */
import { createAdminClient } from '@/lib/supabase/server'

export interface FavoriteEntry {
  id: string
  entityType: string
  entityId: string | null
  href: string
  label: string
  iconKey: string
  position: number
}

interface RawFavoriteRow {
  id: string
  entity_type: string
  entity_id: string | null
  href: string
  label: string
  icon_key: string
  position: number
}

function mapRow(r: RawFavoriteRow): FavoriteEntry {
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    href: r.href,
    label: r.label,
    iconKey: r.icon_key,
    position: r.position,
  }
}

export async function listFavoritesForEmployee(employeeId: string): Promise<FavoriteEntry[]> {
  if (!employeeId) return []
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('employee_favorites')
    .select('id, entity_type, entity_id, href, label, icon_key, position')
    .eq('employee_id', employeeId)
    .order('position')
  return ((data ?? []) as RawFavoriteRow[]).map(mapRow)
}
