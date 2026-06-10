import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import RequestsClient from './requests-client'

export const dynamic = 'force-dynamic'

export default async function RequestsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || !!me?.permissions?.has('requests.view')
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()

  // Defensive: portal tables may not exist until the migration runs.
  let requests: any[] = []
  let migrated = true
  try {
    const { data, error } = await admin
      .from('task_requests')
      .select('*, client:clients(id, name, code), agency:agencies(id, name), service:services(id, name)')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) migrated = false
    requests = data || []
  } catch { migrated = false }

  const perms = {
    review:   isAdmin || !!me?.permissions?.has('requests.review'),
    start:    isAdmin || !!me?.permissions?.has('requests.start'),
    manage:   isAdmin || !!me?.permissions?.has('requests.manage'),
    activity: isAdmin || !!me?.permissions?.has('requests.activity.view'),
  }

  return <RequestsClient migrated={migrated} initialRequests={requests} perms={perms} />
}
