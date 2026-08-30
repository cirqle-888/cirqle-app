import Sidebar from '@/components/layout/sidebar'
import { PrivacyProvider } from '@/contexts/privacy-context'
import { RoleProvider, type ServerEmployee } from '@/contexts/role-context'
import { PermissionProvider, type PermissionUser } from '@/contexts/permission-context'
import { FavoritesProvider } from '@/contexts/favorites-context'
import { WorkspaceProvider } from '@/contexts/workspace-context'
import { RequestsBadgeProvider } from '@/contexts/requests-badge-context'
import { PresenceProvider } from '@/contexts/presence-context'
import { CommandPalette } from '@/components/ui/command-palette'
// TEMPORARY — remove with the bypass. See src/lib/permissions/dev-bypass.ts
import { PermissionBypassBanner } from '@/components/dev/permission-bypass-banner'
import { DesktopNotifier } from '@/components/desktop/desktop-notifier'
import { FloatingCommsWidget } from '@/components/comms/floating-comms-widget'
import { BirthdayCelebration } from '@/components/ui/birthday-celebration'
import { FxRatesAutoSync } from './fx-rates-auto-sync'
import { loadCurrentUser } from '@/lib/permissions/check'
import { ViewAsBanner } from '@/components/layout/view-as-banner'
import { isBirthdayToday } from '@/lib/utils/birthday'
import { createAdminClient } from '@/lib/supabase/admin'
import { listFavoritesForEmployee } from '@/lib/favorites/queries'
import { getMyWorkspaceState } from '@/lib/workspaces/actions'
import { unstable_cache } from 'next/cache'
import { resolveBrandingUrl } from '@/lib/utils/branding'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { navSections, isNavItemVisible, resolveActiveHref } from '@/lib/nav-sections'
import { hasPermission } from '@/lib/permissions/check'
// Workspace logo URL fetch — pulls both dark and light variants.
// Service-role client so RLS on company_settings can't block it.
// Returns nulls on any failure so the Sidebar falls back to the default mark.
//
// EGRESS: this layout wraps EVERY dashboard route, so before caching this ran a
// fresh Postgres round-trip on every single navigation for every user. That is
// cheap when the values are https:// URLs and ruinous when they are base64 data
// URLs (the Settings uploader writes those — see settings-client.tsx), because
// then the whole image crosses the wire on every page view. These three values
// change perhaps twice a year, so they are cached process-wide for 5 minutes.
// Call revalidateTag('company-settings') after saving branding to bust it.
const getLogoUrls = unstable_cache(
  async (): Promise<{ logoUrl: string | null; logoUrlDark: string | null; faviconUrl: string | null }> => {
    const admin = createAdminClient()
    const { data } = await admin
      .from('company_settings')
      .select('key, value')
      .in('key', ['logo_url', 'logo_url_dark', 'favicon_url'])
    const map = Object.fromEntries((data || []).map((r: any) => [r.key, (r.value || '').trim()]))
    return {
      logoUrl:     resolveBrandingUrl(map['logo_url'])      || null,
      logoUrlDark: resolveBrandingUrl(map['logo_url_dark']) || null,
      faviconUrl:  resolveBrandingUrl(map['favicon_url'])   || null,
    }
  },
  ['company-logo-urls'],
  { revalidate: 300, tags: ['company-settings'] },
)

async function fetchLogoUrls(): Promise<{ logoUrl: string | null; logoUrlDark: string | null; faviconUrl: string | null }> {
  try {
    return await getLogoUrls()
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
    defaultLandingHref: '/dashboard', isSystem: true,
    ownerEmployeeId: null, memberIds: [],
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
        // The pre-migration "no designation → treat as admin" fallback must NOT
        // apply while previewing: an employee with no designation is exactly
        // the case the preview needs to show honestly, not paper over.
        isAdmin: me.isViewAs ? me.isAdmin : (me.isAdmin || me.designationId === null),
        permissions: Array.from(me.permissions),
        dateOfBirth: me.dateOfBirth,
        isViewAs: me.isViewAs,
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
          {/* Online status + self-set status, app-wide. Disabled during a
              view-as preview: an admin previewing someone must not send
              heartbeats in their name and light them up green. */}
          <PresenceProvider
            myEmployeeId={me?.employeeId ?? ''}
            enabled={!!me?.employeeId && !me.isViewAs}
          >
          {/* key = whose favourites these are.
              FavoritesProvider seeds its state with useState(initialFavorites),
              which reads the prop ONLY on first mount. Across a client-side
              navigation the provider instance is reused, so a later render
              carrying a different person's favourites was ignored and the
              previous list stayed on screen. Harmless while the identity never
              changes mid-session — but view-as changes exactly that, and an
              admin previewing a designer kept seeing their OWN pinned pages
              (Invoices, Cash Book, Requests) in the sidebar, which reads as a
              permission leak and is not one.
              Keying on the employee forces a remount when, and only when, the
              identity actually changes. */}
          <FavoritesProvider key={me?.employeeId ?? 'anon'} initialFavorites={initialFavorites}>
          <WorkspaceProvider initial={initialWorkspaceState}>
          <RequestsBadgeProvider>
          {/* h-dvh = dynamic viewport height (adapts as Safari toolbar shows/hides).
              h-screen (100vh) on iOS uses the *large* viewport (toolbar-hidden),
              making the container taller than the visible area when the address bar
              is showing — that gap appears as blank white space on iPad.
              overscroll-none on main prevents iOS elastic-bounce into the
              background that's visible when page content is shorter than the viewport. */}
          {/* data-app-shell: while a slide-over (Discuss) is open, the rule in
              globals.css shrinks this container by the panel's width so the
              page reflows beside it instead of hiding underneath — tables keep
              every column reachable through their own scroller. */}
          {/* Outside data-app-shell so the side-panel width rule cannot shift
              it — the one thing that must stay put is the reminder that you
              are not looking at your own account. */}
          {meResult.user?.isViewAs && (
            <ViewAsBanner
              cqid={meResult.user.cqid}
              designation={meResult.user.designationName}
            />
          )}
          {/* data-bottom-nav: employees get the mobile bottom nav bar, which is
              `fixed bottom-0 z-50` and therefore paints over any page-level
              fixed action bar (e.g. Contributions' Save bar). The attribute
              drives --bottom-nav-h in globals.css so those bars can sit above
              it. Server-rendered so the offset is right on first paint. */}
          <div
            data-app-shell
            data-bottom-nav={!user.isAdmin ? 'employee' : undefined}
            className={`flex h-dvh overflow-hidden ${meResult.user?.isViewAs ? 'pt-7' : ''}`}
          >
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
            {/* TEMPORARY — remove with the permission bypass.
                See src/lib/permissions/dev-bypass.ts */}
            <PermissionBypassBanner />
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
          </PresenceProvider>
        </PermissionProvider>
      </RoleProvider>
    </PrivacyProvider>
  )
}
