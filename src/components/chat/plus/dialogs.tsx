'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import {
  X, Search, Check, CheckCheck, Hash, Lock, Star, Pin, Bell, BellOff, AtSign, FileText, Link2,
  Download, Clock, Trash2, Plus, Loader2, BarChart3,
} from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import {
  forwardMessages, listSharedContent, listPinnedMessages, listStarred, listScheduled, cancelScheduled,
  scheduleMessage, createPoll, setConversationNotify, setConversationPinned,
  type SavedMessage, type SharedFile, type SharedLink, type ScheduledMessage, type NotifyLevel,
} from '@/app/(dashboard)/dashboard/chat/actions-plus'
import { getReadReceipts, getAttachmentUrl, listClientsForChat, type ChatConversation, type ChatMessage, type ReadReceiptDetail } from '@/app/(dashboard)/dashboard/chat/actions'
import { createManualRequest } from '@/app/(dashboard)/dashboard/requests/actions'
import { POLL_MAX_OPTIONS } from '@/lib/chat/polls'

type Mask = (name?: string | null, cqid?: string | null) => string

const shell = 'bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full shadow-2xl overflow-hidden flex flex-col min-h-0 max-h-[88dvh]'
const stamp = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

function Head({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="truncate font-semibold">{title}</h2>
        {sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
      <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-4 w-4" /></button>
    </div>
  )
}

// ── Forward ───────────────────────────────────────────────────────────────────

export function ForwardDialog({ messageIds, conversations, nameOf, onClose, onDone }: {
  messageIds: string[]
  conversations: ChatConversation[]
  nameOf: (c: ChatConversation) => string
  onClose: () => void
  onDone: (sent: number, targets: string[]) => void
}) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState('')
  const [pending, start] = useTransition()
  const options = useMemo(() => conversations
    .filter(c => c.isMember && !c.blocked)
    .filter(c => !q.trim() || nameOf(c).toLowerCase().includes(q.trim().toLowerCase())), [conversations, q, nameOf])
  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : p.length >= 10 ? p : [...p, id]))
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`${shell} max-w-md`}>
        <Head title="Forward to…" sub={`${messageIds.length} message${messageIds.length === 1 ? '' : 's'} · up to 10 chats`} onClose={onClose} />
        <div className="shrink-0 px-5 pt-3">
          <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats" className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {options.map(c => (
            <label key={c.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-secondary/60">
              <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} className="h-4 w-4 accent-violet-500" />
              {c.type === 'dm' ? <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{nameOf(c).slice(0, 2).toUpperCase()}</span>
                : c.isPrivate ? <Lock className="h-4 w-4 text-muted-foreground" /> : <Hash className="h-4 w-4 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(c)}</span>
            </label>
          ))}
          {!options.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No chat matches.</p>}
        </div>
        <div className="shrink-0 border-t border-border px-5 py-4">
          {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
          <button disabled={!picked.length || pending}
            onClick={() => start(async () => {
              const res = await forwardMessages(messageIds, picked)
              if (res.ok) onDone(res.data.sent, picked); else setError(res.error)
            })}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg gradient-bg text-sm font-medium text-white disabled:opacity-50">
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Forward{picked.length ? ` to ${picked.length}` : ''}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Message info: who has seen it ─────────────────────────────────────────────

export function MessageInfoDialog({ message, mask, onClose }: { message: ChatMessage; mask: Mask; onClose: () => void }) {
  const [detail, setDetail] = useState<ReadReceiptDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    getReadReceipts(message.id).then(res => { if (!alive) return; if (res.ok) setDetail(res.data); else setError(res.error) })
    return () => { alive = false }
  }, [message.id])
  const person = (p: { employeeId: string; name: string; cqid: string; designation: string | null }, right?: string) => (
    <div key={p.employeeId} className="flex items-center gap-3 py-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[11px] font-medium">{mask(p.name, p.cqid).slice(0, 2).toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{mask(p.name, p.cqid)}</span>
        {p.designation && <span className="block truncate text-xs text-muted-foreground">{p.designation}</span>}
      </span>
      {right && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{right}</span>}
    </div>
  )
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`${shell} max-w-sm`}>
        <Head title="Message info" sub={`Sent ${stamp(message.createdAt)}`} onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <p className="mb-3 line-clamp-3 rounded-lg bg-muted/50 px-3 py-2 text-sm">{message.kind === 'voice' ? 'Voice message' : message.body || 'File'}</p>
          {error && <p className="text-sm text-red-500">{error}</p>}
          {!detail && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
          {detail && (
            <>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-500"><CheckCheck className="h-3.5 w-3.5" /> Seen by {detail.readers.length}</p>
              {detail.readers.length ? detail.readers.map(r => person(r, stamp(r.readAt))) : <p className="py-2 text-sm text-muted-foreground">Nobody yet.</p>}
              {detail.unread.length > 0 && (
                <>
                  <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Check className="h-3.5 w-3.5" /> Not seen yet · {detail.unread.length}</p>
                  <div className="opacity-75">{detail.unread.map(u => person(u))}</div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Chat details: notifications, pinned, media, files, links, scheduled ──────

type Tab = 'about' | 'pinned' | 'media' | 'files' | 'links' | 'scheduled'

export function ChatDetailsDialog({ conversation, title, initialTab = 'about', onClose, onChanged, onJump, onOpenImage }: {
  conversation: ChatConversation
  title: string
  initialTab?: Tab
  onClose: () => void
  /** Pin / notification setting changed — refresh the list. */
  onChanged: (patch: Partial<Pick<ChatConversation, 'pinned' | 'notifyLevel'>>) => void
  onJump: (messageId: string) => void
  onOpenImage: (images: { id: string; url: string; name: string }[], startId: string) => void
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [shared, setShared] = useState<{ media: SharedFile[]; files: SharedFile[]; links: SharedLink[] } | null>(null)
  const [pinned, setPinned] = useState<SavedMessage[] | null>(null)
  const [scheduled, setScheduled] = useState<ScheduledMessage[] | null>(null)
  const [level, setLevel] = useState<NotifyLevel>(conversation.notifyLevel)
  const [isPinned, setIsPinned] = useState(conversation.pinned)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    if ((tab === 'media' || tab === 'files' || tab === 'links') && !shared) {
      listSharedContent(conversation.id).then(r => { if (alive && r.ok) setShared(r.data) })
    }
    if (tab === 'pinned' && !pinned) listPinnedMessages(conversation.id).then(r => { if (alive && r.ok) setPinned(r.data) })
    if (tab === 'scheduled' && !scheduled) listScheduled(conversation.id).then(r => { if (alive && r.ok) setScheduled(r.data) })
    return () => { alive = false }
  }, [tab, conversation.id, shared, pinned, scheduled])

  const setNotify = async (next: NotifyLevel) => {
    const before = level
    setLevel(next); setError('')
    const res = await setConversationNotify(conversation.id, next)
    if (res.ok) onChanged({ notifyLevel: next }); else { setLevel(before); setError(res.error) }
  }
  const togglePinned = async () => {
    const next = !isPinned
    setIsPinned(next); setError('')
    const res = await setConversationPinned(conversation.id, next)
    if (res.ok) onChanged({ pinned: next }); else { setIsPinned(!next); setError(res.error) }
  }
  const openFile = async (f: SharedFile) => {
    const res = await getAttachmentUrl(f.attachmentId)
    if (res.ok) window.open(res.data.url, '_blank', 'noopener,noreferrer')
  }

  const tabs: [Tab, string][] = [['about', 'About'], ['pinned', 'Pinned'], ['media', 'Media'], ['files', 'Files'], ['links', 'Links'], ['scheduled', 'Scheduled']]
  const empty = (text: string) => <p className="py-10 text-center text-sm text-muted-foreground">{text}</p>
  const loading = <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
  const saved = (m: SavedMessage) => (
    <button key={m.id} onClick={() => { onClose(); onJump(m.id) }} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-secondary/60">
      <span className="flex items-center gap-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">{m.senderCqid ?? 'Someone'}</span>{stamp(m.createdAt)}</span>
      <span className="line-clamp-2 text-sm">{m.body}</span>
    </button>
  )
  const notifyOptions: { key: NotifyLevel; label: string; sub: string; Icon: typeof Bell }[] = [
    { key: 'all', label: 'All messages', sub: 'Every new message alerts you', Icon: Bell },
    { key: 'mentions', label: 'Mentions only', sub: 'Only when someone @mentions you', Icon: AtSign },
    { key: 'none', label: 'Muted', sub: 'No alerts — unread counts still show', Icon: BellOff },
  ]

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`${shell} max-w-lg sm:h-[34rem]`}>
        <Head title={title} sub={`${conversation.members.length} member${conversation.members.length === 1 ? '' : 's'}`} onClose={onClose} />
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${tab === k ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
          {tab === 'about' && (
            <div className="space-y-4">
              {conversation.topic && <p className="text-sm text-muted-foreground">{conversation.topic}</p>}
              <button onClick={togglePinned} className="flex w-full items-center gap-3 rounded-xl border border-border px-3 py-3 text-left hover:bg-secondary/50">
                <Pin className={`h-4 w-4 ${isPinned ? 'fill-current text-violet-500' : 'text-muted-foreground'}`} />
                <span className="flex-1 text-sm">{isPinned ? 'Pinned to the top of your list' : 'Pin to the top of your list'}</span>
                <span className="text-xs text-muted-foreground">{isPinned ? 'Unpin' : 'Pin'}</span>
              </button>
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notifications</p>
                <div className="overflow-hidden rounded-xl border border-border">
                  {notifyOptions.map(o => (
                    <button key={o.key} onClick={() => setNotify(o.key)} className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-secondary/50">
                      <o.Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="flex-1"><span className="block text-sm">{o.label}</span><span className="block text-xs text-muted-foreground">{o.sub}</span></span>
                      {level === o.key && <Check className="h-4 w-4 text-violet-500" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {tab === 'pinned' && (!pinned ? loading : pinned.length ? pinned.map(saved) : empty('No pinned messages. Press and hold a message to pin it.'))}
          {tab === 'media' && (!shared ? loading : shared.media.length ? (
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {shared.media.filter(m => m.url).map(m => (
                <button key={m.attachmentId} className="aspect-square overflow-hidden rounded-lg bg-muted"
                  onClick={() => onOpenImage(shared.media.filter(x => x.url).map(x => ({ id: x.attachmentId, url: x.url!, name: x.fileName })), m.attachmentId)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.url!} alt={m.fileName} loading="lazy" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : empty('No pictures shared here yet.'))}
          {tab === 'files' && (!shared ? loading : shared.files.length ? shared.files.map(f => (
            <button key={f.attachmentId} onClick={() => openFile(f)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-secondary/60">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{f.fileName}</span><span className="block text-xs text-muted-foreground">{f.senderCqid ?? ''} · {stamp(f.createdAt)}</span></span>
              <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          )) : empty('No files shared here yet.'))}
          {tab === 'links' && (!shared ? loading : shared.links.length ? shared.links.map((l, i) => (
            <a key={`${l.messageId}-${i}`} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-secondary/60">
              <Link2 className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{l.title ?? l.url}</span><span className="block truncate text-xs text-muted-foreground">{l.title ? l.url : `${l.senderCqid ?? ''} · ${stamp(l.createdAt)}`}</span></span>
            </a>
          )) : empty('No links shared here yet.'))}
          {tab === 'scheduled' && (!scheduled ? loading : scheduled.length ? scheduled.map(s => (
            <div key={s.id} className="flex items-start gap-3 rounded-lg px-2 py-2">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{stamp(s.sendAt)}</span><span className="line-clamp-3 text-sm">{s.body}</span></span>
              <button aria-label="Cancel this scheduled message" className="rounded p-1.5 text-muted-foreground hover:text-red-500"
                onClick={async () => { const r = await cancelScheduled(s.id); if (r.ok) setScheduled(list => (list ?? []).filter(x => x.id !== s.id)) }}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )) : empty('Nothing scheduled. Write a message and tap the clock to send it later.'))}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Starred, across all my chats ──────────────────────────────────────────────

export function StarredDialog({ convName, onClose, onOpen }: {
  convName: (conversationId: string, fallback: string | null) => string
  onClose: () => void
  onOpen: (conversationId: string, messageId: string) => void
}) {
  const [items, setItems] = useState<SavedMessage[] | null>(null)
  useEffect(() => { let alive = true; listStarred().then(r => { if (alive) setItems(r.ok ? r.data : []) }); return () => { alive = false } }, [])
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`${shell} max-w-md sm:h-[30rem]`}>
        <Head title="Starred messages" sub="Only you can see these" onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {!items ? <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
            : !items.length ? <p className="py-10 text-center text-sm text-muted-foreground">Nothing starred yet. Press and hold a message, then Star.</p>
            : items.map(m => (
              <button key={m.id} onClick={() => { onClose(); onOpen(m.conversationId, m.id) }} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-secondary/60">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                  <span className="font-medium text-foreground">{m.senderCqid ?? 'Someone'}</span>
                  <span className="truncate">{convName(m.conversationId, m.conversationName)}</span>
                  <span className="ml-auto shrink-0">{stamp(m.createdAt)}</span>
                </span>
                <span className="line-clamp-2 text-sm">{m.body}</span>
              </button>
            ))}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Send later ────────────────────────────────────────────────────────────────

function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ScheduleDialog({ conversationId, initialText, onClose, onScheduled }: {
  conversationId: string
  initialText: string
  onClose: () => void
  onScheduled: (s: ScheduledMessage) => void
}) {
  const [text, setText] = useState(initialText)
  const [now] = useState(() => new Date())
  const presets = useMemo(() => {
    const inAnHour = new Date(now.getTime() + 3_600_000)
    const tomorrow9 = new Date(now); tomorrow9.setDate(now.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0)
    const monday9 = new Date(now); monday9.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); monday9.setHours(9, 0, 0, 0)
    return [['In 1 hour', inAnHour], ['Tomorrow 9:00', tomorrow9], ['Monday 9:00', monday9]] as [string, Date][]
  }, [now])
  const [when, setWhen] = useState(() => localInput(presets[1][1]))
  const [error, setError] = useState('')
  const [pending, start] = useTransition()
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`${shell} max-w-md`}>
        <Head title="Send later" sub="It goes out at the time you pick" onClose={onClose} />
        <div className="space-y-3 px-5 py-4">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={3} placeholder="Message"
            className="w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
          <div className="flex flex-wrap gap-2">
            {presets.map(([label, d]) => (
              <button key={label} type="button" onClick={() => setWhen(localInput(d))}
                className={`rounded-full border px-3 py-1 text-xs ${when === localInput(d) ? 'border-violet-500/60 bg-violet-500/15' : 'border-border text-muted-foreground hover:text-foreground'}`}>{label}</button>
            ))}
          </div>
          <input type="datetime-local" value={when} min={localInput(now)} onChange={e => setWhen(e.target.value)}
            className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
          <p className="text-[11px] text-muted-foreground">It is sent at that time while anyone on the team has the app open; otherwise as soon as the next person opens it.</p>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button disabled={!text.trim() || !when || pending}
            onClick={() => start(async () => {
              const res = await scheduleMessage(conversationId, text, new Date(when).toISOString())
              if (res.ok) onScheduled(res.data); else setError(res.error)
            })}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg gradient-bg text-sm font-medium text-white disabled:opacity-50">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />} Schedule
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── New poll ──────────────────────────────────────────────────────────────────

export function PollDialog({ conversationId, onClose, onCreated }: { conversationId: string; onClose: () => void; onCreated: () => void }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const [error, setError] = useState('')
  const [pending, start] = useTransition()
  const field = 'w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40'
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`${shell} max-w-md`}>
        <Head title="New poll" onClose={onClose} />
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask a question" className={field} autoFocus />
          <div className="space-y-2">
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input value={o} onChange={e => setOptions(list => list.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} className={field} />
                {options.length > 2 && (
                  <button aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(list => list.filter((_, j) => j !== i))} className="rounded p-1.5 text-muted-foreground hover:text-red-500"><X className="h-4 w-4" /></button>
                )}
              </div>
            ))}
            {options.length < POLL_MAX_OPTIONS && (
              <button onClick={() => setOptions(list => [...list, ''])} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><Plus className="h-4 w-4" /> Add option</button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={multi} onChange={e => setMulti(e.target.checked)} className="accent-violet-500" /> Allow more than one answer
          </label>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
        <div className="shrink-0 border-t border-border px-5 py-4">
          <button disabled={pending}
            onClick={() => start(async () => {
              const res = await createPoll(conversationId, question, options, multi)
              if (res.ok) onCreated(); else setError(res.error)
            })}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg gradient-bg text-sm font-medium text-white disabled:opacity-50">
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Send poll
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}


// ── Turn a message into a request ─────────────────────────────────────────────

/**
 * "Make this a request": what was said in chat becomes tracked work in
 * Requests, for a client, without retyping it. Shown only to people who can
 * manage requests.
 */
export function RequestFromMessageDialog({ message, senderLabel, defaultClientId, onClose, onCreated }: {
  message: ChatMessage
  senderLabel: string
  defaultClientId: string | null
  onClose: () => void
  onCreated: (title: string) => void
}) {
  const text = message.kind === 'voice' ? (typeof message.metadata.transcript === 'string' ? message.metadata.transcript : '') : message.body
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [clientId, setClientId] = useState(defaultClientId ?? '')
  const [title, setTitle] = useState(() => (text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 80))
  const [details, setDetails] = useState(text)
  const [error, setError] = useState('')
  const [pending, start] = useTransition()
  useEffect(() => { let alive = true; listClientsForChat().then(r => { if (alive && r.ok) setClients(r.data) }); return () => { alive = false } }, [])
  const field = 'w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40'
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`${shell} max-w-md`}>
        <Head title="Make this a request" sub="It lands in Requests, ready to assign" onClose={onClose} />
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <select value={clientId} onChange={e => setClientId(e.target.value)} aria-label="Client" className={field}>
            <option value="">Choose client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className={field} />
          <textarea value={details} onChange={e => setDetails(e.target.value)} rows={5} placeholder="Details" className={`${field} resize-none`} />
          <p className="text-[11px] text-muted-foreground">From chat · {senderLabel} · {stamp(message.createdAt)}</p>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
        <div className="shrink-0 border-t border-border px-5 py-4">
          <button disabled={pending || !clientId || !title.trim()}
            onClick={() => start(async () => {
              const res = await createManualRequest({
                clientId, title,
                description: `${details.trim()}\n\n— From chat, ${senderLabel}, ${stamp(message.createdAt)}`.trim(),
              })
              if (res.ok) onCreated(title.trim()); else setError(res.error ?? 'Could not create the request.')
            })}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg gradient-bg text-sm font-medium text-white disabled:opacity-50">
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Create request
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
