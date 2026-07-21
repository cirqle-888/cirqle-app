import { getLibraryPageData } from './actions'
import { getClientHubData } from '@/app/start/[token]/actions'
import { intakeKindHref, INTAKE_KIND_META } from '@/lib/services/intake'
import LibraryClient from './library-client'

export const dynamic = 'force-dynamic'

function InvalidLink({ reason }: { reason: string }) {
  return (
    <div className="min-h-dvh bg-[#0f0f1a] text-white flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-4">🔗</div>
        <h1 className="text-lg font-semibold mb-2">Link unavailable</h1>
        <p className="text-sm text-white/50">{reason}</p>
      </div>
    </div>
  )
}

export default async function ProductLibraryPage({ params, searchParams }: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ hub?: string }>
}) {
  const { token } = await params
  const { hub } = await searchParams

  // Same loader the client component calls for refreshes — one query path, so
  // a reload can never disagree with what the form already showed.
  const res = await getLibraryPageData(token)
  if (!res.ok || !res.data) {
    return <InvalidLink reason={res.error || 'This link has expired or been revoked. Please ask Cirqle for a new one.'} />
  }

  const { client, items, logoUrl } = res.data

  // Reached via the client's Hub link with more than one app enabled — render a
  // tab switcher to the other app(s) instead of stranding them on this one.
  let switcher: { kind: string; label: string; href: string }[] | undefined
  if (hub) {
    const hubRes = await getClientHubData(hub)
    if (hubRes.ok && hubRes.data && hubRes.data.kinds.length > 1) {
      switcher = hubRes.data.kinds
        .map(k => {
          const href = intakeKindHref(k, hubRes.data!)
          return href ? { kind: k, label: INTAKE_KIND_META[k]?.short || k, href: `${href}?hub=${hub}` } : null
        })
        .filter((o): o is { kind: string; label: string; href: string } => !!o)
    }
  }

  return (
    <LibraryClient
      token={token}
      client={client}
      initialItems={items}
      logoUrl={logoUrl}
      switcher={switcher}
      hub={hub}
    />
  )
}
