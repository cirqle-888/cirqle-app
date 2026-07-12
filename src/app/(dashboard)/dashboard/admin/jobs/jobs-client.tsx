'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { retryJob, cancelJob } from './actions'
import { formatDistanceToNow } from 'date-fns'

export function JobsClient({ initialSummary, initialJobs }: { initialSummary: any, initialJobs: any[] }) {
  const [jobs, setJobs] = useState(initialJobs)
  const [loading, setLoading] = useState<string | null>(null)

  const handleRetry = async (id: string) => {
    setLoading(id)
    try {
      await retryJob(id)
      setJobs(jobs.map(j => j.id === id ? { ...j, status: 'pending' } : j))
    } finally {
      setLoading(null)
    }
  }

  const handleCancel = async (id: string) => {
    setLoading(id)
    try {
      await cancelJob(id)
      setJobs(jobs.map(j => j.id === id ? { ...j, status: 'cancelled' } : j))
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-5">
        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Pending</p>
          <p className="text-2xl font-bold">{initialSummary.pending}</p>
        </div>
        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Running</p>
          <p className="text-2xl font-bold">{initialSummary.running}</p>
        </div>
        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Failed/Retrying</p>
          <p className="text-2xl font-bold">{initialSummary.failed}</p>
        </div>
        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Dead Letter</p>
          <p className="text-2xl font-bold">{initialSummary.dead_letter}</p>
        </div>
        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Completed</p>
          <p className="text-2xl font-bold">{initialSummary.completed}</p>
        </div>
      </div>

      <div className="rounded-md border bg-card text-card-foreground shadow-sm overflow-hidden">
        {/* overflow-x-auto: background-jobs monitor (admin) — 5 columns incl.
            timestamps + action buttons don't fit a phone; scroll within the
            card rather than break the page. */}
        <div className="overflow-x-auto">
        <table className="w-full text-sm text-left min-w-[560px]">
          <thead className="border-b bg-muted/50 font-medium">
            <tr>
              <th className="h-12 px-4 text-muted-foreground">Type</th>
              <th className="h-12 px-4 text-muted-foreground">Status</th>
              <th className="h-12 px-4 text-muted-foreground">Attempts</th>
              <th className="h-12 px-4 text-muted-foreground">Queued</th>
              <th className="h-12 px-4 text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b transition-colors hover:bg-muted/50">
                <td className="p-4 align-middle font-medium">{job.job_type}</td>
                <td className="p-4 align-middle">
                  <Badge variant={job.status === 'failed' || job.status === 'dead_letter' ? 'danger' : job.status === 'completed' ? 'success' : 'default'}>
                    {job.status}
                  </Badge>
                </td>
                <td className="p-4 align-middle">{job.attempts} / {job.max_attempts}</td>
                <td className="p-4 align-middle">{formatDistanceToNow(new Date(job.queued_at), { addSuffix: true })}</td>
                <td className="p-4 align-middle">
                  <div className="flex items-center gap-2">
                    {(job.status === 'failed' || job.status === 'dead_letter' || job.status === 'cancelled') && (
                      <Button size="sm" variant="outline" disabled={loading === job.id} onClick={() => handleRetry(job.id)}>
                        Retry
                      </Button>
                    )}
                    {(job.status === 'pending' || job.status === 'retrying' || job.status === 'waiting' || job.status === 'queued') && (
                      <Button size="sm" variant="outline" disabled={loading === job.id} onClick={() => handleCancel(job.id)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">No jobs found in the queue.</td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
