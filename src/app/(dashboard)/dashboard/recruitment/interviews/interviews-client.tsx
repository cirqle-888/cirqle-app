'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Loader2, CalendarClock } from 'lucide-react'
import { listInterviews, updateInterview } from '@/lib/recruitment/actions'
import type { ApplicationInterviewRow, InterviewStatus } from '@/lib/recruitment/types'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import { useToast, ToastContainer } from '@/components/ui/toast'

const STATUS_STYLE: Record<InterviewStatus, string> = {
  scheduled: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  cancelled: 'bg-foreground/[0.06] text-muted-foreground border-foreground/10',
  no_show: 'bg-red-500/10 text-red-400 border-red-500/20',
}

export default function InterviewsClient({ canEdit }: { canEdit: boolean }) {
  const [interviews, setInterviews] = useState<ApplicationInterviewRow[]>([])
  const [loading, setLoading] = useState(true)
  const [upcomingOnly, setUpcomingOnly] = useState(true)
  const [, startTransition] = useTransition()
  const { toasts, dismiss, error: toastError } = useToast()
  const { revealNames, user } = usePermissions()

  function load() {
    listInterviews({ upcomingOnly }).then(res => {
      if (res.ok) setInterviews(res.data)
      else toastError('Could not load interviews', res.error)
      setLoading(false)
    })
  }
  useEffect(() => { load() }, [upcomingOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Interviews</h1>
          <p className="text-sm text-muted-foreground">Scheduled and past candidate interviews.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={upcomingOnly} onChange={e => setUpcomingOnly(e.target.checked)} />Upcoming only
        </label>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-2">
          {interviews.map(i => (
            <div key={i.id} className="rounded-xl border border-foreground/10 bg-card p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/dashboard/recruitment/applications/${i.applicationId}`} className="text-sm font-semibold text-foreground hover:text-violet-400 truncate block">
                  {i.applicantName} <span className="text-muted-foreground font-normal font-mono text-xs">{i.applicationReference}</span>
                </Link>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                  <CalendarClock className="h-3 w-3" />
                  {new Date(i.scheduledAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {i.interviewer && <> · {displayEmployee(i.interviewer, { revealNames, canReveal: user.isAdmin })}</>}
                </div>
              </div>
              {canEdit ? (
                <select
                  className={`text-xs border rounded-full px-2 py-1 bg-transparent ${STATUS_STYLE[i.status]}`} value={i.status}
                  onChange={e => startTransition(async () => {
                    const res = await updateInterview(i.id, { status: e.target.value as InterviewStatus })
                    if (res.ok) load()
                  })}
                >
                  <option value="scheduled">Scheduled</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="no_show">No Show</option>
                </select>
              ) : (
                <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATUS_STYLE[i.status]}`}>{i.status.replace('_', ' ')}</span>
              )}
            </div>
          ))}
          {interviews.length === 0 && <p className="text-sm text-muted-foreground text-center py-10">No interviews found.</p>}
        </div>
      )}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
