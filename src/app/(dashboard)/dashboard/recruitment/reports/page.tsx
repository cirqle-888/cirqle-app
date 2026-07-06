import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import ReportsClient from './reports-client'

export const dynamic = 'force-dynamic'

export default async function RecruitmentReportsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!hasPermission(me, 'recruitment.view')) redirect('/dashboard')

  return <ReportsClient />
}
