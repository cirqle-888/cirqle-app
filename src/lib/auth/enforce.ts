'use server'

/**
 * Centralized server-side permission enforcement.
 *
 * Every server action in this codebase MUST call one of these helpers before
 * touching any data. These are the only authoritative auth checks — UI-level
 * role gates are cosmetic and must never be relied on for security.
 *
 * Usage (in any 'use server' file):
 *   const guard = await requirePermission('payroll.edit')
 *   if (!guard.ok) return { ok: false, error: guard.error }
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { PermKey } from '@/lib/permissions/keys'

// ─── Result types ──────────────────────────────────────────────────────────────

export type GuardOk   = { ok: true; employeeId: string; isAdmin: boolean }
export type GuardFail = { ok: false; error: string }
export type GuardResult = GuardOk | GuardFail

// ─── Internal: resolve the current user from the anon client ──────────────────

interface ResolvedUser {
  employeeId: string
  designationId: string | null
  isAdmin: boolean
  isArchived: boolean
}

async function resolveUser(): Promise<ResolvedUser | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const admin = createAdminClient()

  // Primary lookup by auth_id (fast path)
  let { data: emp } = await admin
    .from('employees')
    .select('id, is_archived, designation:designation_id(id, is_admin)')
    .eq('auth_id', user.id)
    .maybeSingle()

  // Fallback: email match + backfill (handles newly-linked accounts)
  if (!emp && user.email) {
    const byEmail = await admin
      .from('employees')
      .select('id, is_archived, designation:designation_id(id, is_admin)')
      .eq('email', user.email)
      .maybeSingle()
    emp = byEmail.data
    if (emp) {
      // Backfill auth_id so next call is fast
      await admin.from('employees').update({ auth_id: user.id }).eq('id', (emp as any).id)
    }
  }

  if (!emp) return null

  const designation = Array.isArray((emp as any).designation)
    ? (emp as any).designation[0]
    : (emp as any).designation

  const designationId: string | null = designation?.id ?? null

  const isAdmin = designation?.is_admin === true

  return {
    employeeId: (emp as any).id,
    designationId,
    isAdmin,
    isArchived: (emp as any).is_archived === true,
  }
}

/** Load all allowed permission keys for a designation (cached per-request by Next.js fetch deduplication). */
async function loadDesignationPerms(designationId: string): Promise<Set<string>> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('designation_permissions')
    .select('allowed, permission:permission_id(key)')
    .eq('designation_id', designationId)
    .eq('allowed', true)
  return new Set(
    (data ?? [])
      .map((r: any) => (Array.isArray(r.permission) ? r.permission[0]?.key : r.permission?.key))
      .filter(Boolean),
  )
}

// ─── Public enforcement helpers ───────────────────────────────────────────────

/**
 * Require the caller to hold a specific permission key.
 * Admins (is_admin designation) always pass.
 * Archived employees are always denied.
 */
export async function requirePermission(key: PermKey | string): Promise<GuardResult> {
  const user = await resolveUser()
  if (!user)              return { ok: false, error: 'Not signed in.' }
  if (user.isArchived)    return { ok: false, error: 'Your account is archived.' }
  if (user.isAdmin)       return { ok: true, employeeId: user.employeeId, isAdmin: true }
  if (!user.designationId) return { ok: false, error: 'No designation assigned.' }

  const perms = await loadDesignationPerms(user.designationId)
  if (!perms.has(key))    return { ok: false, error: 'Permission denied.' }
  return { ok: true, employeeId: user.employeeId, isAdmin: false }
}

/**
 * Require the caller to hold ANY of the supplied permission keys.
 * Useful for "admin OR accounts can do X" scenarios.
 */
export async function requireAnyPermission(keys: (PermKey | string)[]): Promise<GuardResult> {
  const user = await resolveUser()
  if (!user)              return { ok: false, error: 'Not signed in.' }
  if (user.isArchived)    return { ok: false, error: 'Your account is archived.' }
  if (user.isAdmin)       return { ok: true, employeeId: user.employeeId, isAdmin: true }
  if (!user.designationId) return { ok: false, error: 'No designation assigned.' }

  const perms = await loadDesignationPerms(user.designationId)
  const has = keys.some(k => perms.has(k))
  if (!has) return { ok: false, error: 'Permission denied.' }
  return { ok: true, employeeId: user.employeeId, isAdmin: false }
}

/**
 * Require the caller to be an admin (is_admin designation).
 * Use for truly admin-only operations (designation CRUD, employee archive, etc.).
 */
export async function requireAdmin(): Promise<GuardResult> {
  const user = await resolveUser()
  if (!user)           return { ok: false, error: 'Not signed in.' }
  if (user.isArchived) return { ok: false, error: 'Your account is archived.' }
  if (!user.isAdmin)   return { ok: false, error: 'Admin access required.' }
  return { ok: true, employeeId: user.employeeId, isAdmin: true }
}

/**
 * Assert financial mutation access.
 * Used before any insert/update/delete touching monetary fields.
 * Pass the module-specific write permission key (e.g. 'payroll.edit').
 */
export async function assertFinancialAccess(writeKey: PermKey | string): Promise<GuardResult> {
  // Identical to requirePermission — kept as a named function so it's searchable
  // in audit trails and the intent is explicit at call sites.
  return requirePermission(writeKey)
}

/**
 * Assert workflow transition access.
 * Used for status changes (pending→paid, draft→sent, etc.) that don't require
 * full financial edit permission — just workflow.manage.
 */
export async function assertWorkflowAccess(workflowKey: PermKey | string): Promise<GuardResult> {
  return requirePermission(workflowKey)
}

/**
 * Resolve the current employee ID without checking any permissions.
 * Used for "self" operations (e.g., update own avatar) where identity is the gate.
 */
export async function resolveCurrentEmployeeId(): Promise<string | null> {
  const user = await resolveUser()
  if (!user || user.isArchived) return null
  return user.employeeId
}
