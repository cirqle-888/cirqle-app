import { redirect } from 'next/navigation'
import { getClientHubData } from './actions'
import { INTAKE_KIND_META } from '@/lib/services/intake'

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

const KIND_ICON: Record<string, string> = {
  request_portal: '📝',
  offer_intake: '🏷️',
}
const KIND_HREF = (kind: string, requestToken: string | null, offerToken: string | null): string | null => {
  if (kind === 'request_portal') return requestToken ? `/intake/${requestToken}` : null
  if (kind === 'offer_intake') return offerToken ? `/intake/offer/${offerToken}` : null
  return null
}

export default async function ClientHubPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const res = await getClientHubData(token)

  if (!res.ok || !res.data) {
    return <InvalidLink reason={res.error || 'This link has expired or been revoked. Please ask Cirqle for a new one.'} />
  }

  const { client, kinds, requestToken, offerToken, logoUrl } = res.data
  const options = kinds
    .map(k => ({ kind: k, href: KIND_HREF(k, requestToken, offerToken) }))
    .filter((o): o is { kind: string; href: string } => !!o.href)

  if (options.length === 0) {
    return <InvalidLink reason="No active intake forms are set up for your account yet. Please contact Cirqle." />
  }

  // Single service → skip the menu entirely, go straight to the form.
  if (options.length === 1) {
    redirect(options[0].href)
  }

  return (
    <div className="min-h-dvh bg-[#0f0f1a] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Cirqle" className="h-10 w-auto max-w-[200px] mx-auto object-contain mb-4" />
          ) : (
            <div className="text-2xl font-extrabold tracking-tight mb-4">cirqle<span className="text-violet-400">.</span></div>
          )}
          <h1 className="text-xl font-bold text-white/90">Welcome, {client.name}</h1>
          <p className="text-sm text-white/40 mt-1">Choose what you'd like to submit</p>
        </div>

        <div className="space-y-3">
          {options.map(({ kind, href }) => {
            const meta = INTAKE_KIND_META[kind]
            return (
              <a
                key={kind}
                href={href}
                className="flex items-center gap-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-violet-500/40 rounded-2xl p-5 transition-all group"
              >
                <div className="text-3xl shrink-0">{KIND_ICON[kind] || '📋'}</div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-sm font-semibold text-white/90 group-hover:text-white">{meta?.label || kind}</h2>
                  <p className="text-xs text-white/40 mt-0.5">{meta?.description}</p>
                </div>
                <div className="text-white/20 group-hover:text-violet-400 transition-colors shrink-0">→</div>
              </a>
            )
          })}
        </div>

        <p className="text-center text-[11px] text-white/20 mt-8">
          Cirqle Design · cirqle.work · This link is private to {client.name}.
        </p>
      </div>
    </div>
  )
}
