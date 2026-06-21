import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { redirect } from 'next/navigation'
import { getIntakeKindsByClient } from '@/lib/services/intake-server'
import IntakeAppsClient from './intake-apps-client'

export const dynamic = 'force-dynamic'

export default async function IntakeAppsPage() {
  // Route is permission-gated by middleware (/^\/dashboard\/settings/ → settings.access).
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) redirect('/login')

  // Per-intake-kind enabled-client counts, derived from assigned services.
  const kindsByClient = await getIntakeKindsByClient()
  const clientCounts: Record<string, number> = {}
  for (const kinds of kindsByClient.values()) {
    for (const k of kinds) clientCounts[k] = (clientCounts[k] || 0) + 1
  }

  return <IntakeAppsClient clientCounts={clientCounts} />
}
