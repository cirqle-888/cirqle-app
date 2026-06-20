import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { redirect } from 'next/navigation'
import CampaignsClient from './campaigns-client'

export const dynamic = 'force-dynamic'

export default async function CampaignsPage() {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) redirect('/login')

  const admin = createAdminClient()

  const [campaignsRes, clientsRes] = await Promise.all([
    admin.from('offer_campaigns')
      .select(`
        id, title, status, date_type, offer_date, offer_date_from, offer_date_to,
        sheet_last_synced_at, sheet_sync_error, created_at, updated_at,
        client:clients(id, name),
        products:offer_products(id, name, offer_type, price, mrp, offer_text, image_url, badge:offer_badges(label, color)),
        logs:offer_change_logs(id, log_type, product_name, field, old_value, new_value, note, acknowledged, acknowledged_by, acknowledged_at, created_at)
      `)
      .not('status', 'eq', 'archived')
      .order('updated_at', { ascending: false })
      .limit(100),
    admin.from('clients').select('id, name').eq('is_active', true).order('name'),
  ])

  return (
    <CampaignsClient
      campaigns={campaignsRes.data || []}
      clients={clientsRes.data || []}
    />
  )
}
