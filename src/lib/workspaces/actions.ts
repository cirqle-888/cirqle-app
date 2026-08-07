'use server'

/**
 * Workspace Manager server actions.
 *
 * A workspace is a saved UI context — which sidebar items show, which
 * dashboard widgets show, and where you land when you switch into it.
 * CRITICAL: workspaces only ever RESTRICT what's shown on top of a viewer's
 * existing permissions — they never grant anything. Every read here still
 * goes through the normal permission-filtered nav on the client; a workspace
 * scoped to hrefs the viewer can't actually access just means those items are
 * invisible (same as today), not that new access opens up.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission, type CurrentUser } from '@/lib/permissions/check'

export interface Workspace {
  id: string
  name: string
  icon: string
  color: string
  sidebarModuleHrefs: string[] | null   // null = unrestricted (all permitted items)
  dashboardWidgetKeys: string[] | null  // null = all widgets
  defaultLandingHref: string
  isSystem: boolean
  memberIds: string[]
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function requireUser() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  return { ok: true as const, me }
}

function canManage(me: CurrentUser): boolean {
  return me.isAdmin || hasPermission(me, 'workspaces.manage')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapWorkspace(r: any, memberIds: string[] = []): Workspace {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    color: r.color,
    sidebarModuleHrefs: r.sidebar_module_hrefs?.length ? r.sidebar_module_hrefs : null,
    dashboardWidgetKeys: r.dashboard_widget_keys?.length ? r.dashboard_widget_keys : null,
    defaultLandingHref: r.default_landing_href,
    isSystem: r.is_system,
    memberIds,
  }
}

/**
 * Workspaces the caller may see: managers get all (they administer them).
 * Everyone else gets exactly the workspaces they are assigned to — including
 * NOT the "All Workspace" system row once they have at least one assignment.
 * An employee with a curated workspace should live in it, not next to an
 * everything-view that defeats the curation; the system row remains only as
 * the fallback for employees no one has assigned anywhere yet (without it
 * they would have no nav config at all).
 *
 * Membership ids are part of the workspace's configuration, so they only ride
 * along for managers; a plain member has no business seeing who else is in.
 */
export async function listWorkspaces(): Promise<Result<Workspace[]>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const manager = canManage(auth.me)
  const admin = createAdminClient()

  const { data: rows, error } = await admin
    .from('workspaces')
    .select('id, name, icon, color, sidebar_module_hrefs, dashboard_widget_keys, default_landing_href, is_system')
    .order('is_system', { ascending: false })
    .order('name', { ascending: true })
  if (error) return { ok: false, error: error.message }

  const ids = (rows ?? []).map(r => r.id)
  const { data: members } = ids.length
    ? await admin.from('workspace_members').select('workspace_id, employee_id').in('workspace_id', ids)
    : { data: [] as { workspace_id: string; employee_id: string }[] }
  const membersByWs = new Map<string, string[]>()
  for (const m of members ?? []) {
    if (!membersByWs.has(m.workspace_id)) membersByWs.set(m.workspace_id, [])
    membersByWs.get(m.workspace_id)!.push(m.employee_id)
  }

  const mine = (rows ?? []).filter(r => (membersByWs.get(r.id) ?? []).includes(auth.me.employeeId))
  const visible = manager
    ? (rows ?? [])
    // Assigned somewhere → only those. Assigned nowhere → the system fallback.
    : mine.length > 0
      ? mine
      : (rows ?? []).filter(r => r.is_system)

  return { ok: true, data: visible.map(r => mapWorkspace(r, manager ? membersByWs.get(r.id) ?? [] : [])) }
}

export async function createWorkspace(input: {
  name: string
  icon: string
  color: string
  sidebarModuleHrefs: string[] | null
  dashboardWidgetKeys: string[] | null
  defaultLandingHref: string
  memberIds: string[]
}): Promise<Result<{ id: string }>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  if (!canManage(auth.me)) return { ok: false, error: 'You do not have permission to manage workspaces.' }
  const name = (input.name || '').trim()
  if (!name) return { ok: false, error: 'A name is required.' }

  const admin = createAdminClient()
  const { data: ws, error } = await admin.from('workspaces').insert({
    name,
    icon: input.icon || 'LayoutGrid',
    color: input.color || 'violet',
    sidebar_module_hrefs: input.sidebarModuleHrefs?.length ? input.sidebarModuleHrefs : null,
    dashboard_widget_keys: input.dashboardWidgetKeys?.length ? input.dashboardWidgetKeys : null,
    default_landing_href: input.defaultLandingHref || '/dashboard',
    created_by: auth.me.employeeId,
  }).select('id').single()
  if (error) return { ok: false, error: error.message }

  if (input.memberIds.length) {
    await admin.from('workspace_members').insert(
      input.memberIds.map(employeeId => ({ workspace_id: ws.id, employee_id: employeeId })),
    )
  }
  revalidatePath('/dashboard/settings/workspaces')
  return { ok: true, data: { id: ws.id } }
}

export async function updateWorkspace(id: string, input: {
  name?: string
  icon?: string
  color?: string
  sidebarModuleHrefs?: string[] | null
  dashboardWidgetKeys?: string[] | null
  defaultLandingHref?: string
  memberIds?: string[]
}): Promise<Result<null>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  if (!canManage(auth.me)) return { ok: false, error: 'You do not have permission to manage workspaces.' }

  const admin = createAdminClient()
  const { data: existing } = await admin.from('workspaces').select('is_system').eq('id', id).maybeSingle()
  if (!existing) return { ok: false, error: 'Workspace not found.' }
  if (existing.is_system && (input.name !== undefined)) {
    return { ok: false, error: '"All Workspace" cannot be renamed.' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upd: any = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) upd.name = input.name.trim()
  if (input.icon !== undefined) upd.icon = input.icon
  if (input.color !== undefined) upd.color = input.color
  if (input.sidebarModuleHrefs !== undefined) upd.sidebar_module_hrefs = input.sidebarModuleHrefs?.length ? input.sidebarModuleHrefs : null
  if (input.dashboardWidgetKeys !== undefined) upd.dashboard_widget_keys = input.dashboardWidgetKeys?.length ? input.dashboardWidgetKeys : null
  if (input.defaultLandingHref !== undefined) upd.default_landing_href = input.defaultLandingHref

  const { error } = await admin.from('workspaces').update(upd).eq('id', id)
  if (error) return { ok: false, error: error.message }

  if (input.memberIds !== undefined) {
    await admin.from('workspace_members').delete().eq('workspace_id', id)
    if (input.memberIds.length) {
      await admin.from('workspace_members').insert(
        input.memberIds.map(employeeId => ({ workspace_id: id, employee_id: employeeId })),
      )
    }
  }
  revalidatePath('/dashboard/settings/workspaces')
  return { ok: true, data: null }
}

export async function deleteWorkspace(id: string): Promise<Result<null>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  if (!canManage(auth.me)) return { ok: false, error: 'You do not have permission to manage workspaces.' }

  const admin = createAdminClient()
  const { data: existing } = await admin.from('workspaces').select('is_system').eq('id', id).maybeSingle()
  if (!existing) return { ok: false, error: 'Workspace not found.' }
  if (existing.is_system) return { ok: false, error: '"All Workspace" cannot be deleted.' }

  // Anyone currently on this workspace falls back to "All Workspace".
  await admin.from('employees').update({ current_workspace_id: null }).eq('current_workspace_id', id)
  const { error } = await admin.from('workspaces').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/settings/workspaces')
  return { ok: true, data: null }
}

/**
 * Switch the caller's active workspace. Validated: the caller must be an
 * admin OR an assigned member (or it's the "All Workspace" system row) —
 * switching can never be used to peek at a workspace's config you're not
 * assigned to (though workspace config itself carries no extra permissions).
 */
export async function switchWorkspace(workspaceId: string | null): Promise<Result<{ landingHref: string }>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  // Mirror of listWorkspaces' visibility rule: an assigned employee lives in
  // their assigned workspaces — the "All Workspace" system row is reachable
  // only by managers and by employees with no assignment (their fallback).
  // Enforced here too so a stale switcher can't route around the list filter.
  const systemAllowed = async (): Promise<boolean> => {
    if (canManage(me)) return true
    const { count } = await admin.from('workspace_members')
      .select('workspace_id', { count: 'exact', head: true })
      .eq('employee_id', me.employeeId)
    return (count ?? 0) === 0
  }

  if (workspaceId === null) {
    // Explicit "All Workspace" — resolve the system row's landing href.
    if (!(await systemAllowed())) {
      return { ok: false, error: 'You are assigned to specific workspaces — pick one of those.' }
    }
    const { data: sys } = await admin.from('workspaces').select('id, default_landing_href').eq('is_system', true).maybeSingle()
    await admin.from('employees').update({ current_workspace_id: sys?.id ?? null }).eq('id', me.employeeId)
    revalidatePath('/dashboard')
    return { ok: true, data: { landingHref: sys?.default_landing_href ?? '/dashboard' } }
  }

  const { data: ws } = await admin.from('workspaces').select('id, is_system, default_landing_href').eq('id', workspaceId).maybeSingle()
  if (!ws) return { ok: false, error: 'Workspace not found.' }

  if (ws.is_system) {
    if (!(await systemAllowed())) {
      return { ok: false, error: 'You are assigned to specific workspaces — pick one of those.' }
    }
  } else if (!me.isAdmin) {
    const { data: member } = await admin.from('workspace_members')
      .select('employee_id').eq('workspace_id', workspaceId).eq('employee_id', me.employeeId).maybeSingle()
    if (!member) return { ok: false, error: 'You do not have access to that workspace.' }
  }

  const { error } = await admin.from('employees').update({ current_workspace_id: ws.id }).eq('id', me.employeeId)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard')
  return { ok: true, data: { landingHref: ws.default_landing_href } }
}

/** Everything the shell needs in one call: current workspace + the switch list. */
export async function getMyWorkspaceState(): Promise<Result<{ current: Workspace; available: Workspace[]; canManage: boolean }>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  const list = await listWorkspaces()
  if (!list.ok) return list

  const { data: emp } = await admin.from('employees').select('current_workspace_id').eq('id', me.employeeId).maybeSingle()
  const currentId = emp?.current_workspace_id ?? null
  // A stale current_workspace_id (assignment revoked since they last switched)
  // simply falls back to "All Workspace" — the list is membership-filtered, so
  // it no longer contains the revoked workspace.
  const current = list.data.find(w => w.id === currentId) ?? list.data.find(w => w.isSystem) ?? list.data[0]
  // No system row and no memberships: let the caller use its own fallback
  // rather than handing the shell an undefined workspace.
  if (!current) return { ok: false, error: 'No workspace available.' }

  return { ok: true, data: { current, available: list.data, canManage: canManage(me) } }
}

/** Employee picklist for the member-assignment UI. */
/**
 * Members picker for the workspace editor — CQIDs only.
 *
 * `name` is deliberately NOT selected: employee names are private, and this
 * picker only ever needs to identify a row. Not fetching the name at all makes
 * a render-time leak impossible, which is the guarantee the lint rule can only
 * approximate (see eslint.privacy.mjs).
 */
export async function listEmployeesForWorkspaces(): Promise<Result<{ id: string; cqid: string }[]>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  if (!canManage(auth.me)) return { ok: false, error: 'You do not have permission to manage workspaces.' }
  const admin = createAdminClient()
  const { data } = await admin.from('employees').select('id, cqid')
    .or('is_archived.is.null,is_archived.eq.false').order('cqid')
  return { ok: true, data: (data ?? []).map(e => ({ id: e.id, cqid: e.cqid ?? '' })) }
}
