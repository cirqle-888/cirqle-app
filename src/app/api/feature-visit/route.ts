import { NextResponse } from 'next/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/admin'
import { navSections, isNavItemVisible } from '@/lib/nav-sections'
import { featureForPath } from '@/lib/feature-usage/catalogue'
import { todayISO } from '@/lib/utils/local-date'

/**
 * "This person opened this sidebar page today" — for Insights → Feature Usage.
 *
 * Sent by components/layout/feature-visit-tracker once per page per day, with
 * fetch keepalive. A route handler, not a server action, on purpose: the
 * client runs server actions one at a time, so an action fired on every page
 * change would queue behind (and in front of) the user's real ones.
 *
 * Writes at most one row per person per page per day — the page path is
 * mapped to its sidebar feature here, so record ids and query strings are
 * never stored. Always answers 204: tracking must never show an error.
 * Behind the normal session check in middleware.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const done = new NextResponse(null, { status: 204 })
  // JSON only: another site cannot send this content type without a CORS
  // preflight, so it cannot plant visits with a signed-in person's cookies.
  if (!(req.headers.get('content-type') || '').includes('application/json')) return done
  let path = ''
  try {
    const text = await req.text()
    if (text.length > 1000) return done
    const body = JSON.parse(text) as { path?: unknown }
    path = typeof body.path === 'string' ? body.path : ''
  } catch { return done }

  const href = featureForPath(path)
  if (!href) return done

  const me = await loadCurrentUser().catch(() => null)
  // An admin previewing someone must not write visits in their name.
  if (!me || me.isArchived || me.isViewAs) return done

  // Only pages this person may actually open — a bounced visit is not a use.
  const item = navSections.flatMap(s => s.items).find(i => i.href === href)
  if (!item || !isNavItemVisible(item, k => me.permissions.has(k), me.isAdmin)) return done

  try {
    const { error } = await createAdminClient().from('feature_visits').upsert(
      { employee_id: me.employeeId, feature_href: href, visit_date: todayISO() },
      { onConflict: 'employee_id,feature_href,visit_date', ignoreDuplicates: true },
    )
    // PGRST205 = the migration has not been run yet. Quietly skip until it is.
    if (error && error.code !== 'PGRST205') console.warn('[feature-visit] write failed:', error.message)
  } catch (err) {
    console.warn('[feature-visit] unexpected error:', err)
  }
  return done
}
