import { cache } from 'react'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import type { PermKey } from './keys'
// TEMPORARY — remove with the bypass. See src/lib/permissions/dev-bypass.ts
import { devPermissionBypass } from './dev-bypass'

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
  /** True while an admin is browsing as this employee. Every mutation is
   *  refused in this state — see requirePermission. */
  isViewAs?: boolean
  /** CQID of the admin doing the previewing, for the banner. */
  viewAsBy?: string
}

/** Cookie naming the employee an admin is currently previewing. */
export const VIEW_AS_COOKIE = 'cirqle_view_as'

async function readViewAsCookie(): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers')
    const jar = await cookies()
    return jar.get(VIEW_AS_COOKIE)?.value || null
  } catch { return null }   // not in a request scope
}

/**
 * Resolve the previewed identity — but ONLY if the real signed-in user is an
 * admin. This is the security boundary for the whole feature: the cookie is
 * just a name, and this function is the one place that decides whether it
 * means anything. Returns null (→ caller falls back to the real user) for a
 * non-admin, an unknown target, or any error.
 */
async function resolveViewAs(
  db: ReturnType<typeof createAdminClient>,
  authId: string,
  targetEmployeeId: string,
): Promise<CurrentUser | null> {
  try {
    const { data: realEmp } = await db
      .from('employees')
      .select('cqid, is_archived, designation:designation_id ( is_admin )')
      .eq('auth_id', authId)
      .maybeSingle()
    const realDesig: any = Array.isArray((realEmp as any)?.designation)
      ? (realEmp as any).designation[0] : (realEmp as any)?.designation
    // Re-checked per request, never trusted from the cookie or a cache.
    if (realDesig?.is_admin !== true || (realEmp as any)?.is_archived === true) return null

    const { data: target } = await db
      .from('employees')
      .select('id, cqid, name, email, is_archived, date_of_birth, designation:designation_id ( id, name, is_admin )')
      .eq('id', targetEmployeeId)
      .maybeSingle()
    if (!target) return null

    const d: any = Array.isArray((target as any).designation)
      ? (target as any).designation[0] : (target as any).designation
    const targetIsAdmin = d?.is_admin === true

    let permissions = new Set<string>()
    if (targetIsAdmin) {
      const { data: all } = await db.from('permissions').select('key')
      permissions = new Set((all ?? []).map((p: any) => p.key))
    } else if (d?.id) {
      const { data: dp } = await db
        .from('designation_permissions')
        .select('allowed, permission:permission_id(key)')
        .eq('designation_id', d.id).eq('allowed', true)
      permissions = new Set(
        (dp ?? [])
          .map((r: any) => (Array.isArray(r.permission) ? r.permission[0] : r.permission)?.key)
          .filter(Boolean),
      )
    }

    return {
      authId,
      employeeId: (target as any).id,
      cqid: (target as any).cqid ?? '',
      name: (target as any).name ?? '',
      email: (target as any).email ?? '',
      designationId: d?.id ?? null,
      designationName: d?.name ?? null,
      isAdmin: targetIsAdmin,
      isArchived: (target as any).is_archived === true,
      permissions,
      dateOfBirth: (target as any).date_of_birth ?? null,
      isViewAs: true,
      viewAsBy: (realEmp as any)?.cqid ?? '',
    }
  } catch { return null }
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
  // The cookie-session client is used for ONE thing: establishing who is
  // signed in. Every read below goes through the service role instead.
  //
  // Authorization must not be subject to the grants it is deciding. This file
  // is imported by 158 modules and answers "what may this user do?" by reading
  // `permissions` and `designation_permissions`; running those reads as
  // `authenticated` makes the answer depend on a grant on the permission
  // catalogue itself. The least-privilege migration revokes exactly that grant,
  // so on the session client hasPermission() would have returned the empty set
  // for every user on every page — a full lockout, with no error to point at.
  //
  // It also lets `employees.date_of_birth` stay ungranted. The authz path needs
  // the signed-in user's own birthday for the CurrentUser record, and the only
  // alternative was a column grant that hands every employee's date of birth to
  // every other employee.
  //
  // This widens nothing in practice: every query below is already pinned to a
  // single row by auth_id or employee id, so the service role returns the same
  // row RLS would have allowed.
  const supabase = await createClient()
  const db = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // ── View-as ────────────────────────────────────────────────────────────────
  // An admin can browse the app through another employee's permissions. The
  // cookie only names a target; it grants nothing on its own. Authority is
  // re-derived from the REAL signed-in user on every single request below, so
  // a forged or stale cookie on a non-admin session is inert.
  //
  // It can only ever REDUCE access: the returned identity is the target's, and
  // requirePermission refuses every mutation while it is set (see there). An
  // admin cannot use this to gain anything they did not already have.
  const viewAsId = await readViewAsCookie()

  // Cache key includes the target — the same auth session resolves to a
  // different CurrentUser while previewing, and keying on auth id alone would
  // serve the admin their own permissions inside the preview (or worse, leak
  // the preview's reduced set back out after exiting).
  const cacheKey = viewAsId ? `${user.id}::${viewAsId}` : user.id
  const cached = USER_CACHE.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.user

  // Helper: store the result before returning so the next page nav in this
  // ~30s window only pays for auth.getUser() (~50ms) instead of full lookup.
  const cacheAndReturn = (result: CurrentUser | null): CurrentUser | null => {
    pruneCache()
    USER_CACHE.set(cacheKey, { user: result, expiresAt: Date.now() + USER_CACHE_TTL_MS })
    return result
  }

  if (viewAsId) {
    const previewed = await resolveViewAs(db, user.id, viewAsId)
    if (previewed) return cacheAndReturn(previewed)
    // Target missing, or the real user is not an admin → fall through and
    // resolve them normally. Failing closed to their OWN identity is right:
    // a bad cookie must never leave someone with no identity at all.
  }

  // Try the new shape first (with designation_id + new columns)
  let emp: any = null
  try {
    const { data } = await db
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
    const { data } = await db
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
      const { data: all } = await db.from('permissions').select('key')
      permissions = new Set((all ?? []).map((p: any) => p.key))
    } catch {
      // permissions table missing — admin-by-flag still works via isAdmin=true
    }
  } else if (designation?.id) {
    try {
      const { data: dp } = await db
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
  // The dev bypass is skipped while previewing. Honouring it here would make
  // view-as show every page in development — the exact opposite of the
  // question being asked ("what can THIS employee actually reach?"), and
  // development is where the preview gets used most.
  // TEMPORARY (dev only, dead code in production builds) — src/lib/permissions/dev-bypass.ts
  if (!user.isViewAs && devPermissionBypass()) return true
  if (Array.isArray(key)) return key.some(k => user.permissions.has(k))
  return user.permissions.has(key)
}

// ── Server Action Guards (moved from enforce.ts) ───────────────────────────────

export type GuardOk   = { ok: true; employeeId: string; isAdmin: boolean }
export type GuardFail = { ok: false; error: string }
export type GuardResult = GuardOk | GuardFail

/**
 * The shared body of every permission guard.
 *
 * `allowViewAs` is the ONLY axis that separates the read guards from the write
 * guards, and it is the whole reason this is one function instead of four
 * near-copies that drift.
 */
/** The identity facts a guard decision turns on — everything else is noise. */
export interface GuardSubject {
  isArchived: boolean
  isViewAs?: boolean
  isAdmin: boolean
  designationId: string | null
  /** Whether this subject holds the key(s) the caller asked about. */
  hasPermission: boolean
}

/**
 * The guard rule, as a pure function — no database, no cookies, no request.
 *
 * Extracted so the security behaviour can be pinned by tests instead of
 * inferred by reading. The order of these checks IS the policy; see check.test.ts.
 */
export function guardDecision(
  subject: GuardSubject | null,
  { allowViewAs, devBypass = false }: { allowViewAs: boolean; devBypass?: boolean },
): { ok: true; isAdmin: boolean } | GuardFail {
  if (!subject)           return { ok: false, error: 'Not signed in.' }
  if (subject.isArchived) return { ok: false, error: 'Your account is archived.' }
  // View-as is READ-ONLY, and this is where that is enforced for writes. Every
  // mutation in the app passes through a guard with allowViewAs:false, so
  // refusing at this one point blocks them all — including any added later,
  // which is the property that makes the guarantee hold over time rather than
  // depending on remembering.
  //
  // Checked BEFORE the isAdmin short-circuit on purpose — previewing an admin
  // must not hand the writes back.
  if (subject.isViewAs && !allowViewAs) {
    return { ok: false, error: 'Preview is read-only. Exit preview to make changes.' }
  }
  if (subject.isAdmin) return { ok: true, isAdmin: true }
  // TEMPORARY (dev only, dead code in production builds) — src/lib/permissions/dev-bypass.ts
  if (devBypass) return { ok: true, isAdmin: false }
  if (!subject.designationId) return { ok: false, error: 'No designation assigned.' }
  if (!subject.hasPermission) return { ok: false, error: 'Permission denied.' }
  return { ok: true, isAdmin: false }
}

async function guardWith(
  check: (user: CurrentUser) => boolean,
  { allowViewAs }: { allowViewAs: boolean },
): Promise<GuardResult> {
  const user = await loadCurrentUser()
  const decision = guardDecision(
    user && { ...user, hasPermission: check(user) },
    { allowViewAs, devBypass: devPermissionBypass() },
  )
  if (!decision.ok) return decision
  return { ok: true, employeeId: user!.employeeId, isAdmin: decision.isAdmin }
}

/**
 * Require the caller to hold a specific permission key, for a MUTATION.
 * Admins always pass. Archived employees are always denied. Refused outright
 * while an admin is previewing another employee — use requireReadPermission
 * for anything that only reads.
 */
export async function requirePermission(key: PermKey | string): Promise<GuardResult> {
  return guardWith(u => u.permissions.has(key), { allowViewAs: false })
}

/** Require the caller to hold ANY of the supplied keys, for a MUTATION. */
export async function requireAnyPermission(keys: (PermKey | string)[]): Promise<GuardResult> {
  return guardWith(u => keys.some(k => u.permissions.has(k)), { allowViewAs: false })
}

/**
 * The same permission check, for an action that ONLY READS.
 *
 * Reads have to survive view-as, and putting them behind the write guard broke
 * the preview in the one way that matters: it did not show the employee being
 * previewed seeing less, it showed the app FAILING. The invoice panel spun on
 * "Loading line items…" forever and its PDF rendered a total with no lines —
 * a document that, if sent, would have been wrong. An admin checking what a
 * Task Manager can see concluded the Task Manager could not see invoices, when
 * in fact they hold billing.view_invoices and can see them perfectly well.
 *
 * A preview that lies is worse than no preview, because people act on it.
 *
 * Use this ONLY where nothing is written and no write capability is handed out
 * — a signed upload URL is a write, and stays on requirePermission.
 */
export async function requireReadPermission(key: PermKey | string): Promise<GuardResult> {
  return guardWith(u => u.permissions.has(key), { allowViewAs: true })
}

/** Read-only counterpart of requireAnyPermission. */
export async function requireAnyReadPermission(keys: (PermKey | string)[]): Promise<GuardResult> {
  return guardWith(u => keys.some(k => u.permissions.has(k)), { allowViewAs: true })
}

/** Require the caller to be an admin. */
export async function requireAdmin(): Promise<GuardResult> {
  const user = await loadCurrentUser()
  if (!user)           return { ok: false, error: 'Not signed in.' }
  if (user.isArchived) return { ok: false, error: 'Your account is archived.' }
  // TEMPORARY (dev only, dead code in production builds) — src/lib/permissions/dev-bypass.ts
  // Included so privilege-escalating fields (base salary, designation) are
  // editable while validating the new modules, not just readable.
  if (devPermissionBypass()) return { ok: true, employeeId: user.employeeId, isAdmin: true }
  if (!user.isAdmin)   return { ok: false, error: 'Admin access required.' }
  return { ok: true, employeeId: user.employeeId, isAdmin: true }
}

/** Resolve the current employee ID without checking permissions. */
export async function resolveCurrentEmployeeId(): Promise<string | null> {
  const user = await loadCurrentUser()
  if (!user || user.isArchived) return null
  return user.employeeId
}
