import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import ApplicantProfileClient from './profile-client'

export const dynamic = 'force-dynamic'

export default async function ApplicantProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!hasPermission(me, 'recruitment.view')) redirect('/dashboard')

  return (
    <ApplicantProfileClient
      applicationId={id}
      canEdit={me.isAdmin || hasPermission(me, 'recruitment.edit') || hasPermission(me, 'recruitment.admin')}
      canDelete={me.isAdmin || hasPermission(me, 'recruitment.delete') || hasPermission(me, 'recruitment.admin')}
    />
  )
}
