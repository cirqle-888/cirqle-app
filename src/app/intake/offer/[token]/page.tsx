import { createAdminClient } from '@/lib/supabase/admin'
import OfferIntakeClient from './offer-intake-client'

export const dynamic = 'force-dynamic'

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

export default async function OfferIntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch {
    return <InvalidLink reason="The portal is not configured yet. Please contact Cirqle." />
  }

  // Resolve token → client
  const { data: client } = await admin
    .from('clients')
    .select('id, name, offer_sheet_webhook_url')
    .eq('offer_intake_token', token)
    .eq('is_active', true)
    .maybeSingle()

  if (!client) return <InvalidLink reason="This link has expired or been revoked. Please ask Cirqle for a new one." />

  // Load all data in parallel
  const [campaignRes, catalogRes, badgesRes, logoRes, logoDarkRes] = await Promise.all([
    admin.from('offer_campaigns')
      .select('*, products:offer_products(*, badge:offer_badges(id, label, color))')
      .eq('client_id', client.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from('client_product_catalog')
      .select('*')
      .eq('client_id', client.id)
      .eq('is_active', true)
      .order('name'),
    admin.from('offer_badges')
      .select('*')
      .eq('is_active', true)
      .order('display_order'),
    admin.from('company_settings').select('value').eq('key', 'logo_url').maybeSingle(),
    admin.from('company_settings').select('value').eq('key', 'logo_url_dark').maybeSingle(),
  ])

  return (
    <OfferIntakeClient
      token={token}
      client={{ id: client.id, name: client.name }}
      campaign={campaignRes.data || null}
      catalog={catalogRes.data || []}
      badges={badgesRes.data || []}
      logoUrl={(logoDarkRes.data?.value as string) || (logoRes.data?.value as string) || null}
    />
  )
}
