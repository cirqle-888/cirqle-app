'use client'

/**
 * Publishing calendar — month / week / list views of social_posts, colour-coded
 * by workflow status, with the composer for create/edit.
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  ChevronLeft, ChevronRight, Plus, CalendarDays, ExternalLink, Trash2, Send, Loader2,
} from 'lucide-react'
import { Composer, type ComposerAccount, type ComposerEmployee, type EditablePost } from './composer'
import type { SocialContentType } from '@/lib/social-hub/validation'
import { deletePost, publishPostNow, deleteFromMeta } from './actions'

interface PostRow {
  id: string; client_id: string; account_id: string; content_type: SocialContentType; status: string
  caption: string | null; hashtags: string | null; first_comment: string | null; link_url: string | null
  media: any[]; cover_url: string | null; share_to_feed: boolean
  scheduled_at: string | null; published_at: string | null; permalink: string | null; publish_error: string | null
  /** Meta's own id. Present only once the post really went out through Cirqle,
   *  which is exactly when deleting it from Meta becomes possible. */
  external_media_id: string | null
  designer_id: string | null; assigned_to: string | null
  account_name: string; account_username: string | null; account_platform: 'facebook_page' | 'instagram'
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  awaiting_approval: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  approved: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  scheduled: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  publishing: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  published: 'bg-green-500/15 text-green-400 border-green-500/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  cancelled: 'bg-gray-500/10 text-gray-500 border-gray-500/20 line-through',
}
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', awaiting_approval: 'Awaiting approval', approved: 'Approved',
  scheduled: 'Scheduled', publishing: 'Publishing', published: 'Published', failed: 'Failed', cancelled: 'Cancelled',
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function postDate(p: PostRow): Date | null {
  const s = p.published_at || p.scheduled_at
  return s ? new Date(s) : null
}

export default function CalendarClient({
  posts, clients, accounts, employees, year, month, clientFilter, canPublish, canApprove,
}: {
  posts: PostRow[]
  clients: { id: string; name: string }[]
  accounts: ComposerAccount[]
  employees: ComposerEmployee[]
  year: number
  month: number // 1-12
  clientFilter: string
  canPublish: boolean
  canApprove: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const toast = useToast()
  const [, startTransition] = useTransition()

  const [view, setView] = useState<'month' | 'list'>('month')
  const [composer, setComposer] = useState<{ post: EditablePost | null; date?: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PostRow | null>(null)
  // Separate state, because removing a LIVE post from Meta is a different and
  // irreversible act from tidying up Cirqle's own record.
  const [unpublishTarget, setUnpublishTarget] = useState<PostRow | null>(null)

  const nav = (deltaMonth: number, client = clientFilter) => {
    const d = new Date(Date.UTC(year, month - 1 + deltaMonth, 1))
    const p = new URLSearchParams()
    p.set('month', `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
    if (client) p.set('client', client)
    router.push(`${pathname}?${p.toString()}`)
  }

  const byDay = useMemo(() => {
    const m = new Map<number, PostRow[]>()
    for (const p of posts) {
      const d = postDate(p)
      if (d && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1) {
        const day = d.getUTCDate()
        const arr = m.get(day) ?? []
        arr.push(p)
        m.set(day, arr)
      }
    }
    return m
  }, [posts, year, month])

  const drafts = useMemo(() => posts.filter((p) => !postDate(p) && ['draft', 'awaiting_approval', 'approved'].includes(p.status)), [posts])

  // Month grid cells (leading blanks + days)
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  const toEditable = (p: PostRow): EditablePost => ({
    id: p.id, client_id: p.client_id, account_id: p.account_id, content_type: p.content_type,
    caption: p.caption, hashtags: p.hashtags, first_comment: p.first_comment, link_url: p.link_url,
    media: (p.media ?? []) as EditablePost['media'], cover_url: p.cover_url, share_to_feed: p.share_to_feed,
    scheduled_at: p.scheduled_at, status: p.status, designer_id: p.designer_id, assigned_to: p.assigned_to,
  })

  const sortedList = useMemo(() => [...posts].sort((a, b) => {
    const da = postDate(a)?.getTime() ?? Infinity
    const db = postDate(b)?.getTime() ?? Infinity
    return da - db
  }), [posts])

  return (
    <>
      <Header
        title="Content calendar"
        subtitle="Schedule and publish to Facebook & Instagram"
        actions={canPublish ? <Button size="sm" onClick={() => setComposer({ post: null })}><Plus className="w-4 h-4 mr-1.5" /> New post</Button> : undefined}
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1400px] mx-auto w-full">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => nav(-1)}><ChevronLeft className="w-4 h-4" /></Button>
            <div className="text-sm font-semibold min-w-[130px] text-center">{MONTHS[month - 1]} {year}</div>
            <Button size="sm" variant="ghost" onClick={() => nav(1)}><ChevronRight className="w-4 h-4" /></Button>
            <Button size="sm" variant="ghost" onClick={() => nav(0 - (month - 1 - new Date().getUTCMonth()) - (year - new Date().getUTCFullYear()) * 12)}>Today</Button>
          </div>
          <div className="flex items-center gap-2">
            <AppSelect value={clientFilter} onChange={(e) => nav(0, e.target.value)} wrapperClassName="w-auto">
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </AppSelect>
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(['month', 'list'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 text-xs font-medium capitalize ${view === v ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}>{v}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Drafts strip */}
        {drafts.length > 0 && (
          <div className="mb-4">
            <div className="text-xs text-muted-foreground mb-1.5">Unscheduled ({drafts.length})</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {drafts.map((p) => (
                <button key={p.id} onClick={() => setComposer({ post: toEditable(p) })} className={`shrink-0 text-left rounded-lg border px-2.5 py-1.5 text-xs ${STATUS_STYLE[p.status]}`}>
                  <div className="flex items-center gap-1.5"><PlatformIcon platform={p.account_platform} className="w-3 h-3" /><span className="font-medium">{STATUS_LABEL[p.status]}</span></div>
                  <div className="truncate max-w-[160px] opacity-80 mt-0.5">{p.caption || p.content_type}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {view === 'month' ? (
          <Card>
            <CardContent className="p-2 sm:p-3">
              <div className="grid grid-cols-7 gap-1 mb-1 text-center text-[11px] text-muted-foreground">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((day, i) => (
                  <div key={i} className={`min-h-[92px] rounded-lg border border-border/60 p-1 ${day ? 'bg-card' : 'bg-transparent border-transparent'}`}>
                    {day && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground px-1">{day}</span>
                          {canPublish && (
                            <button onClick={() => setComposer({ post: null, date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` })} className="text-muted-foreground hover:text-primary opacity-0 hover:opacity-100 focus:opacity-100">
                              <Plus className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                        <div className="space-y-1 mt-0.5">
                          {(byDay.get(day) ?? []).slice(0, 4).map((p) => (
                            <button key={p.id} onClick={() => setComposer({ post: toEditable(p) })} className={`w-full text-left rounded px-1.5 py-1 text-[11px] border ${STATUS_STYLE[p.status]}`}>
                              <div className="flex items-center gap-1">
                                <PlatformIcon platform={p.account_platform} className="w-2.5 h-2.5 shrink-0" />
                                <span className="truncate">{p.caption || p.content_type}</span>
                              </div>
                            </button>
                          ))}
                          {(byDay.get(day) ?? []).length > 4 && <div className="text-[10px] text-muted-foreground px-1">+{(byDay.get(day) ?? []).length - 4} more</div>}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              {sortedList.length === 0 ? (
                <EmptyState icon={CalendarDays} title="No posts this month" body="Create a post and schedule it, or publish immediately. Scheduled posts publish automatically at their time." action={canPublish ? { label: 'New post', onClick: () => setComposer({ post: null }) } : undefined} />
              ) : (
                <div className="divide-y divide-border">
                  {sortedList.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-secondary/40">
                      <PlatformIcon platform={p.account_platform} className="w-4 h-4 shrink-0" />
                      <button onClick={() => setComposer({ post: toEditable(p) })} className="flex-1 min-w-0 text-left">
                        <div className="text-sm truncate">{p.caption || `${p.content_type} post`}</div>
                        <div className="text-xs text-muted-foreground">{p.account_name} · {postDate(p) ? postDate(p)!.toLocaleString('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Unscheduled'}{p.publish_error ? ` · ${p.publish_error}` : ''}</div>
                      </button>
                      <span className={`shrink-0 text-xs px-2 py-0.5 rounded-md border ${STATUS_STYLE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                      {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary"><ExternalLink className="w-3.5 h-3.5" /></a>}
                      {canApprove && (p.status === 'failed' || p.status === 'approved') && (
                        <button title="Publish now" onClick={() => startTransition(async () => { const r = await publishPostNow(p.id); if (r.ok) { toast.success('Published'); router.refresh() } else toast.error('Publish failed', r.error) })} className="text-muted-foreground hover:text-primary"><Send className="w-3.5 h-3.5" /></button>
                      )}
                      {canPublish && p.status !== 'published' && (
                        <button title="Delete" onClick={() => setDeleteTarget(p)} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                      )}
                      {/* Live on Meta — a different, irreversible action, and
                          gated on approve rather than publish. */}
                      {canApprove && p.status === 'published' && p.external_media_id && (
                        <button
                          title="Delete from Instagram/Facebook"
                          onClick={() => setUnpublishTarget(p)}
                          className="text-muted-foreground hover:text-red-500"
                        >
                          <Trash2 className="w-3.5 h-3.5" strokeWidth={2.5} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Legend */}
        <div className="flex flex-wrap gap-2 mt-3">
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <span key={k} className={`text-[11px] px-2 py-0.5 rounded-md border ${STATUS_STYLE[k]}`}>{v}</span>
          ))}
        </div>

        <div className="mt-4 text-xs text-muted-foreground">
          <Link href="/dashboard/social" className="text-primary hover:underline">← Social hub</Link>
        </div>
      </div>

      {composer && (
        <Composer
          post={composer.post}
          clients={clients}
          accounts={accounts}
          employees={employees}
          canApprove={canApprove}
          defaultClientId={clientFilter || undefined}
          defaultDate={composer.date}
          onClose={() => setComposer(null)}
          onSaved={() => { setComposer(null); router.refresh() }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this post?"
          body="The draft/scheduled post is removed. Already-published content on Meta is unaffected."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const id = deleteTarget.id
            setDeleteTarget(null)
            startTransition(async () => { const r = await deletePost(id); if (r.ok) router.refresh(); else toast.error('Delete failed', r.error) })
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {unpublishTarget && (
        <ConfirmDialog
          title="Delete this from Instagram/Facebook?"
          body={
            'This removes the post from the live account. Its likes, comments and link ' +
            'are deleted with it and Meta offers no undo — reposting creates a new post ' +
            'with a new date. Cirqle cannot bring it back.'
          }
          confirmLabel="Delete from Meta"
          danger
          onConfirm={() => {
            const id = unpublishTarget.id
            setUnpublishTarget(null)
            startTransition(async () => {
              const r = await deleteFromMeta(id)
              if (r.ok) { toast.success('Deleted from Meta'); router.refresh() }
              else toast.error('Could not delete from Meta', r.error)
            })
          }}
          onCancel={() => setUnpublishTarget(null)}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}
