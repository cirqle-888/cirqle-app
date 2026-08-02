'use server'

/**
 * Quick Actions usage tracking — backs the Frequent / Recent tabs in the
 * global command palette. Favorites deliberately has NO code here — it
 * reuses the existing generic employee_favorites framework
 * (lib/favorites/actions.ts) with entity_type='nav_page', same as the
 * sidebar's own pinned-favorites section.
 *
 * Graceful pre-migration: every function no-ops / returns [] if migration
 * 022 (item_usage) isn't applied yet.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/permissions/check'

export interface UsageItem {
  itemKey: string
  itemType: string
  label: string
  href: string
  count: number
  lastUsedAt: string
}

/** Fire-and-forget: call after navigating to something from Quick Actions. */
export async function recordUsage(input: {
  itemKey: string
  itemType: string
  label: string
  href: string
  workspaceId?: string | null
}): Promise<void> {
  try {
    const employeeId = await resolveCurrentEmployeeId()
    if (!employeeId) return
    const admin = createAdminClient()
    const { data: existing } = await admin
      .from('item_usage')
      .select('count')
      .eq('employee_id', employeeId)
      .eq('item_key', input.itemKey)
      .maybeSingle()
    await admin.from('item_usage').upsert({
      employee_id: employeeId,
      item_key: input.itemKey,
      item_type: input.itemType,
      label: input.label,
      href: input.href,
      workspace_id: input.workspaceId ?? null,
      count: (existing?.count ?? 0) + 1,
      last_used_at: new Date().toISOString(),
    }, { onConflict: 'employee_id,item_key' })
  } catch { /* pre-migration or transient — usage tracking is best-effort */ }
}

export async function listFrequent(limit = 8): Promise<UsageItem[]> {
  try {
    const employeeId = await resolveCurrentEmployeeId()
    if (!employeeId) return []
    const admin = createAdminClient()
    const { data } = await admin
      .from('item_usage')
      .select('item_key, item_type, label, href, count, last_used_at')
      .eq('employee_id', employeeId)
      .order('count', { ascending: false })
      .limit(limit)
    return (data ?? []).map(r => ({
      itemKey: r.item_key, itemType: r.item_type, label: r.label, href: r.href,
      count: r.count, lastUsedAt: r.last_used_at,
    }))
  } catch { return [] }
}

export async function listRecent(limit = 8): Promise<UsageItem[]> {
  try {
    const employeeId = await resolveCurrentEmployeeId()
    if (!employeeId) return []
    const admin = createAdminClient()
    const { data } = await admin
      .from('item_usage')
      .select('item_key, item_type, label, href, count, last_used_at')
      .eq('employee_id', employeeId)
      .order('last_used_at', { ascending: false })
      .limit(limit)
    return (data ?? []).map(r => ({
      itemKey: r.item_key, itemType: r.item_type, label: r.label, href: r.href,
      count: r.count, lastUsedAt: r.last_used_at,
    }))
  } catch { return [] }
}
