import { requireAdmin } from '@/lib/permissions/check'
import { redirect } from 'next/navigation'
import Header from '@/components/layout/header'
import { JobsClient } from './jobs-client'
import { fetchJobsSummary, fetchRecentJobs } from './actions'

export const metadata = {
  title: 'Queue Monitoring Dashboard',
}

export default async function AdminJobsPage() {
  // Admin-only — the same check every action on this page makes (actions.ts).
  // It also let in a 'system.manage_jobs' permission, which does not exist.
  const guard = await requireAdmin()
  if (!guard.ok) redirect('/dashboard?error=unauthorized')

  const [summary, jobs] = await Promise.all([
    fetchJobsSummary(),
    fetchRecentJobs()
  ])

  return (
    <>
      <Header title="Queue Monitoring" subtitle="Monitor enterprise background workers, queue depth, and failed jobs." />
      <div className="px-4 sm:px-6 py-6">
        <JobsClient initialSummary={summary} initialJobs={jobs} />
      </div>
    </>
  )
}
