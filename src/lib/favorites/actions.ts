'use server'

/**
 * Favorites server actions — generic across every entity_type. A new module
 * adopts favoriting with zero new server code: just call addFavorite/
 * removeFavorite with its own entityType/entityId/href/label/iconKey.
 *
 * The caller's employee id is always resolved server-side from the session
 * (resolveCurrentEmployeeId) — never trusted from client input — so a user
 * can only ever read/write their own favorites despite the table's simple
 * "authenticated ALL" RLS policy.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { listFavoritesForEmployee, type FavoriteEntry } from './queries'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

export interface FavoriteInput {
  entityType: string
  entityId?: string | null
  href: string
  label: string
  iconKey: string
}

export async function listFavorites(): Promise<ActionResult<FavoriteEntry[]>> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: true, data: [] }
  const data = await listFavoritesForEmployee(employeeId)
  return { ok: true, data }
}

export async function addFavorite(input: FavoriteInput): Promise<ActionResult<{ id: string }>> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }

  const admin = createAdminClient()
  const { data: last } = await admin
    .from('employee_favorites')
    .select('position')
    .eq('employee_id', employeeId)
    .order('position', { ascending: false })
    .limit(1)
  const position = ((last?.[0]?.position as number | undefined) ?? -1) + 1

  const { data, error } = await admin
    .from('employee_favorites')
    .upsert({
      employee_id: employeeId,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      href: input.href,
      label: input.label,
      icon_key: input.iconKey,
      position,
    }, { onConflict: 'employee_id,entity_type,entity_id' })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { id: data.id } }
}

export async function removeFavorite(entityType: string, entityId: string | null = null): Promise<ActionResult> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }

  const admin = createAdminClient()
  let q = admin.from('employee_favorites').delete().eq('employee_id', employeeId).eq('entity_type', entityType)
  q = entityId ? q.eq('entity_id', entityId) : q.is('entity_id', null)
  const { error } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** Bulk-persist drag-reorder — `orderedIds` are employee_favorites row ids in their new order. */
export async function reorderFavorites(orderedIds: string[]): Promise<ActionResult> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }

  const admin = createAdminClient()
  const results = await Promise.all(
    orderedIds.map((id, position) =>
      admin.from('employee_favorites').update({ position }).eq('id', id).eq('employee_id', employeeId),
    ),
  )
  const failed = results.find(r => r.error)
  if (failed?.error) return { ok: false, error: failed.error.message }
  return { ok: true }
}
