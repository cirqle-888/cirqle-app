import { createAdminClient } from '@/lib/supabase/admin'
import IntakeClient from './intake-client'

export const dynamic = 'force-dynamic'

/** External-safe columns only — mirrors EXTERNAL_COLS in actions.ts. */
const EXTERNAL_COLS =
  'id, ref_no, track_token, title, description, remarks, design_plan, priority, due_date, is_planned, ' +
  'client_status, content_link, reference_link, deliverables_link, drive_folder_link, extra_links, created_at'

function InvalidLink({ reason }: { reason: string }) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-4">🔗</div>
        <h1 className="text-lg font-semibold mb-2">Link unavailable</h1>
        <p className="text-sm text-muted-foreground">{reason}</p>
      </div>
    </div>
  )
}

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch {
    return <InvalidLink reason="The portal is not configured yet. Please contact Cirqle." />
  }

  // Resolve the token (defensive: table may not exist pre-migration).
  let link: any = null
  try {
    const { data } = await admin
      .from('intake_links')
      .select('id, type, client_id, agency_id, is_active, expires_at, label, client:clients(name), agency:agencies(name)')
      .eq('token', token)
      .maybeSingle()
    link = data
  } catch { /* fallthrough */ }

  if (!link || !link.is_active) return <InvalidLink reason="This link has expired or been revoked. Please ask Cirqle for a new one." />
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return <InvalidLink reason="This link has expired. Please ask Cirqle for a new one." />
  }

  const requesterName = (link.client?.name as string) || (link.agency?.name as string) || null

  // Their own requests (external-safe fields only) + active services for routing.
  const reqQuery = admin.from('task_requests').select(EXTERNAL_COLS)
  const scoped =
    link.type === 'client' ? reqQuery.eq('client_id', link.client_id)
    : link.type === 'agency' ? reqQuery.eq('agency_id', link.agency_id)
    : reqQuery.eq('link_id', link.id)
  const [requestsRes, servicesRes] = await Promise.all([
    scoped.order('created_at', { ascending: false }).limit(100),
    admin.from('services').select('id, name').eq('is_active', true).order('display_order').order('name'),
  ])

  return (
    <IntakeClient
      token={token}
      linkType={link.type}
      requesterName={requesterName}
      services={servicesRes.data || []}
      initialRequests={requestsRes.data || []}
    />
  )
}
