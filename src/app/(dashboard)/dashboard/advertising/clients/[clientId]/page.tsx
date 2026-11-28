import { notFound, redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * One client's advertising used to have two homes: this page, and the Ads tab
 * of the Client Marketing Hub — which renders this very workspace
 * (./client-workspace.tsx, loaded by ./_load.ts) under the same permission
 * (advertising.view, marketing/_access.ts). Two copies of one screen, and
 * only one of them showed the client's pages, content and leads beside it.
 *
 * Kept as a redirect so bookmarks and old links land on the hub, on the same
 * inner tab: this page kept its tab in ?tab=, the hub keeps the workspace's
 * in ?ads= (its own ?tab= picks the hub tab). Other parameters (?period=…)
 * carry over unchanged.
 */
export default async function ClientAdsRedirect({ params, searchParams }: {
  params: Promise<{ clientId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { clientId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) notFound()
  const sp = await searchParams
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') q.set(key === 'tab' ? 'ads' : key, value)
  }
  q.set('tab', 'ads')
  redirect(`/dashboard/marketing/${clientId}?${q.toString()}`)
}
