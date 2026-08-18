import { createTypedAdminClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import EmployeeProfileClient from './employee-client'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'

export default async function EmployeeProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = createTypedAdminClient()
  const { id } = await params

  const { data: employee } = await supabase
    .from('employees')
    .select('*')
    .eq('id', id)
    .single()

  if (!employee) notFound()

  // Ensure they have permission to view this page. Basic employee view is generally available,
  // but we can check if they can manage agreements to show that tab.
  const user = await loadCurrentUser()
  const canManageAgreements = hasPermission(user, 'employees.manage_agreements')

  const [agreementsRes, clientsRes, servicesRes] = await Promise.all([
    supabase.from('employee_commission_agreements').select('*').eq('employee_id', id).order('created_at', { ascending: false }),
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
    />
  )
}
