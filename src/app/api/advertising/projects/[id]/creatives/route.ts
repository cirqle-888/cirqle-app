import { NextResponse } from 'next/server'
import { requireReadPermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { getAdInsights } from '@/lib/integrations/meta/ads'
import { decryptToken } from '@/lib/integrations/tokens'
import { resultDefinitionFor } from '@/lib/reporting/result-type'
import { daySpan, isISODate } from '@/lib/reporting/config'
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireReadPermission('advertising.view')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const q = new URL(req.url).searchParams, from = q.get('from'), to = q.get('to')
  if (!isISODate(from) || !isISODate(to) || from > to || daySpan(from, to) > 400) return NextResponse.json({ error: 'Choose a valid period up to 400 days.' }, { status: 400 })
  const { id } = await params
  const { data: project } = await createAdminClient().from('ad_projects').select('campaign_type, provider_metadata, ad_account:ad_accounts(provider, currency, connection:provider_connections(access_token, status))').eq('id', id).is('deleted_at', null).maybeSingle()
  const account = Array.isArray(project?.ad_account) ? project.ad_account[0] : project?.ad_account
  const connection = Array.isArray(account?.connection) ? account.connection[0] : account?.connection
  const campaignId = project?.provider_metadata?.campaign_id
  if (!project || account?.provider !== 'meta' || connection?.status !== 'active' || !/^\d+$/.test(campaignId ?? '')) return NextResponse.json({ error: 'Connect and map an active Meta campaign to inspect creatives.' }, { status: 409 })
  try {
    const token = decryptToken(connection.access_token)
    if (!token) throw new Error('Missing token')
    const rows = await getAdInsights(campaignId, token, from, to)
    const def = resultDefinitionFor(project.campaign_type)
    return NextResponse.json({ currency: account.currency, resultLabel: def.label, costLabel: def.costLabel, from, to, rows: rows.map(row => {
      const count = !row.hasData || !def.metric ? null : row[def.metric]
      return { id: row.id, name: row.name, spend: row.hasData ? row.spend : null, results: count, cost: count && count > 0 ? row.spend / count : null, thumbnail: row.thumbnailUrl, limited: count == null || count < 20 }
    }) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch { return NextResponse.json({ error: 'Creative data is unavailable. Check connection permissions or try again later.' }, { status: 502 }) }
}
