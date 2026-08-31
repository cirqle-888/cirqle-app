import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { Database } from '../../types/supabase'

/**
 * Map of pathname prefix -> required permission key.
 * If a non-admin user visits a path with a required perm they lack, redirect to /dashboard.
 */
const ROUTE_PERMS: Array<[RegExp, string]> = [
  [/^\/dashboard\/activity/,                'timeline.view_all'],
  [/^\/dashboard\/leads/,                   'leads.view'],
  [/^\/dashboard\/field-marketing/,         'field.view'],
  [/^\/dashboard\/agency/,                  'reports.view'],
  // More specific first: the planner has its own permission.
  [/^\/dashboard\/social\/feed/,           'social.plan_feed'],
  [/^\/dashboard\/social(?!-calendar)/,     'social.view_insights'],
  // Platform connections (Meta OAuth, ad-account/campaign mapping). Moved out
  // of /dashboard/advertising/integrations — same permission as before.
  [/^\/dashboard\/connections/,             'advertising.manage_providers'],
  [/^\/dashboard\/assets/,                  'assets.assign'],
  [/^\/dashboard\/cirqle-accounts/,         'assets.view_cirqle'],
  [/^\/dashboard\/chat/,                    'chat.access'],
  [/^\/dashboard\/recruitment/,             'recruitment.view'],
  // More specific first — this list is first-match-wins, like the settings
  // entries below. Both of these screens exist to show money: Accounts is the
  // balance-and-ledger view and Reconciliation matches amounts against the
  // bank. Gating them on `cashbook.view` alone let anyone who could browse
  // entries — with the amount column deliberately stripped — read every balance
  // by typing the URL.
  [/^\/dashboard\/cashbook\/accounts/,       'cashbook.view_amounts'],
  [/^\/dashboard\/cashbook\/reconciliation/, 'cashbook.view_amounts'],
  [/^\/dashboard\/cashbook/,                'cashbook.view'],
  [/^\/dashboard\/partners/,                'finance.partner.view'],
  [/^\/dashboard\/payroll/,                 'payroll.view'],
  [/^\/dashboard\/performance/,             'performance.manage'],
  [/^\/dashboard\/packages/,                'packages.view'],
  [/^\/dashboard\/invoices/,                'billing.view_invoices'],
  // Statement of Account reads the same invoices; gated here too so it matches
  // every other finance route rather than relying on its page check alone.
  [/^\/dashboard\/statements/,              'billing.view_invoices'],
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

// ── Rate Limiter ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 60 // requests
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute

function checkRateLimit(request: NextRequest): boolean {
  // NextRequest.ip was removed in Next 15+ — on Vercel the client address
  // arrives as the FIRST entry of x-forwarded-for (later entries are proxies),
  // with x-real-ip as a fallback. Taking the whole header would let a caller
  // append values and get a fresh bucket per request.
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown'
  if (ip === 'unknown') return true

  const now = Date.now()
  const record = rateLimitMap.get(ip)

  // Lazy cleanup to prevent memory leaks in long-lived isolates
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap.entries()) {
      if (v.resetAt < now) rateLimitMap.delete(k)
    }
  }

  if (!record || record.resetAt < now) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return true
  }

  if (record.count >= RATE_LIMIT) {
    return false
  }

  record.count++
  return true
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet: { name: string, value: string, options: any }[]) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          request.headers.set('x-pathname', request.nextUrl.pathname)
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
                  || pathname.startsWith('/i/')        // public hosted invoice — tokenized, no login
                  || pathname.startsWith('/feed/')     // client feed approval — tokenized, no login
                  || pathname.startsWith('/start/')    // client hub — single link to all that client's intake apps
                  || pathname.startsWith('/careers')   // public job application form — no login
                  || pathname.startsWith('/api/health') // Uptime monitoring — must answer without a session, or the
                                                         // monitor only ever sees the 307 to /login and reports "up"
                                                         // while the database is unreachable. Returns booleans only.
                  || pathname.startsWith('/api/shortcut') // iOS Shortcuts API — its own bearer-token auth
                  || pathname.startsWith('/api/cron/')  // Vercel Cron — its own CRON_SECRET bearer-token auth, no Supabase session.
                                                         // Pre-existing bug fixed here: this prefix was missing, so every cron
                                                         // request (including the original cleanup-product-images) was getting
                                                         // 307-redirected to /login before reaching the route's own auth check —
                                                         // i.e. silently never executing in production.
                  || pathname.startsWith('/api/webhooks/') // Provider webhooks (Meta leadgen etc.) — authenticated by
                                                         // X-Hub-Signature-256 HMAC (app secret) inside the route itself.
                                                         // Meta's servers carry no session cookie; without this exemption
                                                         // every delivery would be 307-redirected to /login and dropped.
                  || pathname.startsWith('/api/figma/')
                  || pathname.startsWith('/api/logo')
                  || pathname.startsWith('/api/favicon')
                  || pathname.startsWith('/api/invoice-logo') // Cirqle Studio Figma plugin — its own offer_sheet_secret bearer auth
                                                         // (fail-closed in the routes). Same bug class as /api/cron/ above: the
                                                         // plugin's iframe carries no session cookies, so without this exemption
                                                         // its CORS preflight was 307-redirected to /login — and browsers reject
                                                         // any redirected preflight ("Redirect is not allowed for a preflight
                                                         // request"), making the API unreachable from Figma despite valid auth.

  if (isPublic || isAuthPage) {
    if (!checkRateLimit(request)) {
      return new NextResponse('Too Many Requests', { status: 429 })
    }
  }

  if (!user && !isAuthPage && !isPublic) {
    // Server Action POSTs cannot follow an HTML redirect. `fetch` auto-follows
    // the 307, receives /login's text/html, and Next's server-action-reducer
    // throws the opaque "An unexpected response was received from the server."
    // — which is what surfaces as an unhandled rejection on the dashboard.
    // Answer them with an honest status instead. Auth is NOT relaxed here: the
    // request is still refused, it just fails legibly. Public/tokenized action
    // surfaces (intake, careers, portal) are already excluded by isPublic above.
    if (request.method === 'POST' && request.headers.has('next-action')) {
      return new NextResponse('Unauthorized', { status: 401 })
    }
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

      if (queryFailed || !emp) {
        const url = request.nextUrl.clone()
        url.pathname = '/login'
        url.searchParams.set('error', 'profile')
        return NextResponse.redirect(url)
      }
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
