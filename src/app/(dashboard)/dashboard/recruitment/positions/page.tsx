import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import PositionsClient from './positions-client'

export const dynamic = 'force-dynamic'

export default async function PositionsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!hasPermission(me, 'recruitment.view')) redirect('/dashboard')

  return (
    <PositionsClient
      canEdit={me.isAdmin || hasPermission(me, 'recruitment.edit') || hasPermission(me, 'recruitment.admin')}
      canDelete={me.isAdmin || hasPermission(me, 'recruitment.delete') || hasPermission(me, 'recruitment.admin')}
    />
  )
}
