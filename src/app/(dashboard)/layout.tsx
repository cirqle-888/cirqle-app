import Sidebar from '@/components/layout/sidebar'
import { PrivacyProvider } from '@/contexts/privacy-context'
import { RoleProvider, type ServerEmployee } from '@/contexts/role-context'
import { PermissionProvider, type PermissionUser } from '@/contexts/permission-context'
import { FavoritesProvider } from '@/contexts/favorites-context'
import { WorkspaceProvider } from '@/contexts/workspace-context'
import { RequestsBadgeProvider } from '@/contexts/requests-badge-context'
import { CommandPalette } from '@/components/ui/command-palette'
import { DesktopNotifier } from '@/components/desktop/desktop-notifier'
import { FloatingCommsWidget } from '@/components/comms/floating-comms-widget'
import { BirthdayCelebration } from '@/components/ui/birthday-celebration'
import { FxRatesAutoSync } from './fx-rates-auto-sync'
import { loadCurrentUser } from '@/lib/permissions/check'
import { isBirthdayToday } from '@/lib/utils/birthday'
import { createAdminClient } from '@/lib/supabase/admin'
import { listFavoritesForEmployee } from '@/lib/favorites/queries'
import { getMyWorkspaceState } from '@/lib/workspaces/actions'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { navSections, isNavItemVisible, resolveActiveHref } from '@/lib/nav-sections'
import { hasPermission } from '@/lib/permissions/check'
// Workspace logo URL fetch — pulls both dark and light variants.
// Service-role client so RLS on company_settings can't block it.
// Returns nulls on any failure so the Sidebar falls back to the default mark.
async function fetchLogoUrls(): Promise<{ logoUrl: string | null; logoUrlDark: string | null; faviconUrl: string | null }> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('company_settings')
      .select('key, value')
      .in('key', ['logo_url', 'logo_url_dark', 'favicon_url'])
    const map = Object.fromEntries((data || []).map((r: any) => [r.key, (r.value || '').trim()]))
    return {
      logoUrl:     map['logo_url']      || null,
      logoUrlDark: map['logo_url_dark'] || null,
      faviconUrl:  map['favicon_url']   || null,
    }
  } catch {
    return { logoUrl: null, logoUrlDark: null, faviconUrl: null }
  }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Best-effort loads — both graceful so the dashboard always renders.
  // Distinguish "lookup errored" (transient DB failure → fail CLOSED, never
  // grant admin on an error) from "returned null" (no employee row →
  // legacy single-admin setup → permissive fallback is intentional).
  const [meResult, logos] = await Promise.all([
    loadCurrentUser().then(
      (u) => ({ user: u, failed: false }),
      () => ({ user: null, failed: true }),
    ),
    fetchLogoUrls(),
  ])
  // Favorites need the employee id from meResult, so this can't join the
  // Promise.all above — fetched right after, still before first paint.
  const initialFavorites = meResult.user
    ? await listFavoritesForEmployee(meResult.user.employeeId).catch(() => [])
    : []

  // Graceful pre-migration fallback: if migration 022 isn't applied yet, the
  // workspaces table doesn't exist — fall back to a single synthetic
  // "All Workspace" so the app renders exactly as it did before this feature.
  const FALLBACK_ALL_WORKSPACE = {
    id: '', name: 'All Workspace', icon: 'LayoutGrid', color: 'slate',
    sidebarModuleHrefs: null, dashboardWidgetKeys: null,
    defaultLandingHref: '/dashboard', isSystem: true, memberIds: [],
  }
  const wsState = meResult.user
    ? await getMyWorkspaceState().catch(() => null)
    : null
  const initialWorkspaceState = wsState?.ok
    ? wsState.data
    : { current: FALLBACK_ALL_WORKSPACE, available: [FALLBACK_ALL_WORKSPACE], canManage: false }
  const me = meResult.user
  const loadFailed = meResult.failed
  const { logoUrl, logoUrlDark, faviconUrl } = logos

  // Permissive admin shape ONLY for the pre-migration single-admin case
  // (signed in, no employee record). If the lookup errored, fall back to a
  // zero-permission user instead — a transient DB error must not grant admin.
  const fallbackUser: PermissionUser = {
    employeeId: '',
    authId: '',
    cqid: '',
    name: '',
    email: '',
    designationId: null,
    designationName: null,
    isAdmin: false,
    permissions: [],
    dateOfBirth: null,
  }

  const user: PermissionUser = me
    ? {
        employeeId: me.employeeId,
        authId: me.authId,
        cqid: me.cqid,
        name: me.name,
        email: me.email,
        designationId: me.designationId,
        designationName: me.designationName,
        isAdmin: me.isAdmin || me.designationId === null, // pre-migration: treat as admin
        permissions: Array.from(me.permissions),
        dateOfBirth: me.dateOfBirth,
      }
    : fallbackUser

  const showBirthday = !!me && isBirthdayToday(me.dateOfBirth)

  // Pre-populate the client-side RoleProvider from server data so the
  // sidebar renders correctly on first paint — no async fetch / no flicker.
  const serverEmployee: ServerEmployee | null = me
    ? { id: me.employeeId, authId: me.authId, name: me.name, email: me.email, cqid: me.cqid, isAdmin: user.isAdmin }
    : null

  const headersList = await headers()
  const pathname = headersList.get('x-pathname') || '/dashboard'
  const activeHref = resolveActiveHref(navSections, pathname)
  if (activeHref && activeHref !== '/dashboard') {
    const section = navSections.find(s => s.items.some(i => i.href === activeHref))
    const item = section?.items.find(i => i.href === activeHref)
    if (item && !isNavItemVisible(item, (key) => hasPermission(me, key), user.isAdmin)) {
      redirect('/dashboard?denied=1')
    }
  }

  return (
    <PrivacyProvider>
      <RoleProvider initialEmployee={serverEmployee}>
        <PermissionProvider user={user} logoUrl={logoUrl} logoUrlDark={logoUrlDark} faviconUrl={faviconUrl}>
          <FavoritesProvider initialFavorites={initialFavorites}>
          <WorkspaceProvider initial={initialWorkspaceState}>
          <RequestsBadgeProvider>
          {/* h-dvh = dynamic viewport height (adapts as Safari toolbar shows/hides).
              h-screen (100vh) on iOS uses the *large* viewport (toolbar-hidden),
              making the container taller than the visible area when the address bar
              is showing — that gap appears as blank white space on iPad.
              overscroll-none on main prevents iOS elastic-bounce into the
              background that's visible when page content is shorter than the viewport. */}
          <div className="flex h-dvh overflow-hidden">
            {/* First tab stop on every dashboard page: lets keyboard users jump
                past the full sidebar nav. Visually hidden until focused. */}
            <a
              href="#main-content"
              className="fixed top-3 left-3 z-[100] -translate-y-[200%] focus:translate-y-0 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium shadow-lg"
            >
              Skip to content
            </a>
            <Sidebar />
            {/* pb-16 on mobile gives clearance above the employee bottom nav bar.
                md:pb-0 restores normal layout on desktop where sidebar is visible. */}
            <main id="main-content" tabIndex={-1} className={`flex-1 overflow-y-auto overscroll-none bg-background w-full ${!user.isAdmin ? 'pb-16 md:pb-0' : ''}`}>
              {children}
            </main>
            <CommandPalette />
            <DesktopNotifier />
            <FloatingCommsWidget />
            <FxRatesAutoSync />
            {showBirthday && me && (
              <BirthdayCelebration
                employeeId={me.employeeId}
                name={me.name}
                cqid={me.cqid}
              />
            )}
          </div>
          </RequestsBadgeProvider>
          </WorkspaceProvider>
          </FavoritesProvider>
        </PermissionProvider>
      </RoleProvider>
    </PrivacyProvider>
  )
}
