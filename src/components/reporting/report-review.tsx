'use client'
import { useState } from 'react'
import { ReportProgress } from './report-progress'
import type { DeliveryResult } from '@/lib/reporting/types'
import { useRouter } from 'next/navigation'
export function ReportReview({ reportId, reviewStatus, recipients = [], delivery = [], summary = '' }: { reportId: string; reviewStatus: string; recipients?: string[]; delivery?: DeliveryResult[]; summary?: string }) {
  const [message, setMessage] = useState(''), [url, setUrl] = useState(''), [busy, setBusy] = useState(false)
  const [editedSummary, setEditedSummary] = useState(summary), [revisionId, setRevisionId] = useState<string | null>(null)
  const [days, setDays] = useState(7)
  const router = useRouter()
  async function act(action: 'approve' | 'share' | 'revoke') {
    setBusy(true); setMessage('')
    try {
      const res = await fetch(`/api/advertising/reports/${reportId}/${action === 'revoke' ? 'share' : action}`, { method: action === 'revoke' ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: action === 'share' ? JSON.stringify({ days }) : undefined })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      if (data.path) { setUrl(new URL(data.path, window.location.origin).href); setMessage('Read-only link created. Copy it to share manually.') }
      else { setMessage(action === 'revoke' ? 'All links revoked.' : 'Report approved.'); setUrl('') }
      router.refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed.') }
    finally { setBusy(false) }
  }
  async function send(email: string) {
    setBusy(true); setMessage('')
    try {
      const res = await fetch(`/api/advertising/reports/${reportId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error ?? 'Email was not accepted.')
      setMessage('Email accepted by the provider. Delivery is tracked separately.'); router.refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Send failed.') }
    finally { setBusy(false) }
  }
  async function revise() {
    setBusy(true); setMessage('')
    try {
      const res = await fetch(`/api/advertising/reports/${reportId}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: editedSummary }) })
      const json = await res.json(); if (!res.ok) throw new Error(json.error)
      setRevisionId(json.reportId)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Revision failed.') }
    finally { setBusy(false) }
  }
  return <section className="m-4 p-4 rounded-xl border space-y-3">
    <h2 className="font-medium">Review: {reviewStatus}</h2>
    <div className="flex flex-wrap gap-3 text-sm">
      {reviewStatus === 'unreviewed' && <button disabled={busy} className="rounded border px-3 py-2" onClick={() => act('approve')}>Approve this saved report</button>}
      {reviewStatus === 'approved' && <><select aria-label="Link expiry" className="rounded border bg-background p-2" value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select><button disabled={busy} className="rounded border px-3 py-2" onClick={() => act('share')}>Create client link</button></>}
      <button disabled={busy} className="rounded border px-3 py-2" onClick={() => act('revoke')}>Revoke all client links</button>
    </div>
    {reviewStatus !== 'superseded' && <details className="space-y-2"><summary className="cursor-pointer text-sm">Revise summary without changing the saved figures</summary><textarea aria-label="Revised client summary" className="w-full border rounded bg-background p-2 text-sm" rows={5} maxLength={3000} value={editedSummary} onChange={e => setEditedSummary(e.target.value)} /><p className="text-xs text-muted-foreground">This creates a new version. The earlier report and its links are superseded only after the new files are ready. No email is sent.</p><button className="border rounded px-3 py-2 text-sm" disabled={busy || !editedSummary.trim() || editedSummary === summary} onClick={revise}>Approve revision &amp; generate</button></details>}
    {revisionId && <ReportProgress reportId={revisionId} canRetry />}
    {recipients.map(email => { const attempt = delivery.find(d => d.email.toLowerCase() === email.toLowerCase()); return <div key={email} className="flex flex-wrap gap-3 text-sm"><span>{email} · {attempt?.status ?? 'not requested'}</span>{reviewStatus === 'approved' && (!attempt || attempt.status === 'failed') && <button disabled={busy} className="underline" onClick={() => send(email)}>{attempt ? 'Retry email to this recipient' : 'Send email to this recipient'}</button>}</div> })}
    {url && <input aria-label="Client report link" readOnly value={url} onFocus={e => e.target.select()} className="w-full rounded border bg-background p-2 text-sm" />}
    <p role="status" className="text-sm text-muted-foreground">{message || 'Client links show approved performance figures only. They expire and can be revoked.'}</p>
  </section>
}
