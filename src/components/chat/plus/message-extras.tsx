'use client'

import { useMemo, useState } from 'react'
import { BarChart3, Check, Forward } from 'lucide-react'
import { splitLinks, type LinkPreview } from '@/lib/chat/links'
import { pollTotals, type PollData } from '@/lib/chat/polls'

/** Message text with its links made clickable. */
export function RichText({ text }: { text: string }) {
  const parts = useMemo(() => splitLinks(text), [text])
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {parts.map((p, i) => p.type === 'link'
        ? <a key={i} href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sky-500 underline underline-offset-2 hover:text-sky-400 [overflow-wrap:anywhere]">{p.text}</a>
        : <span key={i}>{p.text}</span>)}
    </p>
  )
}

/** The card under a message that carries a link: site, title, a line of text and the page's picture. */
export function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
  const [imgOk, setImgOk] = useState(true)
  return (
    <a href={preview.url} target="_blank" rel="noopener noreferrer nofollow"
      className="mt-1.5 flex max-w-sm overflow-hidden rounded-xl border border-border bg-muted/40 hover:bg-muted">
      <span className="min-w-0 flex-1 px-3 py-2">
        {preview.site && <span className="block truncate text-[11px] uppercase tracking-wide text-muted-foreground">{preview.site}</span>}
        <span className="line-clamp-2 text-sm font-medium">{preview.title}</span>
        {preview.description && <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{preview.description}</span>}
      </span>
      {preview.image && imgOk && (
        // A third-party picture — loaded straight from its own site, no referrer sent.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)}
          className="h-auto w-24 shrink-0 object-cover" />
      )}
    </a>
  )
}

export function ForwardedTag() {
  return <span className="mb-0.5 flex items-center gap-1 text-[11px] italic text-muted-foreground"><Forward className="h-3 w-3" /> Forwarded</span>
}

/** A poll: tap an option to vote, tap again to take the vote back. Results show to everyone. */
export function PollCard({ poll, meId, onVote, nameOf }: {
  poll: PollData
  meId: string
  onVote: (optionIds: string[]) => void
  nameOf?: (employeeId: string) => string
}) {
  const totals = pollTotals(poll)
  const mine = poll.options.filter(o => (poll.votes[o.id] ?? []).includes(meId)).map(o => o.id)
  const [showWho, setShowWho] = useState(false)
  const toggle = (id: string) => {
    if (poll.multi) onVote(mine.includes(id) ? mine.filter(x => x !== id) : [...mine, id])
    else onVote(mine.includes(id) ? [] : [id])
  }
  return (
    <div className="mt-1 w-full max-w-sm rounded-xl border border-border bg-muted/30 p-3">
      <p className="flex items-start gap-2 text-sm font-semibold"><BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />{poll.question}</p>
      <p className="mb-2 mt-0.5 pl-6 text-[11px] text-muted-foreground">{poll.multi ? 'Choose one or more' : 'Choose one'}</p>
      <div className="space-y-1.5">
        {poll.options.map(o => {
          const n = totals.byOption[o.id] ?? 0
          const chosen = mine.includes(o.id)
          const pct = totals.voters ? Math.round((n / totals.voters) * 100) : 0
          return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)}
              className={`relative block w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition-colors ${chosen ? 'border-violet-500/60' : 'border-border hover:border-foreground/30'}`}>
              <span className="absolute inset-y-0 left-0 bg-violet-500/15 transition-[width] duration-300" style={{ width: `${pct}%` }} />
              <span className="relative flex items-center gap-2">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center border ${poll.multi ? 'rounded' : 'rounded-full'} ${chosen ? 'border-violet-500 bg-violet-500 text-white' : 'border-muted-foreground/50'}`}>
                  {chosen && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 break-words">{o.text}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{n}</span>
              </span>
              {showWho && nameOf && n > 0 && (
                <span className="relative mt-1 block pl-6 text-[11px] text-muted-foreground">{(poll.votes[o.id] ?? []).map(nameOf).join(', ')}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{totals.voters} {totals.voters === 1 ? 'vote' : 'votes'}</span>
        {nameOf && totals.voters > 0 && (
          <button type="button" onClick={() => setShowWho(v => !v)} className="underline underline-offset-2 hover:text-foreground">
            {showWho ? 'Hide who voted' : 'See who voted'}
          </button>
        )}
      </div>
    </div>
  )
}
