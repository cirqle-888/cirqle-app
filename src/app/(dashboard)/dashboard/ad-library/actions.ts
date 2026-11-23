'use server'

/**
 * Ad Library server actions — the write path for /dashboard/ad-library.
 *
 * House pattern: requirePermission → guard.ok → createAdminClient → mutation →
 * revalidatePath → { ok, error?, data? }. The ad tables are server-only.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { revalidatePath } from 'next/cache'
import { cleanTags, cleanText, type AdFolder } from '@/lib/ad-library/core'
import { hashKey, newConnectKey } from '@/lib/ad-library/server'

const REVALIDATE = '/dashboard/ad-library'
const UUID = /^[0-9a-f-]{36}$/i

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

export interface ConnectKeyRow { id: string; key_hint: string | null; label: string | null; created_at: string; last_used_at: string | null }

/** Make a personal key for the Chrome extension. The key is returned once and never stored. */
export async function createConnectKey(label: string | null): Promise<ActionResult<{ key: string; row: ConnectKeyRow }>> {
  const guard = await requirePermission(PERMS.ADVERTISING_CREATE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const key = newConnectKey()
  const admin = createAdminClient()
  const { data, error } = await admin.from('ad_saver_keys').insert({
    employee_id: guard.employeeId, key_hash: hashKey(key), key_hint: key.slice(-4), label: cleanText(label, 60) || 'Chrome',
  }).select('id, key_hint, label, created_at, last_used_at').single()
  if (error || !data) return { ok: false, error: 'Could not make a key.' }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { key, row: data as ConnectKeyRow } }
}

/** Switch a key off. People can only switch off their own keys (admins any). */
export async function revokeConnectKey(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_CREATE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!UUID.test(id)) return { ok: false, error: 'Unknown key.' }
  const admin = createAdminClient()
  let q = admin.from('ad_saver_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id)
  if (!guard.isAdmin) q = q.eq('employee_id', guard.employeeId)
  const { error } = await q
  if (error) return { ok: false, error: 'Could not switch the key off.' }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export interface AdPatch { folder_id?: string | null; client_id?: string | null; tags?: string[] | string; notes?: string | null }

/** Change an ad's folder, client, tags or notes. */
export async function updateAd(id: string, patch: AdPatch): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!UUID.test(id)) return { ok: false, error: 'Unknown ad.' }
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('folder_id' in patch) row.folder_id = patch.folder_id && UUID.test(patch.folder_id) ? patch.folder_id : null
  if ('client_id' in patch) row.client_id = patch.client_id && UUID.test(patch.client_id) ? patch.client_id : null
  if ('tags' in patch) row.tags = cleanTags(patch.tags)
  if ('notes' in patch) row.notes = cleanText(patch.notes, 2000)
  const { error } = await createAdminClient().from('saved_ads').update(row).eq('id', id)
  if (error) return { ok: false, error: 'Could not save the change.' }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Move several ads to a folder (null = no folder). */
export async function moveAds(ids: string[], folderId: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  const list = ids.filter(i => UUID.test(i)).slice(0, 500)
  if (!list.length) return { ok: false, error: 'Pick some ads first.' }
  const { error } = await createAdminClient().from('saved_ads')
    .update({ folder_id: folderId && UUID.test(folderId) ? folderId : null, updated_at: new Date().toISOString() }).in('id', list)
  if (error) return { ok: false, error: 'Could not move the ads.' }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Remove ads from the library. Kept in the database (deleted_at) so a re-save brings them back. */
export async function removeAds(ids: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_DELETE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const list = ids.filter(i => UUID.test(i)).slice(0, 500)
  if (!list.length) return { ok: false, error: 'Pick some ads first.' }
  const { error } = await createAdminClient().from('saved_ads').update({ deleted_at: new Date().toISOString() }).in('id', list)
  if (error) return { ok: false, error: 'Could not remove the ads.' }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Add a folder (no id) or rename one. */
export async function saveFolder(id: string | null, name: string): Promise<ActionResult<AdFolder>> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  const clean = cleanText(name, 60)
  if (!clean) return { ok: false, error: 'Give the folder a name.' }
  const admin = createAdminClient()
  if (id) {
    if (!UUID.test(id)) return { ok: false, error: 'Unknown folder.' }
    const { data, error } = await admin.from('ad_folders').update({ name: clean }).eq('id', id).select('id, name, sort').single()
    if (error || !data) return { ok: false, error: 'Could not rename the folder.' }
    revalidatePath(REVALIDATE)
    return { ok: true, data: data as AdFolder }
  }
  const { data: last } = await admin.from('ad_folders').select('sort').is('deleted_at', null).order('sort', { ascending: false }).limit(1).maybeSingle()
  const { data, error } = await admin.from('ad_folders').insert({ name: clean, sort: ((last?.sort as number) ?? -1) + 1 }).select('id, name, sort').single()
  if (error || !data) return { ok: false, error: 'Could not add the folder.' }
  revalidatePath(REVALIDATE)
  return { ok: true, data: data as AdFolder }
}

/** Delete a folder. Its ads stay in the library, without a folder. */
export async function deleteFolder(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!UUID.test(id)) return { ok: false, error: 'Unknown folder.' }
  const admin = createAdminClient()
  await admin.from('saved_ads').update({ folder_id: null }).eq('folder_id', id)
  const { error } = await admin.from('ad_folders').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: 'Could not delete the folder.' }
  revalidatePath(REVALIDATE)
  return { ok: true }
}
