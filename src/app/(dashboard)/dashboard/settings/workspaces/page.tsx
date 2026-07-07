import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { listWorkspaces, listEmployeesForWorkspaces } from '@/lib/workspaces/actions'
import { WorkspacesClient } from './workspaces-client'

export const dynamic = 'force-dynamic'

export default async function WorkspacesSettingsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!me.isAdmin && !hasPermission(me, 'workspaces.manage')) redirect('/dashboard/settings')

  const [wsRes, empRes] = await Promise.all([listWorkspaces(), listEmployeesForWorkspaces()])

  return (
    <WorkspacesClient
      initialWorkspaces={wsRes.ok ? wsRes.data : []}
      employees={empRes.ok ? empRes.data : []}
    />
  )
}
