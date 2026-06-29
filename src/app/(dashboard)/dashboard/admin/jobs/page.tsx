import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { redirect } from 'next/navigation'
import { JobsClient } from './jobs-client'
import { fetchJobsSummary, fetchRecentJobs } from './actions'

export const metadata = {
  title: 'Queue Monitoring Dashboard',
}

export default async function AdminJobsPage() {
  const user = await loadCurrentUser()
  if (!user || (!user.isAdmin && !hasPermission(user, 'system.manage_jobs' as any))) {
    redirect('/dashboard?error=unauthorized')
  }

  const [summary, jobs] = await Promise.all([
    fetchJobsSummary(),
    fetchRecentJobs()
  ])

  return (
    <div className="flex flex-col gap-6 w-full p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Queue Monitoring</h1>
        <p className="text-muted-foreground">
          Monitor enterprise background workers, queue depth, and failed jobs.
        </p>
      </div>

      <JobsClient initialSummary={summary} initialJobs={jobs} />
    </div>
  )
}
