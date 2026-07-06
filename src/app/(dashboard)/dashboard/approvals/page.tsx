import { redirect } from 'next/navigation'
import { loadCurrentUser } from '@/lib/permissions/check'
import { ApprovalsClient } from './approvals-client'

export const dynamic = 'force-dynamic'

/**
 * Approvals inbox — Awaiting me / My requests (Cirqle Connect Wave B).
 * No permission gate: everyone has their own inbox; eligibility rules are
 * enforced per-row in the server actions.
 */
export default async function ApprovalsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')

  return <ApprovalsClient meId={me.employeeId} />
}
