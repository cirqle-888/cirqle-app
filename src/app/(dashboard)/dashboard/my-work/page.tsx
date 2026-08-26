import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadMyWork } from '@/lib/requests/my-work-load'
import MyWorkClient from './my-work-client'

export const dynamic = 'force-dynamic'

/**
 * My Work — one person's own queue.
 *
 * Gated on requests.work_own, NOT requests.view: the whole point is that a
 * designer reaches this without the inbox being opened to them. Admins pass
 * via hasPermission's is_admin short-circuit and simply see their own assigned
 * rows (usually none), which is correct — this page is never a management view.
 */
export default async function MyWorkPage() {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!hasPermission(me, PERMS.REQUESTS_WORK_OWN)) redirect('/dashboard')

  const admin = createAdminClient()
  const rows = await loadMyWork(admin, me.employeeId)

  return <MyWorkClient initialRows={rows} firstName={(me.name || '').split(' ')[0] || 'there'} />
}
