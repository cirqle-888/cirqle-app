import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser } from '@/lib/permissions/check'
import AccessPreviewClient from './access-preview-client'

export const dynamic = 'force-dynamic'

export default async function AccessPreviewPage() {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!me.isAdmin) redirect('/dashboard')

  const admin = createAdminClient()
  const { data } = await admin
    .from('employees')
    .select('id, cqid, is_archived, designation:designation_id(name)')
    .order('cqid', { ascending: true })

  const employees = (data ?? []).map((e: any) => {
    const d = Array.isArray(e.designation) ? e.designation[0] : e.designation
    return {
      id: e.id,
      cqid: e.cqid ?? '',
      designationName: d?.name ?? null,
      isArchived: e.is_archived === true,
    }
  })

  // Names are deliberately absent: CQIDs identify people everywhere else in
  // this app, and an access map does not need to name anyone to be useful.
  return <AccessPreviewClient employees={employees} />
}
