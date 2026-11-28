import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { todayISO } from '@/lib/utils/local-date'
import { loadFeatureUsageInput } from '@/lib/feature-usage/load'
import { buildFeatureUsage } from '@/lib/feature-usage/report'
import FeatureUsageClient from './feature-usage-client'

export const dynamic = 'force-dynamic'

/**
 * Feature Usage — which features nobody (or one person) uses, what each is
 * for, and how to start it. Admin only: it shows every colleague's use, by
 * CQID. `?person=CQID003` narrows it to one person and the features their
 * role allows.
 */
export default async function FeatureUsagePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!me.isAdmin) redirect('/dashboard?denied=1')

  const sp = searchParams ? await searchParams : {}
  const raw = sp.person
  const wanted = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase() || ''

  const today = todayISO()
  const input = await loadFeatureUsageInput(createAdminClient(), today)
  const personId = wanted ? input.people.find(p => p.cqid.toUpperCase() === wanted)?.id ?? null : null
  const report = buildFeatureUsage({ ...input, today, personId })

  return (
    <FeatureUsageClient
      // A new person starts on their own first non-empty tab.
      key={report.person?.cqid ?? 'everyone'}
      report={report}
      trackingReady={input.trackingReady}
      trackingSince={input.trackingSince}
      sources={input.sources}
      warnings={input.warnings}
      myCqid={me.cqid}
    />
  )
}
