import { redirect } from 'next/navigation'
import { getClientHubData } from './actions'
import { intakeKindHref, INTAKE_KIND_PRIORITY } from '@/lib/services/intake'

export const dynamic = 'force-dynamic'

function InvalidLink({ reason }: { reason: string }) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-[#0f0f1a] text-white">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-4">🔗</div>
        <h1 className="text-lg font-semibold mb-2">Link unavailable</h1>
        <p className="text-sm text-white/50">{reason}</p>
      </div>
    </div>
  )
}

export default async function ClientHubPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const res = await getClientHubData(token)

  if (!res.ok || !res.data) {
    return <InvalidLink reason={res.error || 'This link has expired or been revoked. Please ask Cirqle for a new one.'} />
  }

  const { kinds, requestToken, offerToken } = res.data
  const options = kinds
    .map(k => ({ kind: k, href: intakeKindHref(k, { requestToken, offerToken }) }))
    .filter((o): o is { kind: string; href: string } => !!o.href)

  if (options.length === 0) {
    return <InvalidLink reason="No active intake forms are set up for your account yet. Please contact Cirqle." />
  }

  // Single app → skip straight to the form, no hub context needed.
  if (options.length === 1) {
    redirect(options[0].href)
  }

  // Multiple apps → go straight to the primary one (Offer Intake first for
  // supermarket/retail clients) and pass the hub token along so that form can
  // render a tab switcher to the other app(s), instead of stopping at a menu.
  const primary = options.find(o => o.kind === INTAKE_KIND_PRIORITY[0]) || options[0]
  redirect(`${primary.href}?hub=${token}`)
}
