import Sidebar from '@/components/layout/sidebar'
import { PrivacyProvider } from '@/contexts/privacy-context'
import { RoleProvider, type ServerEmployee } from '@/contexts/role-context'
import { PermissionProvider, type PermissionUser } from '@/contexts/permission-context'
import { CommandPalette } from '@/components/ui/command-palette'
import { BirthdayCelebration } from '@/components/ui/birthday-celebration'
import { FxRatesAutoSync } from './fx-rates-auto-sync'
import { loadCurrentUser } from '@/lib/permissions/check'
import { isBirthdayToday } from '@/lib/utils/birthday'
import { createAdminClient } from '@/lib/supabase/admin'

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
  const [me, logos] = await Promise.all([
    loadCurrentUser().catch(() => null),
    fetchLogoUrls(),
  ])
  const { logoUrl, logoUrlDark, faviconUrl } = logos

  // Default to a permissive admin shape if no employee record / migration not yet applied,
  // so the existing single-admin app keeps working until the migration runs.
  const fallbackUser: PermissionUser = {
    employeeId: '',
    authId: '',
    cqid: '',
    name: '',
    email: '',
    designationId: null,
    designationName: null,
    isAdmin: true,
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

  return (
    <PrivacyProvider>
      <RoleProvider initialEmployee={serverEmployee}>
        <PermissionProvider user={user} logoUrl={logoUrl} logoUrlDark={logoUrlDark} faviconUrl={faviconUrl}>
          {/* h-dvh = dynamic viewport height (adapts as Safari toolbar shows/hides).
              h-screen (100vh) on iOS uses the *large* viewport (toolbar-hidden),
              making the container taller than the visible area when the address bar
              is showing — that gap appears as blank white space on iPad.
              overscroll-none on main prevents iOS elastic-bounce into the
              background that's visible when page content is shorter than the viewport. */}
          <div className="flex h-dvh overflow-hidden">
            <Sidebar />
            {/* pb-16 on mobile gives clearance above the employee bottom nav bar.
                md:pb-0 restores normal layout on desktop where sidebar is visible. */}
            <main className={`flex-1 overflow-y-auto overscroll-none bg-background w-full ${!user.isAdmin ? 'pb-16 md:pb-0' : ''}`}>
              {children}
            </main>
            <CommandPalette />
            <FxRatesAutoSync />
            {showBirthday && me && (
              <BirthdayCelebration
                employeeId={me.employeeId}
                name={me.name}
                cqid={me.cqid}
              />
            )}
          </div>
        </PermissionProvider>
      </RoleProvider>
    </PrivacyProvider>
  )
}
