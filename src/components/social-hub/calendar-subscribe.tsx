'use client'

/**
 * "Put my posting times on my phone."
 *
 * This is the whole answer to posts being missed, so it is a button on the
 * page people already live on rather than something buried in settings.
 *
 * What it hands over is a subscription URL, not a downloaded file. The
 * difference matters and is the reason webcal:// is offered first: a
 * downloaded .ics is a snapshot of today that never changes again, while a
 * subscription re-fetches on its own and carries every edit, cancellation and
 * new post with it. Somebody who downloads the file once will be reminded
 * about posts that moved three weeks ago.
 *
 * The URL is a bearer credential — a calendar client sends no cookie — so the
 * copy says so plainly, and revoking is one click away rather than a support
 * request.
 */

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { CalendarPlus, Copy, Check, Loader2, ShieldAlert, X } from 'lucide-react'

export interface CalendarFeedInfo {
  webcalUrl: string
  httpsUrl: string
  existing: boolean
}

interface Props {
  /** Server action: mints on first use, returns the existing URL after that. */
  load: () => Promise<{ ok: boolean; error?: string; data?: CalendarFeedInfo }>
  revoke: () => Promise<{ ok: boolean; error?: string }>
}

export function CalendarSubscribe({ load, revoke }: Props) {
  const [open, setOpen] = useState(false)
  const [feed, setFeed] = useState<CalendarFeedInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'webcal' | 'https' | null>(null)
  const [pending, start] = useTransition()

  function openPanel() {
    setOpen(true)
    if (feed) return
    start(async () => {
      const res = await load()
      if (res.ok && res.data) { setFeed(res.data); setError(null) }
      else setError(res.error ?? 'Could not create the calendar link.')
    })
  }

  function copy(which: 'webcal' | 'https') {
    const value = which === 'webcal' ? feed?.webcalUrl : feed?.httpsUrl
    if (!value) return
    navigator.clipboard.writeText(value).then(
      () => { setCopied(which); setTimeout(() => setCopied(null), 2000) },
      () => setError('Could not copy — select the link and copy it manually.'),
    )
  }

  function doRevoke() {
    start(async () => {
      const res = await revoke()
      if (res.ok) { setFeed(null); setOpen(false); setError(null) }
      else setError(res.error ?? 'Could not revoke the link.')
    })
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={openPanel} className="gap-1.5">
        <CalendarPlus className="w-4 h-4" />
        Remind me on my phone
      </Button>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3 sm:p-4 w-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Posting times on your phone</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Subscribe once. Every planned post appears in your calendar and alerts you
            15 minutes before it is due — even with no signal.
          </p>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {pending && !feed && (
        <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Preparing your link…
        </p>
      )}

      {error && (
        <p className="text-xs text-red-400 mt-3">{error}</p>
      )}

      {feed && (
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-xs font-medium mb-1.5">On your phone</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs">
                {feed.webcalUrl}
              </code>
              <Button size="sm" variant="outline" onClick={() => copy('webcal')} className="gap-1 shrink-0">
                {copied === 'webcal' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied === 'webcal' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              <span className="font-medium">iPhone:</span> Settings → Calendar → Accounts → Add Account →
              Other → Add Subscribed Calendar, and paste it.{' '}
              <span className="font-medium">Android:</span> open Google Calendar on a computer →
              Other calendars → From URL.
            </p>
          </div>

          <div>
            <p className="text-xs font-medium mb-1.5">If a calendar refuses that link</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs">
                {feed.httpsUrl}
              </code>
              <Button size="sm" variant="outline" onClick={() => copy('https')} className="gap-1 shrink-0">
                {copied === 'https' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied === 'https' ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5">
            <p className="text-[11px] text-amber-500 flex items-start gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>
                Treat this link like a password — anyone who has it can read your posting
                schedule without signing in. Do not post it in a group chat.
              </span>
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <p className="text-[11px] text-muted-foreground">
              Calendars refresh on their own, usually within an hour.
            </p>
            <Button size="sm" variant="ghost" onClick={doRevoke} disabled={pending} className="text-xs">
              {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Revoke link'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
