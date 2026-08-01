import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import type { PermKey } from './keys'

export interface CurrentUser {
  authId: string
  employeeId: string
  cqid: string
  name: string
  email: string
  designationId: string | null
  designationName: string | null
  isAdmin: boolean
  isArchived: boolean
  permissions: Set<string>
  dateOfBirth: string | null
}

// ── Process-level cache ──────────────────────────────────────────────────────
// Across-request cache for the employee + permissions lookup. Keyed by auth
// user id (extracted on every call so we can never serve user A's perms to
// user B). 30-second TTL — long enough to make rapid page navigation feel
// instant, short enough that designation/permission changes are picked up
// without a server restart.
//
// React's built-in `cache()` only dedupes within ONE request; this Map
// persists across requests in the same Node process. In dev mode (single
// long-running process) this gives consistent gains. In serverless prod,
// each cold start resets it — still beneficial because hot processes serve
// many requests before being recycled.
type CacheEntry = { user: CurrentUser | null; expiresAt: number }
const USER_CACHE = new Map<string, CacheEntry>()
const USER_CACHE_TTL_MS = 30_000

function pruneCache() {
  if (USER_CACHE.size < 200) return
  const now = Date.now()
  for (const [k, v] of USER_CACHE) if (v.expiresAt <= now) USER_CACHE.delete(k)
}

/**
 * Drop cached permission sets so a change takes effect on the very next
 * request instead of up to 30s later.
 *
 * Call after granting/revoking permissions or changing a designation. The 30s
 * lag is tolerable for most permissions, but for a RESTRICTION like
 * `scope.by_service` "I granted it and nothing happened" is exactly the
 * confusion that makes people distrust the feature.
 *
 * Keyed by AUTH id (the cache key), so pass the employee's auth_id. Omit the
 * argument to clear everyone — correct for designation-level changes, which
 * affect every employee holding that designation.
 *
 * Note: only clears THIS Node process. In serverless prod other warm instances
 * still expire on their own TTL; this is a best-effort improvement, not a
 * distributed invalidation.
 */
export function invalidateUserCache(authId?: string | null): void {
  if (authId) USER_CACHE.delete(authId)
  else USER_CACHE.clear()
}

/**
 * Load the currently-authenticated user with their effective permission set.
 * Returns null when not signed in. Gracefully degrades to admin-like access when the
 * designations migration has not yet been applied (so the app keeps working pre-migration).
 *
 * Wrapped with React `cache()` so multiple server components calling this within
 * the same request share a single DB round-trip instead of each running their own.
 * Additionally backed by a 30-second process-level Map keyed by auth user id, so
 * rapid back-and-forth navigation only pays for the auth.getUser() round-trip,
 * not the full employee + permissions lookup.
 */
export const loadCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // Process-level cache hit — skips the two follow-up DB round-trips.
  const cached = USER_CACHE.get(user.id)
  if (cached && cached.expiresAt > Date.now()) return cached.user

  // Helper: store the result before returning so the next page nav in this
  // ~30s window only pays for auth.getUser() (~50ms) instead of full lookup.
  const cacheAndReturn = (result: CurrentUser | null): CurrentUser | null => {
    pruneCache()
    USER_CACHE.set(user.id, { user: result, expiresAt: Date.now() + USER_CACHE_TTL_MS })
    return result
  }

  // Try the new shape first (with designation_id + new columns)
  let emp: any = null
  try {
    const { data } = await supabase
      .from('employees')
      .select(`
        id, cqid, name, email, is_archived, date_of_birth,
        designation:designation_id ( id, name, is_admin )
      `)
      .eq('auth_id', user.id)
      .maybeSingle()
    emp = data
  } catch {
    // Migration not yet applied
  }

  // Fallback: old shape (no designation_id, no is_archived, no date_of_birth)
  if (!emp) {
    const { data } = await supabase
      .from('employees')
      .select('id, cqid, name, email, role')
      .eq('auth_id', user.id)
      .maybeSingle()
    if (!data) return cacheAndReturn(null)
    return cacheAndReturn({
      authId: user.id,
      employeeId: data.id,
      cqid: data.cqid ?? '',
      name: data.name ?? '',
      email: data.email ?? '',
      designationId: null,
      designationName: null,
      isAdmin: data.role === 'super_admin',
      isArchived: false,
      permissions: new Set(),
      dateOfBirth: null,
    })
  }

  const designation = Array.isArray(emp.designation) ? emp.designation[0] : emp.designation
  const isAdmin = designation?.is_admin === true

  let permissions = new Set<string>()
  if (isAdmin) {
    try {
      const { data: all } = await supabase.from('permissions').select('key')
      permissions = new Set((all ?? []).map((p: any) => p.key))
    } catch {
      // permissions table missing — admin-by-flag still works via isAdmin=true
    }
  } else if (designation?.id) {
    try {
      const { data: dp } = await supabase
        .from('designation_permissions')
        .select('allowed, permission:permission_id(key)')
        .eq('designation_id', designation.id)
        .eq('allowed', true)
      permissions = new Set(
        (dp ?? [])
          .map((r: any) => Array.isArray(r.permission) ? r.permission[0]?.key : r.permission?.key)
          .filter(Boolean)
      )
    } catch {
      // designation_permissions missing — no perms
    }
  }

  return cacheAndReturn({
    authId: user.id,
    employeeId: emp.id,
    cqid: emp.cqid ?? '',
    name: emp.name ?? '',
    email: emp.email ?? '',
    designationId: designation?.id ?? null,
    designationName: designation?.name ?? null,
    isAdmin,
    isArchived: emp.is_archived === true,
    permissions,
    dateOfBirth: emp.date_of_birth ?? null,
  })
})

export function hasPermission(user: CurrentUser | null, key: string | string[]): boolean {
  if (!user || user.isArchived) return false
  if (user.isAdmin) return true
  if (Array.isArray(key)) return key.some(k => user.permissions.has(k))
  return user.permissions.has(key)
}

// ── Server Action Guards (moved from enforce.ts) ───────────────────────────────

export type GuardOk   = { ok: true; employeeId: string; isAdmin: boolean }
export type GuardFail = { ok: false; error: string }
export type GuardResult = GuardOk | GuardFail

/**
 * Require the caller to hold a specific permission key.
 * Admins always pass. Archived employees are always denied.
 */
export async function requirePermission(key: PermKey | string): Promise<GuardResult> {
  const user = await loadCurrentUser()
  if (!user)              return { ok: false, error: 'Not signed in.' }
  if (user.isArchived)    return { ok: false, error: 'Your account is archived.' }
  if (user.isAdmin)       return { ok: true, employeeId: user.employeeId, isAdmin: true }
  if (!user.designationId) return { ok: false, error: 'No designation assigned.' }
  if (!user.permissions.has(key)) return { ok: false, error: 'Permission denied.' }
  return { ok: true, employeeId: user.employeeId, isAdmin: false }
}

/** Require the caller to hold ANY of the supplied permission keys. */
export async function requireAnyPermission(keys: (PermKey | string)[]): Promise<GuardResult> {
  const user = await loadCurrentUser()
  if (!user)              return { ok: false, error: 'Not signed in.' }
  if (user.isArchived)    return { ok: false, error: 'Your account is archived.' }
  if (user.isAdmin)       return { ok: true, employeeId: user.employeeId, isAdmin: true }
  if (!user.designationId) return { ok: false, error: 'No designation assigned.' }
  
  const has = keys.some(k => user.permissions.has(k))
  if (!has) return { ok: false, error: 'Permission denied.' }
  return { ok: true, employeeId: user.employeeId, isAdmin: false }
}

/** Require the caller to be an admin. */
export async function requireAdmin(): Promise<GuardResult> {
  const user = await loadCurrentUser()
  if (!user)           return { ok: false, error: 'Not signed in.' }
  if (user.isArchived) return { ok: false, error: 'Your account is archived.' }
  if (!user.isAdmin)   return { ok: false, error: 'Admin access required.' }
  return { ok: true, employeeId: user.employeeId, isAdmin: true }
}

/** Resolve the current employee ID without checking permissions. */
export async function resolveCurrentEmployeeId(): Promise<string | null> {
  const user = await loadCurrentUser()
  if (!user || user.isArchived) return null
  return user.employeeId
}
