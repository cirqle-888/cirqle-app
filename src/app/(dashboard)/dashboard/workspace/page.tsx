import { redirect } from 'next/navigation'
import { loadCurrentUser } from '@/lib/permissions/check'
import { listWorkspaceItems } from './actions'
import { WorkspaceClient } from './workspace-client'

export const dynamic = 'force-dynamic'

/**
 * Personal Workspace — private per-employee planner. No permission gate beyond
 * being signed in; every item is owner-scoped in the actions + RLS.
 */
export default async function WorkspacePage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')

  const res = await listWorkspaceItems()
  return <WorkspaceClient initialItems={res.ok ? res.data : []} />
}
