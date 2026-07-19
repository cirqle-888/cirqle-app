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
  // Pre-migration fallback: employees with no designation assigned are treated
  // as admin. This matches the layout sidebar (`me.isAdmin || me.designationId
  // === null`) and the server-action guard in `enforce.ts`, so every page sees
  // the same notion of "admin" without each consumer re-implementing it.
  const isAdmin = designation?.is_admin === true || !designation?.id

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

export function hasPermission(user: CurrentUser | null, key: PermKey | string): boolean {
  if (!user) return false
  if (user.isArchived) return false
  if (user.isAdmin) return true
  return user.permissions.has(key)
}
