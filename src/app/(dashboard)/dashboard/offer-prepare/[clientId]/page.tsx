import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getOfferPageData } from '@/app/intake/offer/[token]/actions'
import OfferIntakeClient from '@/app/intake/offer/[token]/offer-intake-client'

export const dynamic = 'force-dynamic'

/**
 * Internal offer preparation for one client. Resolves the client's intake
 * token server-side and renders the SAME OfferIntakeClient the public
 * tokenized page uses — one form, two entrances. All server actions it calls
 * are token-gated, so reuse is safe without any new mutation paths.
 */
export default async function OfferPrepareForClientPage({ params }: {
  params: Promise<{ clientId: string }>
}) {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) redirect('/login')

  const { clientId } = await params
  const admin = createAdminClient()
  const { data: client } = await admin
    .from('clients')
    .select('id, name, offer_intake_token')
    .eq('id', clientId)
    .eq('is_active', true)
    .maybeSingle()

  if (!client?.offer_intake_token) notFound()

  const res = await getOfferPageData(client.offer_intake_token)
  if (!res.ok || !res.data) notFound()

  const { campaign, catalog, badges, logoUrl, logoDarkUrl } = res.data

  return (
    <div>
      <div className="bg-[#0f0f1a] border-b border-white/10 px-4 py-2.5 flex items-center gap-3 sticky top-0 z-40">
        <Link
          href="/dashboard/offer-prepare"
          className="flex items-center gap-1.5 text-xs font-medium text-white/50 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> All clients
        </Link>
        <span className="text-white/20">·</span>
        <span className="text-xs text-white/70 font-medium truncate">Preparing offer for {client.name}</span>
      </div>
      <OfferIntakeClient
        token={client.offer_intake_token}
        client={{ id: client.id, name: client.name }}
        campaign={campaign}
        catalog={catalog}
        badges={badges}
        logoUrl={logoDarkUrl || logoUrl}
      />
    </div>
  )
}
