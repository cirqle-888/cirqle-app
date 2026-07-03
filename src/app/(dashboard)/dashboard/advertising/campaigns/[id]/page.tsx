import { redirect } from 'next/navigation'

/**
 * Legacy alias — old Low ROAS / High CPC notifications linked to
 * /dashboard/advertising/campaigns/[id], but the campaign detail page lives at
 * /dashboard/advertising/[id]. Kept so historical notification rows keep
 * working; new alerts link to the canonical URL directly.
 */
export default async function LegacyCampaignRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/dashboard/advertising/${id}`)
}
