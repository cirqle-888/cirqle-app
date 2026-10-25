'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface Progress { status: string; stage?: string; error_message?: string; created_at?: string }
const labels: Record<string, string> = { syncing: 'Syncing the requested reporting period', pending: 'Queued', queued: 'Queued', gathering_data: 'Gathering report data', exporting: 'Creating files', delivery: 'Preparing email', generating: 'Generating report', ready: 'Report ready', partial: 'Some files are ready', failed: 'Report needs attention' }

export function ReportProgress({ reportId, canRetry = false }: { reportId: string; canRetry?: boolean }) {
  const [progress, setProgress] = useState<Progress>({ status: 'pending' })
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [revision, setRevision] = useState(0)
  const router = useRouter()
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    async function poll() {
      try {
        const res = await fetch(`/api/advertising/reports/${reportId}?poll=1`, { cache: 'no-store', signal: controller.signal })
        const value = await res.json()
        if (!res.ok) throw new Error(value.error ?? 'Could not load progress.')
        if (stopped) return
        setProgress(value); setError('')
        if (['ready', 'partial', 'failed'].includes(value.status)) { router.refresh(); return }
        timer = setTimeout(poll, 2500)
      } catch (err) {
        if (stopped) return
        setError(err instanceof Error ? err.message : 'Could not load progress.')
        timer = setTimeout(poll, 10000)
      }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer); controller.abort() }
  }, [reportId, revision, router])
  const canRecover = ['pending', 'generating'].includes(progress.status)
    && !!progress.created_at && Date.now() - Date.parse(progress.created_at) > 5 * 60_000
  async function retry() {
    setRetrying(true); setError('')
    try {
      const res = await fetch(`/api/advertising/reports/${reportId}/retry`, { method: 'POST' })
      const value = await res.json()
      if (!res.ok) throw new Error(value.error)
      setProgress({ status: 'pending' }); setRevision(v => v + 1)
    } catch (err) { setError(err instanceof Error ? err.message : 'Retry failed.') }
    finally { setRetrying(false) }
  }
  return <div className="rounded-lg border p-3 space-y-2 text-sm" role="status" aria-live="polite">
    <p>{labels[progress.stage ?? progress.status] ?? labels[progress.status] ?? 'Preparing report'}</p>
    {progress.error_message && <p className="text-muted-foreground">{progress.error_message}</p>}
    {error && <p className="text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-4">
      {['ready', 'partial'].includes(progress.status) && <Link className="underline" href={`/dashboard/advertising/reports/${reportId}`}>Open report</Link>}
      {canRetry && (['failed', 'partial'].includes(progress.status) || canRecover) && <button type="button" className="underline disabled:opacity-50" onClick={retry} disabled={retrying}>{retrying ? 'Queuing…' : canRecover ? 'Resume interrupted report' : 'Retry missing files'}</button>}
    </div>
  </div>
}
