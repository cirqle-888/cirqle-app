import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadDepartments, loadTeamWorkReport } from '@/lib/reports/team-work-load'
import TeamWorkClient from './team-work-client'

export const dynamic = 'force-dynamic'

/**
 * Team Work Report — what one department delivered for each client in a
 * month, made to be shared with that team on WhatsApp. Counts only, no money.
 *
 * Open to whoever runs the work (requests.manage) or reads reports
 * (reports.view). Admins pass both.
 */
export default async function TeamWorkPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!hasPermission(me, [PERMS.REQUESTS_MANAGE, 'reports.view'])) redirect('/dashboard')

  const sp = searchParams ? await searchParams : {}
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''
  const thisMonth = new Date().toISOString().slice(0, 7)
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(one(sp.month)) ? one(sp.month) : thisMonth

  const admin = createAdminClient()
  const departments = await loadDepartments(admin)
  if (!departments.length) {
    return <TeamWorkClient report={null} departments={[]} departmentId="" month={month} thisMonth={thisMonth} />
  }
  // Social Media by default — the team this report was made for.
  const department = departments.find(d => d.id === one(sp.dept))
    ?? departments.find(d => /social/i.test(d.name))
    ?? departments[0]

  const report = await loadTeamWorkReport(admin, month, department, departments)
  return (
    <TeamWorkClient
      report={report}
      departments={departments}
      departmentId={department.id}
      month={month}
      thisMonth={thisMonth}
    />
  )
}
