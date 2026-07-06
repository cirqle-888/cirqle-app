import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import OffersClient from './offers-client'

export const dynamic = 'force-dynamic'

export default async function OffersPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!hasPermission(me, 'recruitment.view')) redirect('/dashboard')

  return <OffersClient canEdit={me.isAdmin || hasPermission(me, 'recruitment.edit') || hasPermission(me, 'recruitment.admin')} />
}
