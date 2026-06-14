import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Map of pathname prefix -> required permission key.
 * If a non-admin user visits a path with a required perm they lack, redirect to /dashboard.
 */
const ROUTE_PERMS: Array<[RegExp, string]> = [
  [/^\/dashboard\/cashbook/,                'cashbook.view'],
  [/^\/dashboard\/payroll/,                 'payroll.view'],
  [/^\/dashboard\/invoices/,                'billing.view_invoices'],
  [/^\/dashboard\/quotations/,              'billing.view_quotations'],
  [/^\/dashboard\/settings\/designations/,  'settings.manage_designations'],
  [/^\/dashboard\/settings\/change-requests/, 'employees.review_change_requests'],
  [/^\/dashboard\/settings/,                'settings.access'],
  [/^\/dashboard\/import/,                  'tasks.create'],
  // Note: /dashboard (root) is intentionally NOT gated here.
  // The page itself renders EmployeeDashboard (counts-only) for non-admins
  // and the full analytics dashboard for admins. Gating at the middleware
  // would force-bounce employees to /dashboard/tasks, breaking the redirect
  // from blocked routes like /dashboard/reports.
]

/**
 * Short-lived profile cache stored as an HttpOnly cookie.
 *
 * Why: middleware previously ran 2 DB round-trips on EVERY non-static request
 * (employees + designation_permissions). For an employee clicking around the
 * app, that's ~60-180 ms of pure DB latency per navigation that never changes
 * within a session.
 *
 * The cache:
 *  - Stores `{ authId, isAdmin, isArchived, designationId, allowedPerms[], exp }`
 *  - Signed via HMAC-SHA256 with SUPABASE_SERVICE_ROLE_KEY as the secret
 *  - HttpOnly, SameSite=Lax, Secure in prod; user can't read or tamper
 *  - TTL: 60 seconds (long enough to amortize hot-path navigations, short
 *    enough that role/permission changes propagate quickly)
 *  - Bound to the auth.getUser() result; if user changes, cookie is invalidated
 */
const PROFILE_COOKIE = 'cirqle.mw.profile'
const PROFILE_TTL_SEC = 60

interface ProfileCachePayload {
  authId: string
  isAdmin: boolean
  isArchived: boolean
  designationId: string | null
  /** Permission keys granted to this designation (empty for admins — they have all). */
  allowedPerms: string[]
  /** Unix seconds expiry. */
  exp: number
}

/** Lazy-loaded HMAC key. Edge runtime supports crypto.subtle natively. */
let cachedKey: CryptoKey | null = null
async function getHmacKey(): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) return null
  const enc = new TextEncoder()
  cachedKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return cachedKey
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(s: string): ArrayBuffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  // Allocate a dedicated ArrayBuffer (not SharedArrayBuffer) so the result is
  // directly usable by Web Crypto without TypeScript type-widening complaints.
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

async function signProfile(payload: ProfileCachePayload): Promise<string | null> {
  const key = await getHmacKey()
  if (!key) return null
  const enc = new TextEncoder()
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const bodyBytes = enc.encode(body)
  const sig = await crypto.subtle.sign('HMAC', key, bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength))
  return `${body}.${b64url(new Uint8Array(sig))}`
}

async function verifyProfile(cookie: string | undefined, authId: string): Promise<ProfileCachePayload | null> {
  if (!cookie) return null
  const [body, sig] = cookie.split('.')
  if (!body || !sig) return null
  const key = await getHmacKey()
  if (!key) return null
  try {
    const enc = new TextEncoder()
    const bodyBytes = enc.encode(body)
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sig),
      bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
    )
    if (!ok) return null
    const json = new TextDecoder().decode(b64urlDecode(body))
    const payload = JSON.parse(json) as ProfileCachePayload
    if (payload.authId !== authId) return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const pathname = request.nextUrl.pathname

  const isAuthPage = pathname.startsWith('/login')
                  || pathname.startsWith('/forgot-password')
                  || pathname.startsWith('/reset-password')
                  || pathname.startsWith('/register')
  const isPublic   = pathname === '/'
                  || pathname.startsWith('/portal')
                  || pathname.startsWith('/intake')   // client/agency request portal — tokenized, no login
                  || pathname.startsWith('/api/shortcut') // iOS Shortcuts API — its own bearer-token auth

  if (!user && !isAuthPage && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Signed-in users hitting login are bounced to dashboard (forgot/reset/register stay accessible)
  if (user && pathname.startsWith('/login')) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  // Permission gating for dashboard subroutes.
  // Fail OPEN: if migration isn't applied yet, no employee row, or no designation assigned,
  // do NOT gate — the legacy single-admin app keeps working until the migration runs
  // and the admin assigns designations.
  if (user && pathname.startsWith('/dashboard')) {
    // Fast path: profile already cached this session?
    const cached = await verifyProfile(
      request.cookies.get(PROFILE_COOKIE)?.value,
      user.id,
    )
    let profile: ProfileCachePayload | null = cached

    if (!profile) {
      // Slow path: fetch employee + designation + permissions
      let emp: any = null
      let queryFailed = false

      try {
        const { data, error } = await supabase
          .from('employees')
          .select('id, is_archived, designation:designation_id(id, name, is_admin)')
          .eq('auth_id', user.id)
          .maybeSingle()
        if (error) queryFailed = true
        else emp = data
      } catch {
        queryFailed = true
      }

      // Migration not applied OR query failed → no gating
      if (queryFailed) return supabaseResponse

      // No employee row → legacy admin (single-user setup before invite flow) → no gating
      if (!emp) return supabaseResponse

      const designation = Array.isArray(emp.designation) ? emp.designation[0] : emp.designation
      const isAdmin = designation?.is_admin === true

      // Pre-fetch allowed permission keys (single query — replaces the per-route
      // lookup that previously fired on every navigation to a gated page).
      // Admins always pass; we skip the query entirely for them.
      let allowedPerms: string[] = []
      if (designation?.id && !isAdmin) {
        try {
          const { data: dp } = await supabase
            .from('designation_permissions')
            .select('permission:permission_id(key)')
            .eq('designation_id', designation.id)
            .eq('allowed', true)
          allowedPerms = (dp ?? [])
            .map((r: any) => {
              const perm = Array.isArray(r.permission) ? r.permission[0] : r.permission
              return perm?.key
            })
            .filter(Boolean)
        } catch {
          // Permissions table missing — admin-by-flag still works
        }
      }

      profile = {
        authId: user.id,
        isAdmin,
        isArchived: emp.is_archived === true,
        designationId: designation?.id ?? null,
        allowedPerms,
        exp: Math.floor(Date.now() / 1000) + PROFILE_TTL_SEC,
      }

      // Persist cache on the outgoing response. The signed cookie lets the
      // next request skip both DB queries entirely.
      const signed = await signProfile(profile)
      if (signed) {
        supabaseResponse.cookies.set(PROFILE_COOKIE, signed, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          path: '/',
          maxAge: PROFILE_TTL_SEC,
        })
      }
    }

    // Archived employees: sign out + redirect
    if (profile.isArchived) {
      await supabase.auth.signOut()
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      url.searchParams.set('archived', '1')
      // Clear the profile cookie too so the next login starts clean
      supabaseResponse.cookies.delete(PROFILE_COOKIE)
      return NextResponse.redirect(url)
    }

    // No designation assigned yet → fail open
    if (!profile.designationId) return supabaseResponse

    // Admin designation → no gating
    if (profile.isAdmin) return supabaseResponse

    // Regular designation → check route permission
    const matched = ROUTE_PERMS.find(([re]) => re.test(pathname))
    if (!matched) return supabaseResponse
    const requiredKey = matched[1]

    if (!profile.allowedPerms.includes(requiredKey)) {
      const url = request.nextUrl.clone()
      if (pathname === '/dashboard') {
        url.pathname = '/dashboard/tasks'
      } else {
        url.pathname = '/dashboard'
        url.searchParams.set('denied', '1')
      }
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

/**
 * Helper for server actions / API routes to bust the profile cache when an
 * employee's role, designation, or archival status changes. Without this, a
 * role change wouldn't take effect for up to PROFILE_TTL_SEC seconds.
 */
export function clearProfileCacheHeader(): { name: string; value: string } {
  return { name: PROFILE_COOKIE, value: '' }
}
