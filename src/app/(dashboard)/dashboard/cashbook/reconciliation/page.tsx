import { redirect } from 'next/navigation'
import Header from '@/components/layout/header'
import ReconciliationClient from './reconciliation-client'
import { requireAdmin } from '@/lib/permissions/check'

export const metadata = { title: 'Cash Book Checks | Cirqle' }

export default async function ReconciliationPage() {
  // These are destructive repair utilities (orphan hunting, allocation rebuilds),
  // so admin-only rather than a delegable permission. requireAdmin already fails
  // closed on an absent session, which is why the old getSession check is gone.
  const guard = await requireAdmin()
  if (!guard.ok) redirect('/dashboard')

  // "Checks", not "Reconciliation": Bank and Card Statements are the
  // reconciliations; this page hunts for ledger errors.
  return (
    <>
      <Header
        title="Cash Book Checks"
        subtitle="Orphaned payments, balance mismatches and deleted entries"
        crumbLabel="Checks"
      />
      <div className="px-4 pb-24 pt-4 sm:px-6 sm:pt-6 md:pb-8">
        <ReconciliationClient />
      </div>
    </>
  )
}
