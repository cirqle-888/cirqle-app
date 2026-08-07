import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { listWorkspaces, listEmployeesForWorkspaces } from '@/lib/workspaces/actions'
import { WorkspacesClient } from './workspaces-client'

export const dynamic = 'force-dynamic'

export default async function WorkspacesSettingsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')

  // Open to every signed-in employee: managers administer the SHARED
  // workspaces; everyone else designs their own PERSONAL ones here. The
  // client scopes what each role sees; the server actions enforce it.
  const canManage = me.isAdmin || hasPermission(me, 'workspaces.manage')

  const [wsRes, empRes] = await Promise.all([
    listWorkspaces(),
    // Member picker is a manager-only concern (and the action rejects others).
    canManage ? listEmployeesForWorkspaces() : Promise.resolve({ ok: true as const, data: [] }),
  ])

  return (
    <WorkspacesClient
      initialWorkspaces={wsRes.ok ? wsRes.data : []}
      employees={empRes.ok ? empRes.data : []}
      canManage={canManage}
      myEmployeeId={me.employeeId}
    />
  )
}
