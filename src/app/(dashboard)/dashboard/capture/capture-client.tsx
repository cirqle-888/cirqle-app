'use client'

/**
 * AI Capture review UI.
 *
 * Paste a snippet (or receive one from the desktop app via the `cirqle:capture`
 * window event), see what the Capture Engine classified it as + the detected
 * client + a prefilled draft, redirect the destination if the AI got it wrong,
 * then commit. The engine never writes on its own — commit is an explicit click.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, Loader2, User, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react'
import { analyzeCapture, analyzeCaptureAs, commitRequestCapture, commitAdvertisingCapture } from './actions'
import type { CaptureInput, CaptureResult, CaptureType } from '@/lib/capture/types'

const TYPE_META: Record<CaptureType, { label: string; color: string }> = {
  request:   { label: 'Request',   color: 'text-violet-600 bg-violet-500/10' },
  offer:     { label: 'Offer',     color: 'text-amber-600 bg-amber-500/10' },
  invoice:   { label: 'Invoice',   color: 'text-emerald-600 bg-emerald-500/10' },
  client:    { label: 'Client',    color: 'text-sky-600 bg-sky-500/10' },
  task:      { label: 'Task',      color: 'text-blue-600 bg-blue-500/10' },
  quotation: { label: 'Quotation', color: 'text-fuchsia-600 bg-fuchsia-500/10' },
  advertising: { label: 'Advertising', color: 'text-pink-600 bg-pink-500/10' },
  unknown:   { label: 'Unknown',   color: 'text-muted-foreground bg-muted' },
}

export default function CaptureClient({ offerMode = false }: { offerMode?: boolean }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CaptureResult | null>(null)
  const [committing, setCommitting] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const buildInput = (): CaptureInput => ({
    source: 'manual_paste',
    kind: 'text',
    payload: text,
    metadata: phone.trim() ? { phone: phone.trim() } : undefined,
  })

  async function analyze() {
    if (!text.trim() || busy) return
    setBusy(true); setDone(null); setResult(null)
    // Offer mode (dedicated flyer designers): every paste IS an offer list —
    // skip classification and parse straight as an Offer, no destination step.
    setResult(offerMode
      ? await analyzeCaptureAs(buildInput(), 'offer')
      : await analyzeCapture(buildInput()))
    setBusy(false)
  }

  async function redirect(type: CaptureType) {
    if (busy) return
    setBusy(true); setDone(null)
    setResult(await analyzeCaptureAs(buildInput(), type))
    setBusy(false)
  }

  async function commit() {
    const draft = result?.draft
    if (!draft || committing) return
    if (draft.type === 'request') {
      setCommitting(true)
      const res = await commitRequestCapture({
        clientId: (draft.fields.clientId as string) || null,
        title: draft.fields.title as string,
        description: draft.fields.description as string,
        serviceId: (draft.fields.serviceId as string) || null,
        dueDate: (draft.fields.dueDate as string) || null,
      })
      setCommitting(false)
      if (res.ok) {
        const ref = res.data?.ref_no ? `REQ-${String(res.data.ref_no).padStart(4, '0')}` : 'Request'
        setDone(`${ref} created in Requests.`)
      } else {
        setResult({ ...result!, ok: false, error: res.error })
      }
    } else if (draft.type === 'advertising') {
      setCommitting(true)
      const res = await commitAdvertisingCapture({
        clientId: (draft.fields.clientId as string) || null,
        campaignName: draft.fields.campaignName as string,
        description: text,
        platform: (draft.fields.platform as string) || null,
        campaignType: (draft.fields.campaignType as string) || null,
        adBudget: (draft.fields.adBudget as number) ?? null,
      })
      setCommitting(false)
      if (res.ok) {
        setDone(`${res.data?.ref ?? 'Request'} created in Requests — start it from Advertising.`)
      } else {
        setResult({ ...result!, ok: false, error: res.error })
      }
    } else {
      // Hand the prefilled draft to the target module and navigate there.
      try { sessionStorage.setItem('cirqle:capture:draft', JSON.stringify(draft)) } catch {}
      router.push(draft.target || '/dashboard')
    }
  }

  // Desktop bridge: the Electron app dispatches captured text here.
  useEffect(() => {
    function onCapture(e: Event) {
      const detail = (e as CustomEvent).detail || {}
      if (typeof detail.text === 'string') setText(detail.text)
      if (typeof detail.phone === 'string') setPhone(detail.phone)
    }
    
    // Check if the event fired before we mounted
    // @ts-ignore
    const pending = window.__pendingCirqleCapture
    if (pending) {
      if (typeof pending.text === 'string') setText(pending.text)
      if (typeof pending.phone === 'string') setPhone(pending.phone)
      // @ts-ignore
      window.__pendingCirqleCapture = null
    }
    window.addEventListener('cirqle:capture', onCapture as EventListener)
    return () => window.removeEventListener('cirqle:capture', onCapture as EventListener)
  }, [])

  const draft = result?.draft
  const cls = result?.classification

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">
      {/* pl-12 on mobile clears the fixed global sidebar hamburger. */}
      <div className="pl-12 md:pl-0">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-500" /> AI Capture
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {offerMode
            ? 'Paste a client’s WhatsApp offer list. Cirqle detects the client and prepares the offer draft — review it, then open it in Prepare Offer.'
            : 'Paste a WhatsApp message, email, product list, or contact. Cirqle detects what it is and the client, then prepares a draft for you to confirm.'}
        </p>
      </div>

      <div className="space-y-3">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={6}
          placeholder="Paste here…"
          className="w-full rounded-lg border border-border bg-card p-3 text-sm outline-none focus:ring-2 focus:ring-violet-500/40 resize-y"
        />
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="Sender phone (optional)"
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/40"
          />
          <button
            onClick={analyze}
            disabled={!text.trim() || busy}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-violet-700"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Analyze
          </button>
        </div>
      </div>

      {done && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {done}
          <button onClick={() => router.push('/dashboard/requests')} className="ml-auto underline">View</button>
        </div>
      )}

      {result && !result.ok && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4" /> {result.error || 'Something went wrong.'}
        </div>
      )}

      {result?.ok && draft && cls && !done && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${TYPE_META[cls.type].color}`}>
              {TYPE_META[cls.type].label}
            </span>
            {cls.type !== 'unknown' && (
              <span className="text-xs text-muted-foreground">{Math.round(cls.confidence * 100)}% confident</span>
            )}
            <span className="ml-auto text-sm font-medium">{draft.summary}</span>
          </div>

          {draft.client ? (
            <div className="flex items-center gap-2 text-sm">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{draft.client.name}</span>
              <span className="text-xs text-muted-foreground">matched by {draft.client.matchedBy}</span>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No existing client matched.</div>
          )}

          <DraftFields type={draft.type} fields={draft.fields} />

          {/* Offer-mode users never re-route — their pastes are always offers. */}
          {!offerMode && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">
                {cls.type === 'unknown' ? 'Choose a destination:' : 'Wrong? Send to:'}
              </span>
              {(result.alternatives || []).filter(t => t !== cls.type).map(t => (
                <button
                  key={t}
                  onClick={() => redirect(t)}
                  disabled={busy}
                  className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {TYPE_META[t].label}
                </button>
              ))}
            </div>
          )}

          {draft.type !== 'unknown' && (
            <div className="flex justify-end">
              <button
                onClick={commit}
                disabled={committing}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-violet-700"
              >
                {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {draft.type === 'request' || draft.type === 'advertising' ? 'Create request' : `Open in ${TYPE_META[draft.type].label}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DraftFields({ type, fields }: { type: CaptureType; fields: Record<string, unknown> }) {
  const rows: [string, string][] = []
  const add = (label: string, v: unknown) => { if (v != null && String(v).trim()) rows.push([label, String(v)]) }

  if (type === 'request' || type === 'task') {
    add('Title', fields.title)
    add('Service', fields.serviceName)
    add('Due', fields.dueDate || fields.date)
  } else if (type === 'advertising') {
    add('Campaign', fields.campaignName)
    add('Platform', fields.platform)
    add('Objective', fields.campaignType)
    add('Budget', fields.adBudget != null ? `₹${Number(fields.adBudget).toLocaleString('en-IN')}` : null)
  } else if (type === 'client') {
    add('Name', fields.name); add('Phone', fields.phone); add('Email', fields.email)
  } else if (type === 'offer') {
    const products = Array.isArray(fields.products) ? fields.products : []
    add('Products', products.map((p: any) => p?.name).filter(Boolean).slice(0, 6).join(', ') + (products.length > 6 ? '…' : ''))
  } else if (type === 'invoice' || type === 'quotation') {
    add('Client', fields.clientName)
  }

  if (!rows.length) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-medium break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
