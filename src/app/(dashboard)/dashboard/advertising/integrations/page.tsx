import { Suspense } from 'react'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { redirect } from 'next/navigation'
import { IntegrationsClient } from './integrations-client'
import { fetchProviderConnections } from './actions'

import { Skeleton } from '@/components/ui/skeleton'

export const metadata = {
  title: 'Advertising Integrations',
}

interface PageProps {
  searchParams: Promise<{ success?: string; error?: string }>
}

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const user = await loadCurrentUser()
  if (!user || (!user.isAdmin && !hasPermission(user, PERMS.ADVERTISING_MANAGE_PROVIDERS))) {
    redirect('/dashboard?error=unauthorized')
  }

  const params = await searchParams

  return (
    <div className="flex flex-col gap-6 w-full p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Advertising Integrations</h1>
        <p className="text-muted-foreground mt-2">
          Manage connections to external advertising platforms like Meta Ads and Google Ads.
        </p>
      </div>

      <Suspense fallback={<IntegrationsSkeleton />}>
        <IntegrationsLoader oauthSuccess={params.success} oauthError={params.error} />
      </Suspense>
    </div>
  )
}

async function IntegrationsLoader({
  oauthSuccess,
  oauthError,
}: {
  oauthSuccess?: string
  oauthError?: string
}) {
  const connections = await fetchProviderConnections()
  return (
    <IntegrationsClient
      initialConnections={connections}
      oauthSuccess={oauthSuccess}
      oauthError={oauthError}
    />
  )
}

function IntegrationsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="rounded-xl border border-border bg-card">
          <div className="p-6">
            <Skeleton className="h-6 w-24 mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="p-6 pt-0">
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
