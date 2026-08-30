'use client'

/**
 * Comment inbox.
 *
 * Built around one question — who is still waiting on us — because that is the
 * only thing that decays. A comment answered a week late is worse than one
 * answered badly, so "Needs reply" is the default filter and age is shown on
 * every thread rather than hidden behind a hover.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { SocialTabs } from '@/components/social-hub/social-tabs'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import {
  MessageCircle, Send, EyeOff, Trash2, Check, Loader2, ExternalLink, RefreshCw, AlertTriangle,
} from 'lucide-react'
import {
  filterThreads, sortThreads, needsReply, isLate, ageInHours, threadSize,
  type InboxComment, type InboxFilter,
} from '@/lib/social-hub/inbox'
import type { InboxPost } from '@/lib/integrations/meta/comments'
import { loadInbox, sendReply, hideComment, removeComment, dismissComment, loadDismissed } from './actions'

interface Account {
  id: string
  platform: 'instagram' | 'facebook_page'
  label: string
  avatar: string | null
  owner: string
}

export default function InboxClient({ accounts, canDelete }: { accounts: Account[]; canDelete: boolean }) {
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [posts, setPosts] = useState<InboxPost[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<InboxFilter>('needs_reply')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, start] = useTransition()
  const [now, setNow] = useState(() => new Date().toISOString())

  const account = accounts.find(a => a.id === accountId) ?? null

  const refresh = useCallback(async (id: string) => {
    if (!id) return
    setLoading(true); setErr(null)
    const [res, dis] = await Promise.all([loadInbox(id), loadDismissed(id)])
    setLoading(false)
    setNow(new Date().toISOString())
    setDismissed(new Set(dis))
    if (!res.ok) { setErr(res.error ?? 'Could not load comments.'); setPosts([]); return }
    setPosts(res.data?.posts ?? [])
  }, [])

  // Comments are read from Meta on demand, so switching account IS a fetch —
  // the setState the rule objects to is the loading flag, which has to be set
  // before the await or the page shows the previous account's comments while
  // the new ones load.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(accountId) }, [accountId, refresh])

  /** Flatten to threads, keeping the post each belongs to for context. */
  const rows = useMemo(() => {
    const out: { post: InboxPost; thread: InboxComment }[] = []
    for (const p of posts) {
      for (const t of sortThreads(filterThreads(p.threads, filter, dismissed))) {
        out.push({ post: p, thread: t })
      }
    }
    return out.sort((a, b) =>
      (b.thread.createdAt || '').localeCompare(a.thread.createdAt || ''))
  }, [posts, filter, dismissed])

  const waitingCount = useMemo(
    () => posts.flatMap(p => p.threads).filter(t => needsReply(t) && !dismissed.has(t.id)).length,
    [posts, dismissed],
  )
  const lateCount = useMemo(
    () => posts.flatMap(p => p.threads).filter(t => needsReply(t) && !dismissed.has(t.id) && isLate(t, now)).length,
    [posts, dismissed, now],
  )

  const doReply = (commentId: string) => start(async () => {
    const res = await sendReply(accountId, commentId, draft)
    if (!res.ok) { toastError('Could not reply', res.error); return }
    success('Reply posted')
    setReplyTo(null); setDraft('')
    await refresh(accountId)
  })

  const doHide = (commentId: string) => start(async () => {
    const res = await hideComment(accountId, commentId, true)
    if (!res.ok) { toastError('Could not hide', res.error); return }
    success('Comment hidden', 'Still visible to whoever wrote it.')
    await refresh(accountId)
  })

  const doDismiss = (commentId: string) => start(async () => {
    const res = await dismissComment(accountId, commentId, true)
    if (!res.ok) { toastError('Could not mark it handled', res.error); return }
    setDismissed(prev => new Set(prev).add(commentId))
  })

  const doDelete = (commentId: string) => start(async () => {
    const res = await removeComment(accountId, commentId)
    if (!res.ok) { toastError('Could not delete', res.error); return }
    success('Comment deleted')
    await refresh(accountId)
  })

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <SocialTabs />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <MessageCircle className="w-5 h-5" /> Comments
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Everything waiting on a reply, across Instagram and Facebook.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh(accountId)} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Accounts */}
      <div className="flex flex-wrap gap-1.5">
        {accounts.map(a => (
          <button
            key={a.id}
            onClick={() => setAccountId(a.id)}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              a.id === accountId
                ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                : 'bg-card border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <PlatformIcon platform={a.platform} className="w-3.5 h-3.5" />
            {a.label}
            <span className="text-[10px] opacity-60">· {a.owner}</span>
          </button>
        ))}
      </div>

      {/* Counts + filter */}
      <div className="flex flex-wrap items-center gap-2">
        {(['needs_reply', 'answered', 'all'] as InboxFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              filter === f
                ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                : 'bg-card border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {f === 'needs_reply' ? `Needs reply${waitingCount ? ` (${waitingCount})` : ''}`
              : f === 'answered' ? 'Handled' : 'All'}
          </button>
        ))}
        {lateCount > 0 && (
          <span className="text-xs px-2.5 py-1.5 rounded-lg border border-red-500/25 bg-red-500/10 text-red-500 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            {lateCount} over a day old
          </span>
        )}
      </div>

      {err && (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-500 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{err}</span>
        </div>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading comments from {account?.label}…
        </p>
      )}

      {!loading && !err && rows.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <Check className="w-8 h-8 text-green-500 mx-auto mb-2" />
          <p className="text-sm font-medium">
            {filter === 'needs_reply' ? 'Nothing waiting on a reply' : 'Nothing here'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {filter === 'needs_reply'
              ? `Every comment on ${account?.label}'s recent posts has been answered or handled.`
              : 'Try another filter.'}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {rows.map(({ post, thread }) => {
          const hours = ageInHours(thread.createdAt, now)
          const late = isLate(thread, now)
          const waiting = needsReply(thread) && !dismissed.has(thread.id)
          return (
            <div key={thread.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-start gap-3">
                {post.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={post.thumbnailUrl} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
                ) : (
                  <span className="w-12 h-12 rounded bg-secondary shrink-0" />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{thread.authorName}</span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded-md border ${
                      late ? 'bg-red-500/15 text-red-500 border-red-500/25'
                        : waiting ? 'bg-amber-500/15 text-amber-500 border-amber-500/25'
                        : 'bg-secondary text-muted-foreground border-border'
                    }`}>
                      {hours < 1 ? 'just now' : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`}
                    </span>
                    {threadSize(thread) > 1 && (
                      <span className="text-[11px] text-muted-foreground">
                        {threadSize(thread)} messages
                      </span>
                    )}
                    {dismissed.has(thread.id) && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground border border-border">
                        Handled
                      </span>
                    )}
                  </div>

                  <p className="text-sm mt-1 whitespace-pre-wrap break-words">{thread.text || <em className="text-muted-foreground">no text</em>}</p>

                  {thread.replies.length > 0 && (
                    <div className="mt-2 pl-3 border-l-2 border-border space-y-1.5">
                      {thread.replies.map(r => (
                        <div key={r.id} className="text-xs">
                          <span className={`font-medium ${r.isOurs ? 'text-primary' : ''}`}>
                            {r.isOurs ? 'You' : r.authorName}
                          </span>
                          <span className="text-muted-foreground"> · {r.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {replyTo === thread.id ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        rows={2}
                        autoFocus
                        placeholder={`Reply to ${thread.authorName}…`}
                        className="w-full text-sm bg-secondary/50 border border-border rounded-lg p-2.5 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => doReply(thread.id)} disabled={pending || !draft.trim()}>
                          {pending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
                          Reply
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setReplyTo(null); setDraft('') }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => { setReplyTo(thread.id); setDraft('') }}>
                        <Send className="w-3.5 h-3.5 mr-1.5" /> Reply
                      </Button>
                      {waiting && (
                        <Button size="sm" variant="ghost" onClick={() => doDismiss(thread.id)} disabled={pending}>
                          <Check className="w-3.5 h-3.5 mr-1.5" /> No reply needed
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => doHide(thread.id)} disabled={pending} title="Hidden comments stay visible to their author">
                        <EyeOff className="w-3.5 h-3.5 mr-1.5" /> Hide
                      </Button>
                      {canDelete && (
                        <Button size="sm" variant="ghost" onClick={() => doDelete(thread.id)} disabled={pending}
                          className="text-destructive hover:text-destructive">
                          <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete
                        </Button>
                      )}
                      {post.permalink && (
                        <a href={post.permalink} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 ml-auto">
                          <ExternalLink className="w-3 h-3" /> post
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
