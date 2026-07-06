import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import ApplicationsClient from './applications-client'

export const dynamic = 'force-dynamic'

/** Applications pipeline — kanban board across the 9 recruitment stages. */
export default async function ApplicationsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!hasPermission(me, 'recruitment.view')) redirect('/dashboard')

  return (
    <ApplicationsClient
      canEdit={me.isAdmin || hasPermission(me, 'recruitment.edit') || hasPermission(me, 'recruitment.admin')}
    />
  )
}
