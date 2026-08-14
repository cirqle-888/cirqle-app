'use client'

/**
 * What the client sees: the planned grid, and two decisions per creative.
 *
 * Written for someone who has never used Cirqle and is looking at this on a
 * phone — no jargon, no internal status vocabulary, no navigation. The grid
 * itself does the explaining, which is the whole reason for previewing a feed
 * as a grid in the first place.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { FeedTile } from '@/lib/social/feed-grid'
import { aspectClass, type FeedAspect } from '@/lib/social/feed-aspect'
import { clientApproveCreative, clientRequestChanges } from './actions'
import { Check, MessageSquare, X, Loader2, Play, CheckCircle2 } from 'lucide-react'

interface Account {
  id: string; name: string; username: string | null
  profile_picture_url: string | null; followers_count: number | null
}

const fmtNum = (n: number | null) => {
  const v = Number(n ?? 0)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toLocaleString('en-IN')
}

const fmtDate = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** Client-facing wording — never the internal status names. */
function clientLabel(status: FeedTile['status']): { text: string; cls: string } | null {
  switch (status) {
    case 'awaiting_approval': return { text: 'Needs your review', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/40' }
    case 'changes_requested': return { text: 'Changes requested', cls: 'bg-red-500/20 text-red-200 border-red-400/40' }
    case 'approved':
    case 'scheduled':         return { text: 'Approved', cls: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40' }
    default:                  return null
  }
}

export default function ClientFeedView({
  token, agencyName, label, account, tiles, plannedCount, publishedCount, aspect,
}: {
  token: string
  agencyName: string
  label: string | null
  account: Account
  tiles: FeedTile[]
  plannedCount: number
  publishedCount: number
  aspect: FeedAspect
}) {
  // Instagram's grid crop is a setting, so the client sees the same shape the
  // agency planned against.
  const tileAspect = aspectClass(aspect)
  const router = useRouter()
  const [open, setOpen] = useState<FeedTile | null>(null)
  const [busy, setBusy] = useState(false)
  const [noteFor, setNoteFor] = useState<FeedTile | null>(null)
  const [note, setNote] = useState('')
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)

  const pendingCount = tiles.filter(t => t.status === 'awaiting_approval').length

  async function approve(t: FeedTile) {
    setBusy(true)
    const res = await clientApproveCreative(token, t.id)
    setBusy(false)
    setFlash(res.ok ? { ok: true, msg: 'Approved — thank you.' } : { ok: false, msg: res.error ?? 'Something went wrong.' })
    if (res.ok) { setOpen(null); router.refresh() }
  }

  async function requestChanges() {
    if (!noteFor) return
    setBusy(true)
    const res = await clientRequestChanges(token, noteFor.id, note)
    setBusy(false)
    if (res.ok) {
      setFlash({ ok: true, msg: 'Sent — the team will take another look.' })
      setNoteFor(null); setNote(''); setOpen(null); router.refresh()
    } else {
      setFlash({ ok: false, msg: res.error ?? 'Something went wrong.' })
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-md mx-auto px-4 py-6 space-y-5">
        {/* Who this is from and what is being asked. */}
        <div className="text-center">
          <p className="text-[11px] text-muted-foreground">{agencyName} · content plan</p>
          <h1 className="text-lg font-semibold mt-0.5">{label || 'Your upcoming feed'}</h1>
          {pendingCount > 0 && (
            <p className="text-xs text-muted-foreground mt-1.5">
              {pendingCount} post{pendingCount === 1 ? '' : 's'} awaiting your review — tap any tile.
            </p>
          )}
        </div>

        {flash && (
          <div className={`rounded-xl px-4 py-2.5 text-xs flex items-center gap-2 ${
            flash.ok ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/25'
                     : 'bg-red-500/10 text-red-600 dark:text-red-300 border border-red-500/25'}`}>
            {flash.ok && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
            <span>{flash.msg}</span>
            <button onClick={() => setFlash(null)} className="ml-auto opacity-60 hover:opacity-100">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Profile mock — the grid only means something in context. */}
        <div className="flex items-center gap-4">
          {account.profile_picture_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={account.profile_picture_url} alt="" className="w-16 h-16 rounded-full object-cover border border-border" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center font-semibold">
              {(account.username ?? account.name).slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">
              {account.username ? `@${account.username}` : account.name}
            </p>
            <div className="flex gap-4 mt-1 text-[11px] text-muted-foreground">
              <span><span className="font-semibold text-foreground tabular-nums">{publishedCount}</span> posts</span>
              <span><span className="font-semibold text-foreground tabular-nums">{fmtNum(account.followers_count)}</span> followers</span>
            </div>
          </div>
        </div>

        {tiles.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-12">
            There is nothing to review just yet.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-0.5">
              {tiles.map((t, i) => {
                const badge = clientLabel(t.status)
                return (
                  <button key={t.key} onClick={() => setOpen(t)}
                    className={`relative ${tileAspect} overflow-hidden bg-secondary group`}>
                    {t.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.imageUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground">
                        Coming soon
                      </span>
                    )}
                    {t.kind === 'planned' && (
                      <span className="absolute inset-0 ring-1 ring-inset ring-violet-500/40 pointer-events-none" />
                    )}
                    {t.isVideo && <Play className="absolute top-1.5 right-1.5 w-3.5 h-3.5 text-white drop-shadow" />}
                    {badge && (
                      <span className={`absolute top-1 left-1 text-[8px] px-1 py-0.5 rounded border leading-none ${badge.cls}`}>
                        {badge.text}
                      </span>
                    )}
                    {fmtDate(t.date) && (
                      <span className="absolute bottom-1 left-1 text-[9px] px-1 py-0.5 rounded bg-black/60 text-white leading-none">
                        {fmtDate(t.date)}
                      </span>
                    )}
                    {/* Where the plan ends and the live account begins. */}
                    {t.kind === 'planned' && i === plannedCount - 1 && publishedCount > 0 && (
                      <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-violet-500/70" />
                    )}
                  </button>
                )
              })}
            </div>
            {plannedCount > 0 && publishedCount > 0 && (
              <p className="text-[10px] text-muted-foreground text-center">
                Everything above the line is new and not yet posted.
              </p>
            )}
          </>
        )}

        <p className="text-[10px] text-muted-foreground text-center pt-2">
          This is a private preview link. Nothing here is live on Instagram yet.
        </p>
      </div>

      {/* ── One creative, up close ── */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setOpen(null)}>
          <div className="bg-card w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl overflow-hidden shadow-2xl max-h-[92dvh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            {open.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={open.imageUrl} alt="" className={`w-full ${tileAspect} object-cover`} />
            )}
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                {clientLabel(open.status) && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${clientLabel(open.status)!.cls}`}>
                    {clientLabel(open.status)!.text}
                  </span>
                )}
                {fmtDate(open.date) && (
                  <span className="text-[11px] text-muted-foreground">Planned for {fmtDate(open.date)}</span>
                )}
                <button onClick={() => setOpen(null)} className="ml-auto text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {open.caption
                ? <p className="text-xs whitespace-pre-wrap leading-relaxed">{open.caption}</p>
                : <p className="text-xs text-muted-foreground italic">No caption yet.</p>}
              {open.hashtags && <p className="text-[11px] text-primary break-words">{open.hashtags}</p>}

              {open.reviewNote && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2">
                  <p className="text-[10px] font-medium text-red-600 dark:text-red-300 mb-0.5">You asked for</p>
                  <p className="text-[11px] text-muted-foreground">{open.reviewNote}</p>
                </div>
              )}

              {/* Only what is genuinely awaiting the client gets buttons. */}
              {['awaiting_approval', 'changes_requested', 'approved'].includes(open.status) && (
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { setNoteFor(open); setNote(open.reviewNote ?? '') }}
                    disabled={busy}
                    className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-2.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50">
                    <MessageSquare className="w-3.5 h-3.5" /> Request changes
                  </button>
                  {open.status !== 'approved' && (
                    <button onClick={() => approve(open)} disabled={busy}
                      className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50">
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Change request ── */}
      {noteFor && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setNoteFor(null)}>
          <div className="bg-card w-full sm:max-w-sm rounded-2xl p-4 shadow-2xl space-y-3"
            onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold">What would you like changed?</p>
            <textarea
              value={note} onChange={e => setNote(e.target.value)} rows={4} autoFocus
              placeholder="e.g. Please make the logo larger and use the darker background."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-none"
            />
            <div className="flex gap-2">
              <button onClick={() => { setNoteFor(null); setNote('') }}
                className="flex-1 text-xs px-3 py-2.5 rounded-lg border border-border hover:bg-secondary transition-colors">
                Cancel
              </button>
              <button onClick={requestChanges} disabled={busy || note.trim().length < 3}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2.5 rounded-lg bg-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50">
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
