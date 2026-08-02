import { redirect } from 'next/navigation'
import ReconciliationClient from './reconciliation-client'
import { requireAdmin } from '@/lib/permissions/check'

export const metadata = { title: 'System Reconciliation | Cirqle' }

export default async function ReconciliationPage() {
  // These are destructive repair utilities (orphan hunting, allocation rebuilds),
  // so admin-only rather than a delegable permission. requireAdmin already fails
  // closed on an absent session, which is why the old getSession check is gone.
  const guard = await requireAdmin()
  if (!guard.ok) redirect('/dashboard')

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6 pb-24 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">System Reconciliation</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Admin utilities for identifying orphaned payments and auditing mathematical integrity between cashbook and invoices.
          </p>
        </div>
      </div>
      
      <ReconciliationClient />
    </div>
  )
}
