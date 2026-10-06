import { createTypedAdminClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import EmployeeProfileClient from './employee-client'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'

/**
 * Employee profile.
 *
 * Read with the service role, so every check is HERE: this page used to have
 * none, and any signed-in employee who followed a profile link (activity
 * timelines link here) received the colleague's whole `employees` row —
 * salary, bank details, invite token — plus their commission agreements.
 *
 *   open the page      → admin, employees.view / view_full / edit, or yourself
 *   salary             → admin, payroll.view_amounts, or yourself
 *   agreements         → employees.manage_agreements (they are special rates)
 */
export default async function EmployeeProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await loadCurrentUser()
  const isAdmin = user?.isAdmin ?? false
  const isSelf = !!user && user.employeeId === id
  const canOpen = !user || isAdmin || isSelf
    || hasPermission(user, [PERMS.EMPLOYEES_VIEW, PERMS.EMPLOYEES_VIEW_FULL, PERMS.EMPLOYEES_EDIT])
  if (!canOpen) redirect('/dashboard')

  const canSeePay = !user || isAdmin || isSelf || hasPermission(user, PERMS.PAYROLL_VIEW_AMOUNTS)
  const canManageAgreements = hasPermission(user, PERMS.EMPLOYEES_MANAGE_AGREEMENTS)

  const supabase = createTypedAdminClient()
  // Only the columns the profile shows; pay columns only for those who may see pay.
  const cols: string = 'id, name, cqid, role, email, phone, avatar_url' + (canSeePay ? ', salary_type, base_salary' : '')
  const { data: employee } = await supabase
    .from('employees')
    .select(cols)
    .eq('id', id)
    .single()

  if (!employee) notFound()

  const [agreementsRes, clientsRes, servicesRes] = await Promise.all([
    canManageAgreements
      ? supabase.from('employee_commission_agreements').select('*').eq('employee_id', id).order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    supabase.from('clients').select('id, name, is_active').order('name'),
    supabase.from('services').select('id, name, is_active').order('name')
  ])

  return (
    <EmployeeProfileClient
      employee={employee}
      agreements={agreementsRes.data || []}
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      canManageAgreements={canManageAgreements}
      canSeePay={canSeePay}
    />
  )
}
