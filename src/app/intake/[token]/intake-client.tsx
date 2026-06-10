'use client'

import { useState } from 'react'
import {
  Send, Loader2, CheckCircle2, Plus, X, Link2, ChevronDown, ChevronUp,
  Clock, RefreshCw, MessageSquarePlus, CalendarDays,
} from 'lucide-react'
import { CLIENT_STATUS_LABEL } from '@/lib/requests/core'
import {
  submitIntakeRequest, getExternalTimeline, addRequestLink,
  updateRequestRemarks, submitRevisionRequest, getMyRequests,
  type IntakeSubmitInput,
} from './actions'

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

const STATUS_CLS: Record<string, string> = {
  submitted:           'bg-blue-500/12 text-blue-400 border-blue-500/25',
  under_review:        'bg-amber-500/12 text-amber-400 border-amber-500/25',
  approved:            'bg-violet-500/12 text-violet-300 border-violet-500/25',
  started:             'bg-green-500/12 text-green-400 border-green-500/25',
  in_progress:         'bg-green-500/12 text-green-400 border-green-500/25',
  waiting_for_content: 'bg-orange-500/12 text-orange-400 border-orange-500/25',
  revision_requested:  'bg-pink-500/12 text-pink-400 border-pink-500/25',
  completed:           'bg-emerald-500/12 text-emerald-400 border-emerald-500/25',
  delivered:           'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
}

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const fmtDateTime = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const emptyForm = (): IntakeSubmitInput => ({
  title: '', description: '', remarks: '', design_plan: '', priority: 'normal',
  due_date: null, is_planned: false, content_link: '', reference_link: '',
  extra_links: [], service_id: null, submitter_name: '', submitter_email: '', website: '',
})

/** Human sentence for an external timeline entry. */
function activityText(a: any): string {
  const d = a.detail || {}
  switch (a.action) {
    case 'submitted':          return 'Request submitted'
    case 'status_changed':     return `Status: ${CLIENT_STATUS_LABEL[d.to] || d.to || 'updated'}`
    case 'link_added':         return `Added link — ${d.label || d.url || ''}`
    case 'field_changed':      return d.field === 'remarks' ? 'Updated remarks' : `Updated ${d.field || 'details'}`
    case 'revision_requested': return `Revision requested${d.message ? ` — “${d.message}”` : ''}`
    case 'note':               return d.message || 'Update from Cirqle'
    default:                   return a.action.replace(/_/g, ' ')
  }
}

export default function IntakeClient({
  token, linkType, requesterName, services, initialRequests,
}: {
  token: string
  linkType: 'client' | 'agency' | 'generic'
  requesterName: string | null
  services: { id: string; name: string }[]
  initialRequests: any[]
}) {
  const [tab, setTab] = useState<'submit' | 'track'>('submit')
  const [form, setForm] = useState<IntakeSubmitInput>(emptyForm())
  const [extraLabel, setExtraLabel] = useState('')
  const [extraUrl, setExtraUrl] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sentRef, setSentRef] = useState<string | null>(null)
  const [requests, setRequests] = useState<any[]>(initialRequests)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Record<string, any[]>>({})
  const [actionBox, setActionBox] = useState<{ id: string; kind: 'link' | 'remarks' | 'revision' } | null>(null)
  const [actionText, setActionText] = useState('')
  const [actionUrl, setActionUrl] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  async function refreshRequests() {
    const res = await getMyRequests(token)
    if (res.ok && res.data) setRequests(res.data.rows)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSending(true); setError('')
    const res = await submitIntakeRequest(token, form)
    setSending(false)
    if (res.ok && res.data) {
      setSentRef(res.data.ref)
      setForm(emptyForm())
      void refreshRequests()
    } else setError(res.error || 'Something went wrong. Please try again.')
  }

  async function toggleExpand(id: string) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    if (!timeline[id]) {
      const res = await getExternalTimeline(token, id)
      if (res.ok && res.data) setTimeline(t => ({ ...t, [id]: res.data!.rows }))
    }
  }

  async function runAction() {
    if (!actionBox) return
    setActionBusy(true)
    let res: { ok: boolean; error?: string }
    if (actionBox.kind === 'link') res = await addRequestLink(token, actionBox.id, actionText, actionUrl)
    else if (actionBox.kind === 'remarks') res = await updateRequestRemarks(token, actionBox.id, actionText)
    else res = await submitRevisionRequest(token, actionBox.id, actionText, actionUrl)
    setActionBusy(false)
    if (res.ok) {
      setActionBox(null); setActionText(''); setActionUrl('')
      setTimeline(t => { const n = { ...t }; delete n[actionBox.id]; return n })
      void refreshRequests()
      if (expanded === actionBox.id) {
        const tl = await getExternalTimeline(token, actionBox.id)
        if (tl.ok && tl.data) setTimeline(t => ({ ...t, [actionBox.id]: tl.data!.rows }))
      }
    } else alert(res.error || 'Could not save.')
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12">
      {/* Brand header */}
      <div className="text-center mb-8">
        <div className="text-3xl font-extrabold tracking-tight">cirqle<span className="text-blue-400">.</span></div>
        <div className="text-[10px] tracking-[0.3em] text-muted-foreground uppercase mt-0.5">Design</div>
        <h1 className="text-lg font-bold mt-5">
          {requesterName ? `Welcome, ${requesterName}` : 'Submit a request'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Send us your {linkType === 'agency' ? 'campaign and design requests' : 'design requests'} and track their progress — no login needed.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex bg-secondary rounded-xl p-1 gap-1 mb-6">
        {([['submit', 'New Request'], ['track', `My Requests (${requests.length})`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${tab === k ? 'gradient-bg text-white shadow' : 'text-muted-foreground hover:text-foreground'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── SUBMIT ── */}
      {tab === 'submit' && (
        sentRef ? (
          <div className="bg-card border border-green-500/30 rounded-2xl p-8 text-center">
            <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
            <p className="font-semibold">Request received — {sentRef}</p>
            <p className="text-sm text-muted-foreground mt-1">We&apos;ll review it shortly. Track progress in the My Requests tab.</p>
            <div className="flex gap-3 justify-center mt-5">
              <button onClick={() => setSentRef(null)} className="px-4 py-2 text-sm font-medium rounded-lg bg-secondary hover:bg-secondary/70 transition-colors">Submit another</button>
              <button onClick={() => { setSentRef(null); setTab('track') }} className="px-4 py-2 text-sm font-medium rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity">Track requests</button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl p-5 sm:p-6 space-y-4">
            {/* Honeypot — hidden from humans */}
            <input type="text" value={form.website || ''} onChange={e => setForm(f => ({ ...f, website: e.target.value }))}
              className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" />

            <div>
              <label className={labelCls}>What do you need? *</label>
              <input required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                className={inputCls} placeholder="e.g. Weekend Sale — Offer Flyer" />
            </div>

            <div>
              <label className={labelCls}>Details</label>
              <textarea rows={3} value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className={inputCls + ' resize-none'} placeholder="Describe the work — sizes, formats, text to include…" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Service</label>
                <select value={form.service_id || ''} onChange={e => setForm(f => ({ ...f, service_id: e.target.value || null }))} className={inputCls}>
                  <option value="">Not sure / other</option>
                  {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Priority</label>
                <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value as any }))} className={inputCls}>
                  <option value="low">Low</option><option value="normal">Normal</option>
                  <option value="high">High</option><option value="urgent">Urgent</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Needed by</label>
                <input type="date" value={form.due_date || ''} onChange={e => setForm(f => ({ ...f, due_date: e.target.value || null }))} className={inputCls} />
              </div>
              {linkType === 'agency' && (
                <label className="flex items-center gap-2 text-sm mt-6 cursor-pointer">
                  <input type="checkbox" checked={!!form.is_planned} onChange={e => setForm(f => ({ ...f, is_planned: e.target.checked }))} />
                  This is a planned / future campaign
                </label>
              )}
            </div>

            <div>
              <label className={labelCls}>Design plan / notes</label>
              <textarea rows={2} value={form.design_plan || ''} onChange={e => setForm(f => ({ ...f, design_plan: e.target.value }))}
                className={inputCls + ' resize-none'} placeholder="Style direction, colours, references to follow…" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Content link <span className="text-muted-foreground/60">(Drive, WeTransfer…)</span></label>
                <input value={form.content_link || ''} onChange={e => setForm(f => ({ ...f, content_link: e.target.value }))}
                  className={inputCls} placeholder="https://drive.google.com/…" />
              </div>
              <div>
                <label className={labelCls}>Reference link</label>
                <input value={form.reference_link || ''} onChange={e => setForm(f => ({ ...f, reference_link: e.target.value }))}
                  className={inputCls} placeholder="https://…" />
              </div>
            </div>

            {/* Extra links */}
            {(form.extra_links || []).length > 0 && (
              <div className="space-y-1.5">
                {form.extra_links!.map((l, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs bg-secondary rounded-lg px-3 py-2">
                    <Link2 className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="font-medium shrink-0">{l.label}</span>
                    <span className="text-muted-foreground truncate flex-1">{l.url}</span>
                    <button type="button" onClick={() => setForm(f => ({ ...f, extra_links: f.extra_links!.filter((_, j) => j !== i) }))}
                      className="text-muted-foreground hover:text-red-400"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input value={extraLabel} onChange={e => setExtraLabel(e.target.value)} className={inputCls + ' !w-32'} placeholder="Label" />
              <input value={extraUrl} onChange={e => setExtraUrl(e.target.value)} className={inputCls} placeholder="https://… (more links)" />
              <button type="button" disabled={!extraUrl.trim()}
                onClick={() => { setForm(f => ({ ...f, extra_links: [...(f.extra_links || []), { label: extraLabel || 'Link', url: extraUrl }] })); setExtraLabel(''); setExtraUrl('') }}
                className="px-3 rounded-xl bg-secondary border border-foreground/15 hover:bg-secondary/70 disabled:opacity-40 transition-colors shrink-0">
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {(linkType === 'generic') && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1 border-t border-border">
                <div>
                  <label className={labelCls}>Your name *</label>
                  <input required value={form.submitter_name || ''} onChange={e => setForm(f => ({ ...f, submitter_name: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Your email *</label>
                  <input required type="email" value={form.submitter_email || ''} onChange={e => setForm(f => ({ ...f, submitter_email: e.target.value }))} className={inputCls} placeholder="So we can send you a tracking link" />
                </div>
              </div>
            )}

            {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

            <button type="submit" disabled={sending || !form.title.trim()}
              className="w-full py-3 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2">
              {sending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : <><Send className="w-4 h-4" /> Submit request</>}
            </button>
          </form>
        )
      )}

      {/* ── TRACK ── */}
      {tab === 'track' && (
        <div className="space-y-2.5">
          {requests.length === 0 && (
            <div className="bg-card border border-border rounded-2xl px-6 py-10 text-center text-sm text-muted-foreground">
              No requests yet — submit your first one!
            </div>
          )}
          {requests.map(r => {
            const isOpen = expanded === r.id
            return (
              <div key={r.id} className="bg-card border border-border rounded-2xl overflow-hidden">
                <button onClick={() => toggleExpand(r.id)} className="w-full text-left px-4 py-3.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-mono text-muted-foreground">REQ-{String(r.ref_no).padStart(4, '0')}</span>
                      <p className="text-sm font-semibold truncate">{r.title}</p>
                    </div>
                    <div className="flex items-center gap-2.5 mt-1 text-[11px] text-muted-foreground">
                      {r.due_date && <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />{fmtDate(r.due_date)}</span>}
                      <span>Submitted {fmtDate(r.created_at)}</span>
                    </div>
                  </div>
                  <span className={`text-[11px] px-2.5 py-1 rounded-full border shrink-0 ${STATUS_CLS[r.client_status] || STATUS_CLS.submitted}`}>
                    {CLIENT_STATUS_LABEL[r.client_status] || 'Submitted'}
                  </span>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>

                {isOpen && (
                  <div className="border-t border-border px-4 py-4 space-y-4">
                    {/* Quick actions */}
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => { setActionBox({ id: r.id, kind: 'link' }); setActionText(''); setActionUrl('') }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors flex items-center gap-1.5">
                        <Link2 className="w-3 h-3" /> Add link
                      </button>
                      <button onClick={() => { setActionBox({ id: r.id, kind: 'remarks' }); setActionText(r.remarks || ''); setActionUrl('') }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors flex items-center gap-1.5">
                        <MessageSquarePlus className="w-3 h-3" /> Update remarks
                      </button>
                      <button onClick={() => { setActionBox({ id: r.id, kind: 'revision' }); setActionText(''); setActionUrl('') }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-pink-500/10 text-pink-400 border border-pink-500/25 hover:bg-pink-500/20 transition-colors flex items-center gap-1.5">
                        <RefreshCw className="w-3 h-3" /> Request revision
                      </button>
                    </div>

                    {actionBox !== null && actionBox.id === r.id && (
                      <div className="bg-secondary/60 border border-border rounded-xl p-3 space-y-2">
                        {actionBox.kind === 'link' && (
                          <>
                            <input value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls} placeholder="Label (e.g. New content)" />
                            <input value={actionUrl} onChange={e => setActionUrl(e.target.value)} className={inputCls} placeholder="https://…" />
                          </>
                        )}
                        {actionBox.kind === 'remarks' && (
                          <textarea rows={3} value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls + ' resize-none'} placeholder="Your remarks…" />
                        )}
                        {actionBox.kind === 'revision' && (
                          <>
                            <textarea rows={3} value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls + ' resize-none'} placeholder="What needs to change?" />
                            <input value={actionUrl} onChange={e => setActionUrl(e.target.value)} className={inputCls} placeholder="Reference link (optional)" />
                          </>
                        )}
                        <div className="flex gap-2">
                          <button onClick={() => setActionBox(null)} className="flex-1 text-xs py-2 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors">Cancel</button>
                          <button onClick={runAction} disabled={actionBusy || (actionBox.kind === 'link' ? !actionUrl.trim() : !actionText.trim())}
                            className="flex-1 text-xs py-2 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-1.5">
                            {actionBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Save
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Links on the request */}
                    {(r.content_link || r.reference_link || r.deliverables_link || (r.extra_links || []).length > 0) && (
                      <div className="space-y-1">
                        {r.content_link && <a href={r.content_link} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline truncate">📁 Content — {r.content_link}</a>}
                        {r.reference_link && <a href={r.reference_link} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline truncate">🔍 Reference — {r.reference_link}</a>}
                        {r.deliverables_link && <a href={r.deliverables_link} target="_blank" rel="noreferrer" className="block text-xs text-emerald-400 hover:underline truncate">✅ Deliverables — {r.deliverables_link}</a>}
                        {(r.extra_links || []).map((l: any, i: number) => (
                          <a key={i} href={l.url} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline truncate">🔗 {l.label} — {l.url}</a>
                        ))}
                      </div>
                    )}

                    {/* External timeline */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">Activity</p>
                      <div className="space-y-2">
                        {(timeline[r.id] || []).map(a => (
                          <div key={a.id} className="flex items-start gap-2.5 text-xs">
                            <Clock className="w-3 h-3 text-muted-foreground/50 mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <p className="text-foreground/90">{activityText(a)}</p>
                              <p className="text-[10px] text-muted-foreground/60">{fmtDateTime(a.created_at)}</p>
                            </div>
                          </div>
                        ))}
                        {!timeline[r.id] && <p className="text-xs text-muted-foreground/50">Loading…</p>}
                        {timeline[r.id]?.length === 0 && <p className="text-xs text-muted-foreground/50">No activity yet.</p>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-center text-[11px] text-muted-foreground/50 mt-8">
        Cirqle Design · cirqle.work · This page only shows your own requests.
      </p>
    </div>
  )
}
