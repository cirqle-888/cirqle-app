import Sidebar from '@/components/layout/sidebar'
import { PrivacyProvider } from '@/contexts/privacy-context'
import { RoleProvider, type ServerEmployee } from '@/contexts/role-context'
import { PermissionProvider, type PermissionUser } from '@/contexts/permission-context'
import { CommandPalette } from '@/components/ui/command-palette'
import { BirthdayCelebration } from '@/components/ui/birthday-celebration'
import { loadCurrentUser } from '@/lib/permissions/check'
import { isBirthdayToday } from '@/lib/utils/birthday'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Best-effort load — graceful when migration hasn't been run yet
  const me = await loadCurrentUser().catch(() => null)

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
        <PermissionProvider user={user}>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            {/* pb-16 on mobile gives clearance above the employee bottom nav bar.
                md:pb-0 restores normal layout on desktop where sidebar is visible. */}
            <main className={`flex-1 overflow-y-auto bg-background w-full ${!user.isAdmin ? 'pb-16 md:pb-0' : ''}`}>
              {children}
            </main>
            <CommandPalette />
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
