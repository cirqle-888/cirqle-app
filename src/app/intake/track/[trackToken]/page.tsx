import { createAdminClient } from '@/lib/supabase/admin'
import { CLIENT_STATUS_LABEL } from '@/lib/requests/core'
import { columnExists } from '@/lib/supabase/server'
import { isChecklistRequest } from '@/lib/requests/kind'

export const dynamic = 'force-dynamic'

/** Single-request tracking page (per-request token — used by generic submitters
 *  and in status emails). Read-only: external-safe fields + the requester-visible
 *  timeline only. */
export default async function TrackPage({ params }: { params: Promise<{ trackToken: string }> }) {
  const { trackToken } = await params

  let request: any = null
  let timeline: any[] = []
  try {
    const admin = createAdminClient()
    // `kind` is selected only once its migration has run, and a checklist item
    // is internal work: even holding its token must not open a tracking page.
    // Falling through to the not-found view is deliberate — "this link is
    // invalid" is all an outsider should learn.
    const hasKind = await columnExists(admin, 'task_requests', 'kind')
    const cols = 'id, ref_no, source, title, client_status, priority, due_date, created_at, '
      + 'content_link, reference_link, deliverables_link, extra_links'
      + (hasKind ? ', kind' : '')
    const { data } = await admin
      .from('task_requests')
      .select(cols)
      .eq('track_token', trackToken)
      .maybeSingle()
    request = isChecklistRequest(data as { kind?: string | null } | null) ? null : data
    if (request) {
      const vis = request.source === 'agency' ? 'agency' : 'client'
      const { data: acts } = await admin
        .from('request_activity')
        .select('id, action, detail, actor_type, created_at')
        .eq('request_id', request.id)
        .eq('visibility', vis)
        .order('created_at', { ascending: false })
        .limit(100)
      timeline = acts || []
    }
  } catch { /* table missing — fall through to not-found view */ }

  if (!request) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <div className="text-4xl mb-4">🔎</div>
          <h1 className="text-lg font-semibold mb-2">Request not found</h1>
          <p className="text-sm text-muted-foreground">This tracking link is invalid or the request was removed.</p>
        </div>
      </div>
    )
  }

  const ref = `REQ-${String(request.ref_no).padStart(4, '0')}`
  const fmtDT = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  function text(a: any): string {
    const d = a.detail || {}
    switch (a.action) {
      case 'submitted':          return 'Request submitted'
      case 'status_changed':     return `Status: ${CLIENT_STATUS_LABEL[d.to] || d.to || 'updated'}`
      case 'link_added':         return `Added link — ${d.label || ''}`
      case 'field_changed':      return d.field === 'remarks' ? 'Remarks updated' : `Updated ${d.field || 'details'}`
      case 'revision_requested': return 'Revision requested'
      case 'note':               return d.message || 'Update from Cirqle'
      default:                   return String(a.action).replace(/_/g, ' ')
    }
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      <div className="text-center mb-8">
        <div className="text-3xl font-extrabold tracking-tight">cirqle<span className="text-blue-400">.</span></div>
        <div className="text-[10px] tracking-[0.3em] text-muted-foreground uppercase mt-0.5">Design</div>
      </div>

      <div className="bg-card border border-border rounded-2xl p-6">
        <p className="text-[11px] font-mono text-muted-foreground">{ref}</p>
        <h1 className="text-lg font-bold mt-1">{request.title}</h1>
        <div className="mt-3 inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-violet-500/12 text-violet-300 border border-violet-500/25">
          {CLIENT_STATUS_LABEL[request.client_status] || 'Submitted'}
        </div>

        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mt-6 mb-2">Activity</p>
        <div className="space-y-2.5">
          {timeline.length === 0 && <p className="text-xs text-muted-foreground/60">No activity yet.</p>}
          {timeline.map(a => (
            <div key={a.id} className="text-xs">
              <p className="text-foreground/90">{text(a)}</p>
              <p className="text-[10px] text-muted-foreground/60">
                {fmtDT(a.created_at)}
                {(a.actor_type === 'admin' || a.actor_type === 'system') ? ' · from Cirqle' : ''}
              </p>
            </div>
          ))}
        </div>
      </div>

      <p className="text-center text-[11px] text-muted-foreground/50 mt-6">Cirqle Works · cirqle.work</p>
    </div>
  )
}
