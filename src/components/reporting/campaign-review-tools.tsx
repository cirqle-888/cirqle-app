'use client'
import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts'
import { todayISO } from '@/lib/utils/local-date'
interface Lead { id: string; status: string; enquiry_quality: string | null; quality_reason: string | null }
interface ReviewData {
  annotations: { id: string; occurred_on: string; kind: string; note: string }[]
  budgets: { id: string; amount: number; currency: string; reason: string; status: string; expires_at: string }[]
  metrics: { metric_date: string; spend: number }[]
  leads: Lead[]; leadsAvailable: boolean; canEdit: boolean; canReviewLeads: boolean; canApprove: boolean
}
export function CampaignReviewTools({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ReviewData | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/advertising/projects/${projectId}/review`, { signal: controller.signal }).then(async res => {
      const json = await res.json(); if (!res.ok) throw new Error(json.error); setData(json)
    }).catch(error => { if (!controller.signal.aborted) setMessage(error.message) })
    return () => controller.abort()
  }, [projectId, revision])
  async function save(body: Record<string, unknown>) {
    setBusy(true); setMessage('')
    try {
      const res = await fetch(`/api/advertising/projects/${projectId}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json(); if (!res.ok) throw new Error(json.error)
      setMessage('Saved.'); setRevision(v => v + 1)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save.') }
    finally { setBusy(false) }
  }
  const field = 'rounded border bg-background p-2 text-sm min-w-0'
  return <section className="rounded-xl border p-4 space-y-5">
    <h2 className="font-semibold">Campaign review</h2>
    <p role="status" className="text-sm text-muted-foreground">{message}</p>
    {data && <>
      <details open className="space-y-3"><summary className="font-medium cursor-pointer">Changes &amp; performance</summary>
        <p className="text-xs text-muted-foreground">Last 90 recorded days. Markers show when changes happened; they do not prove a change caused an outcome.</p>
        {data.metrics.length > 0 && <div className="h-56" aria-label="Spend with campaign change markers"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.metrics}><XAxis dataKey="metric_date" /><YAxis /><Tooltip /><Line dataKey="spend" stroke="#7c3aed" dot={false} />{data.annotations.filter(a => data.metrics.some(m => m.metric_date === a.occurred_on)).map(a => <ReferenceLine key={a.id} x={a.occurred_on} stroke="#f59e0b" label={a.kind} />)}</LineChart></ResponsiveContainer></div>}
        {data.canEdit && <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void save({ action: 'annotation', date: f.get('date'), kind: f.get('kind'), note: f.get('note') }) }}>
          <input className={field} type="date" name="date" aria-label="Change date" required defaultValue={todayISO()} />
          <select className={field} name="kind" aria-label="Change type">{['creative', 'targeting', 'budget', 'note'].map(k => <option key={k}>{k}</option>)}</select>
          <input className={`${field} flex-1`} name="note" aria-label="Change note" placeholder="What changed?" required maxLength={2000} />
          <button disabled={busy} className={field}>Add annotation</button>
        </form>}
        <ul className="space-y-2 text-sm">{data.annotations.map(a => <li key={a.id}><span className="text-muted-foreground">{a.occurred_on} · {a.kind}</span> — {a.note}</li>)}</ul>
      </details>
      <details className="space-y-3"><summary className="font-medium cursor-pointer">Budget requests</summary>
        <p className="text-xs text-muted-foreground">Approval records a decision only. It does not change a live ad budget, allocate funds or record a payment. Requests expire after 7 days.</p>
        {data.canEdit && <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void save({ action: 'budget', amount: Number(f.get('amount')), currency: f.get('currency'), reason: f.get('reason') }) }}>
          <input className={field} name="amount" type="number" min="0.01" step="0.01" required aria-label="Requested amount" />
          <input className={`${field} w-20`} name="currency" required defaultValue="INR" maxLength={3} aria-label="Currency code" />
          <input className={`${field} flex-1`} name="reason" placeholder="Reason for request" aria-label="Reason for budget request" required maxLength={2000} />
          <button disabled={busy} className={field}>Request approval</button>
        </form>}
        {data.budgets.map(b => { const expired = b.status === 'requested' && Date.parse(b.expires_at) <= Date.now(); return <div key={b.id} className="border rounded p-3 text-sm space-y-2"><p>{b.currency} {Number(b.amount).toLocaleString('en-IN')} · {expired ? 'expired' : b.status}</p><p>{b.reason}</p>{data.canApprove && b.status === 'requested' && !expired && <div className="flex gap-2"><button disabled={busy} className={field} onClick={() => save({ action: 'decide', requestId: b.id, status: 'approved' })}>Approve</button><button disabled={busy} className={field} onClick={() => save({ action: 'decide', requestId: b.id, status: 'rejected' })}>Reject</button></div>}</div> })}
      </details>
      <details className="space-y-3"><summary className="font-medium cursor-pointer">Enquiry quality</summary>
        <p className="text-xs text-muted-foreground">{data.leadsAvailable ? `${data.leads.length} linked CRM records shown (up to 100). These are separate from platform lead totals; unlinked enquiries are not included.` : 'CRM lead access is unavailable.'}</p>
        {data.leads.map(lead => <form key={lead.id} className="flex flex-wrap items-center gap-2 border rounded p-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void save({ action: 'lead', leadId: lead.id, status: f.get('status'), quality: f.get('quality'), reason: f.get('reason') }) }}>
          <span className="text-xs">Enquiry {lead.id.slice(0, 8)}</span>
          <select className={field} name="status" aria-label="CRM status" defaultValue={lead.status} disabled={!data.canReviewLeads}>{['new', 'contacted', 'qualified', 'won', 'lost'].map(s => <option key={s}>{s}</option>)}</select>
          <select className={field} name="quality" aria-label="Enquiry quality" defaultValue={lead.enquiry_quality ?? ''} disabled={!data.canReviewLeads} required><option value="">Not reviewed</option><option value="valid">Valid enquiry</option><option value="invalid">Invalid enquiry</option></select>
          <input className={`${field} flex-1`} name="reason" aria-label="Quality reason" placeholder="Reason (optional)" defaultValue={lead.quality_reason ?? ''} maxLength={2000} disabled={!data.canReviewLeads} />
          {data.canReviewLeads && <button disabled={busy} className={field}>Save review</button>}
        </form>)}
      </details>
    </>}
  </section>
}
