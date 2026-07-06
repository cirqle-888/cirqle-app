import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import InterviewsClient from './interviews-client'

export const dynamic = 'force-dynamic'

export default async function InterviewsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!hasPermission(me, 'recruitment.view')) redirect('/dashboard')

  return <InterviewsClient canEdit={me.isAdmin || hasPermission(me, 'recruitment.edit') || hasPermission(me, 'recruitment.admin')} />
}
