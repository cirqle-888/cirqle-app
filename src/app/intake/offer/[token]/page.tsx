import { getOfferPageData } from './actions'
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

  // Delegates to the same loader the client used to call for refreshes
  // (getOfferPageData) instead of duplicating the query here — page.tsx had
  // drifted out of sync with it (still selecting the old single `badge` join
  // and no catalog image history), so reloading the page silently dropped a
  // product's badges and "past photos" gallery. One query path now.
  const res = await getOfferPageData(token)
  if (!res.ok || !res.data) {
    return <InvalidLink reason={res.error || 'This link has expired or been revoked. Please ask Cirqle for a new one.'} />
  }

  const { client, campaign, catalog, badges, logoUrl, logoDarkUrl } = res.data

  return (
    <OfferIntakeClient
      token={token}
      client={client}
      campaign={campaign}
      catalog={catalog}
      badges={badges}
      logoUrl={logoDarkUrl || logoUrl}
    />
  )
}
