'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, Store, ChevronRight, AlertTriangle, DownloadCloud, Loader2, PenTool, FileSpreadsheet } from 'lucide-react'
import Header from '@/components/layout/header'
import { pullFromClientSheet } from './actions'
import { FigmaLink } from '@/components/offer/figma-link'

interface PickerClient {
  id: string
  name: string
  code?: string | null
  hasToken: boolean
  hasWebhook: boolean
  flowMode: 'push' | 'pull' | 'manual'
  hasMasterSheet: boolean
  figmaUrl: string | null
  sheetUrl: string | null
}

export default function OfferPrepareClientPicker({ clients }: { clients: PickerClient[] }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [pulling, setPulling] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    (c.code || '').toLowerCase().includes(q.toLowerCase())
  )

  async function handlePull(client: PickerClient) {
    setPulling(client.id)
    setMsg(null)
    const res = await pullFromClientSheet(client.id)
    setPulling(null)
    if (res.ok && res.data) {
      setMsg({ type: 'ok', text: `Imported ${res.data.imported} products from ${client.name}'s sheet.` })
      router.refresh()
    } else {
      setMsg({ type: 'err', text: res.error || 'Could not read the sheet.' })
    }
  }

  function status(c: PickerClient) {
    if (c.flowMode === 'manual') return <p className="text-xs text-muted-foreground">Manual — no sheet sync</p>
    if (c.flowMode === 'pull') {
      return c.hasMasterSheet
        ? <p className="text-xs text-sky-500">Pull mode — imports from the client&apos;s own sheet</p>
        : <p className="text-xs text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No master sheet linked</p>
    }
    if (!c.hasToken) {
      return <p className="text-xs text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No client link yet — finish setup first</p>
    }
    if (!c.hasWebhook) {
      // Previously a dead end: it named the problem, but the card links to the
      // EDITOR, so following it led somewhere that cannot fix this.
      return (
        <p className="text-xs text-amber-600 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> No Google Sheet connected — offers won&apos;t reach the designer
        </p>
      )
    }
    return <p className="text-xs text-muted-foreground">Ready</p>
  }

  return (
    <div>
      <Header
        title="Offer Intake"
        subtitle="Paste a client's WhatsApp offer list and generate their designer sheet"
      />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search clients…"
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {msg && (
          <div className={`rounded-xl px-3 py-2.5 text-sm ${
            msg.type === 'ok'
              ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-500'
              : 'bg-red-500/10 border border-red-500/25 text-red-500'
          }`}>
            {msg.text}
          </div>
        )}

        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No offer-service clients found.
          </p>
        )}

        {/*
          The card used to be one big <Link>. It now carries its own action
          buttons, and an <a>/<button> cannot legally nest inside an anchor —
          so the link wraps just the name block and the actions sit beside it.
        */}
        <div className="space-y-2">
          {filtered.map(c => (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:border-violet-500/40 transition-colors group"
            >
              <Link
                href={c.hasToken ? `/dashboard/offer-prepare/${c.id}` : '/dashboard/apps/offer-intake'}
                className="flex items-center gap-3 min-w-0 flex-1"
              >
                <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                  <Store className="w-4 h-4 text-violet-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{c.name}</p>
                  {status(c)}
                </div>
              </Link>

              {/* Labelled, not icon-only: a bare glyph in a row of cards reads
                  as decoration and gets missed. */}
              {c.sheetUrl && (
                <a
                  href={c.sheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the Google Sheet"
                  className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Sheet
                </a>
              )}

              {c.figmaUrl && (
                <FigmaLink
                  url={c.figmaUrl}
                  title="Open in the Figma desktop app"
                  className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-violet-500/10 border border-violet-500/25 text-violet-500 hover:bg-violet-500/20 transition-colors"
                >
                  <PenTool className="w-3.5 h-3.5" /> Figma
                </FigmaLink>
              )}

              {c.flowMode === 'pull' && c.hasMasterSheet && (
                <button
                  onClick={() => void handlePull(c)}
                  disabled={pulling === c.id}
                  title="Read the client's Google Sheet into Cirqle (never writes to it)"
                  className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/10 text-sky-500 border border-sky-500/25 hover:bg-sky-500/20 disabled:opacity-40 transition-colors"
                >
                  {pulling === c.id
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Pulling…</>
                    : <><DownloadCloud className="w-3.5 h-3.5" /> Pull</>}
                </button>
              )}

              <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-violet-500 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
