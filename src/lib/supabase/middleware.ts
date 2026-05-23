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
]

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
  const isPublic   = pathname === '/' || pathname.startsWith('/portal')

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

    // Archived employees: sign out + redirect
    if (emp.is_archived) {
      await supabase.auth.signOut()
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      url.searchParams.set('archived', '1')
      return NextResponse.redirect(url)
    }

    const designation = Array.isArray(emp.designation) ? emp.designation[0] : emp.designation

    // No designation assigned yet → fail open
    if (!designation) return supabaseResponse

    // Admin designation → no gating
    if (designation.is_admin === true) return supabaseResponse

    // Regular designation → check route permission
    const matched = ROUTE_PERMS.find(([re]) => re.test(pathname))
    if (!matched) return supabaseResponse
    const requiredKey = matched[1]

    const { data: dp } = await supabase
      .from('designation_permissions')
      .select('allowed, permission:permission_id(key)')
      .eq('designation_id', designation.id)
      .eq('allowed', true)
    const allowed = (dp ?? []).some((r: any) => {
      const perm = Array.isArray(r.permission) ? r.permission[0] : r.permission
      return perm?.key === requiredKey
    })

    if (!allowed) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      url.searchParams.set('denied', '1')
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}
