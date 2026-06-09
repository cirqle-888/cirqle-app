import { redirect, notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import AgreementsClient from './agreements-client'

export const dynamic = 'force-dynamic'

export default async function EmployeeAgreementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const me = await loadCurrentUser().catch(() => null)
  const allowed = (me?.isAdmin ?? true) || !!me?.permissions?.has('employees.manage_agreements')
  if (me && !allowed) redirect('/dashboard')

  const admin = createAdminClient()

  const [empRes, clientsRes, servicesRes, pricingRes] = await Promise.all([
    admin.from('employees').select('id, cqid, name').eq('id', id).single(),
    admin.from('clients').select('id, name, code').eq('is_active', true).order('name'),
    admin.from('services').select('id, name').eq('is_active', true).order('display_order').order('name'),
    admin.from('client_service_pricing').select('client_id, service_id, price, currency'),
  ])
  if (!empRes.data) notFound()

  // Defensive: agreements table may not exist until the migration is applied.
  let agreements: any[] = []
  try {
    const { data, error } = await admin
      .from('employee_commission_agreements')
      .select('*')
      .eq('employee_id', id)
      .order('created_at', { ascending: false })
    if (!error && data) agreements = data
  } catch { /* table missing — show empty + setup hint */ }

  return (
    <AgreementsClient
      employee={empRes.data}
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      pricing={pricingRes.data || []}
      initialAgreements={agreements}
    />
  )
}
