import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, Eye, Mic } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient } from '@/lib/supabase/server'
import { listenerEnabled } from '@/lib/whatsapp-listener/rules'
import { loadChatViewer } from '@/lib/whatsapp-listener/insights-run'
import { WhatsAppTabs } from './insights-client'
import {
  CHAT_LOG_TABLE, CHAT_PAGE_SIZE, chatSummaries, groupByDay, isMissingTable, senderLabel,
} from '@/lib/whatsapp-listener/chat-log'

export const dynamic = 'force-dynamic'

/**
 * WhatsApp chats — a read-only view of the conversations the listener reads.
 *
 * Shows what clients and Cirqle wrote in each allow-listed chat, with voice
 * notes and photos, and which request a message became. It never sends
 * anything: replies happen in WhatsApp. A person sees only the chats shared
 * with them (Settings → WhatsApp Listener → who can see); admins see all.
 */

const BUCKET = 'chat-attachments'
const MEDIA_LINK_SECONDS = 60 * 60
const IST = 'Asia/Kolkata'

interface MessageRow {
  id: string; message_id: string; chat_id: string; sender_name: string | null; sender_phone: string | null
  from_cirqle: boolean; type: string; body: string | null; media_path: string | null; media_mime: string | null
  media_note: string | null; request_id: string | null; sent_at: string
  /** What the voice note says / what is written in the photo. Absent before the reports migration. */
  media_text?: string | null
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' })
const dayLabel = (day: string) => new Date(`${day}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const whenShort = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="border border-border rounded-xl bg-card px-4 py-6 text-sm text-muted-foreground">{children}</div>
}

export default async function WhatsAppChatsPage({ searchParams }: { searchParams: Promise<{ chat?: string; before?: string }> }) {
  const admin = createAdminClient()
  const cv = await loadChatViewer(admin)
  if (!cv.me || cv.visible.size === 0 && !cv.me.isAdmin) redirect('/dashboard')

  const { chat: chatParam, before } = await searchParams
  const { settings, names } = cv.ctx
  // Only the chats shared with this person exist as far as this page goes.
  const groups = new Map([...cv.ctx.groups].filter(([id]) => cv.visible.has(id)))
  const recentRes = groups.size
    ? await admin.from(CHAT_LOG_TABLE).select('chat_id, sent_at, type, body, from_cirqle')
      .in('chat_id', [...groups.keys()]).order('sent_at', { ascending: false }).limit(1000)
    : { data: [], error: null }
  const missingTable = isMissingTable(recentRes.error)

  const shell = (body: React.ReactNode) => (
    <div className="min-h-screen">
      <Header title="WhatsApp chats" subtitle="Read-only view of the client chats the listener reads" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-6xl mx-auto mt-2 space-y-4">
        <Link href="/dashboard/requests" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Requests
        </Link>
        <WhatsAppTabs active="chats" />
        {body}
      </div>
    </div>
  )

  if (missingTable) {
    return shell(
      <Notice>
        <p className="font-medium text-foreground">The chat view is not switched on yet.</p>
        <p className="mt-1">It needs one database change: apply <code>supabase/migrations/20261114100000_whatsapp_chat_messages.sql</code>. Requests are still being filed from WhatsApp as before.</p>
      </Notice>,
    )
  }
  if (groups.size === 0) {
    return shell(<Notice>No chats are being read. Add chats in <Link className="underline" href="/dashboard/settings?tab=whatsapp-listener">Settings → WhatsApp Listener</Link>.</Notice>)
  }

  const recent = (recentRes.data || []) as { chat_id: string; sent_at: string; type: string; body: string | null; from_cirqle: boolean }[]
  const chats = chatSummaries(groups, names, recent)
  // Only a chat that is on the allow-list can be opened, whatever the link says.
  const selected = chats.find(c => c.chatId === chatParam) ?? (chatParam ? null : chats.find(c => c.lastAt) ?? null)

  let messages: MessageRow[] = []
  let hasOlder = false
  const mediaUrls = new Map<string, string>()
  const requestRefs = new Map<string, string>()
  if (selected) {
    let q = admin.from(CHAT_LOG_TABLE)
      .select('*')
      .eq('chat_id', selected.chatId).order('sent_at', { ascending: false }).limit(CHAT_PAGE_SIZE + 1)
    if (before && Number.isFinite(Date.parse(before))) q = q.lt('sent_at', new Date(before).toISOString())
    const rows = ((await q).data || []) as MessageRow[]
    hasOlder = rows.length > CHAT_PAGE_SIZE
    messages = rows.slice(0, CHAT_PAGE_SIZE).reverse()

    const paths = messages.map(m => m.media_path).filter((p): p is string => !!p)
    const requestIds = [...new Set(messages.map(m => m.request_id).filter((r): r is string => !!r))]
    const [signed, reqs] = await Promise.all([
      paths.length ? admin.storage.from(BUCKET).createSignedUrls(paths, MEDIA_LINK_SECONDS) : Promise.resolve({ data: [] }),
      requestIds.length ? admin.from('task_requests').select('id, ref_no').in('id', requestIds) : Promise.resolve({ data: [] }),
    ])
    for (const s of signed.data || []) if (s.path && s.signedUrl) mediaUrls.set(s.path, s.signedUrl)
    for (const r of (reqs.data || []) as { id: string; ref_no: number | null }[]) requestRefs.set(r.id, `REQ-${String(r.ref_no ?? 0).padStart(4, '0')}`)
  }

  const days = groupByDay(messages)
  const chatHref = (id: string) => `/dashboard/requests/whatsapp?chat=${encodeURIComponent(id)}`

  return shell(
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground border border-border rounded-lg bg-card px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-foreground font-medium"><Eye className="w-3.5 h-3.5" /> Read-only</span>
        <span>Reply in WhatsApp. Nothing can be sent from here.</span>
        {!listenerEnabled(settings) && <span className="text-amber-500">The listener is switched off, so new messages are not arriving.</span>}
      </div>

      <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
        {/* Chat list. On a phone it hides once a chat is open, like WhatsApp. */}
        <nav aria-label="Chats" className={`border border-border rounded-xl bg-card overflow-hidden self-start ${chatParam && selected ? 'hidden md:block' : ''}`}>
          <ul className="divide-y divide-border max-h-[70vh] overflow-y-auto">
            {chats.map(c => {
              const active = selected?.chatId === c.chatId
              return (
                <li key={c.chatId}>
                  <Link href={chatHref(c.chatId)} aria-current={active ? 'page' : undefined}
                    className={`block px-3 py-2.5 hover:bg-secondary ${active ? 'bg-primary/10' : ''}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`text-sm truncate ${active ? 'text-primary font-medium' : 'text-foreground'}`}>{c.title}</span>
                      {c.lastAt && <span className="text-[10px] text-muted-foreground shrink-0">{whenShort(c.lastAt)}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {c.lastAt ? `${c.lastFromCirqle ? 'Cirqle: ' : ''}${c.lastPreview || '…'}` : 'No messages yet'}
                    </p>
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Thread */}
        <section aria-label="Messages" className={`border border-border rounded-xl bg-card min-w-0 ${chatParam && selected ? '' : 'hidden md:block'}`}>
          {!selected ? (
            <p className="px-4 py-10 text-sm text-muted-foreground text-center">
              {chatParam ? 'This chat is not on the list of chats to read, or it is not shared with you.' : 'No messages have been captured yet. They appear here as they arrive while the listener is running.'}
            </p>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <Link href="/dashboard/requests/whatsapp" className="md:hidden inline-flex items-center gap-1 text-xs text-muted-foreground mb-1">
                    <ArrowLeft className="w-3 h-3" /> All chats
                  </Link>
                  <h2 className="text-sm font-semibold truncate">{selected.title}</h2>
                  <p className="text-xs text-muted-foreground truncate">
                    {[names[selected.chatId] ? `WhatsApp group: ${names[selected.chatId]}` : '', selected.client ? '' : 'No client linked'].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>

              <div className="px-3 sm:px-4 py-4 space-y-4">
                {hasOlder && messages[0] && (
                  <div className="text-center">
                    <Link href={`${chatHref(selected.chatId)}&before=${encodeURIComponent(messages[0].sent_at)}`} className="text-xs text-primary hover:underline">Show older messages</Link>
                  </div>
                )}
                {before && (
                  <div className="text-center">
                    <Link href={chatHref(selected.chatId)} className="text-xs text-primary hover:underline">Back to the latest messages</Link>
                  </div>
                )}
                {messages.length === 0 && (
                  <p className="py-8 text-sm text-muted-foreground text-center">No messages captured in this chat yet.</p>
                )}
                {days.map(d => (
                  <div key={d.day} className="space-y-2">
                    <p className="text-center"><span className="inline-block text-[10px] text-muted-foreground bg-secondary rounded-full px-2.5 py-0.5">{dayLabel(d.day)}</span></p>
                    {d.messages.map(m => {
                      const url = m.media_path ? mediaUrls.get(m.media_path) : undefined
                      const ref = m.request_id ? requestRefs.get(m.request_id) : undefined
                      const isImage = m.type === 'image'
                      return (
                        <div key={m.id} className={`flex ${m.from_cirqle ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[85%] sm:max-w-[70%] rounded-xl px-3 py-2 border ${m.from_cirqle ? 'bg-primary/10 border-primary/20' : 'bg-secondary border-border'}`}>
                            <p className={`text-[11px] font-medium mb-0.5 ${m.from_cirqle ? 'text-primary' : 'text-foreground'}`}>
                              {senderLabel(m)}{m.from_cirqle && <span className="font-normal text-muted-foreground"> · Cirqle</span>}
                            </p>
                            {url && isImage && (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="block mb-1">
                                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link to private storage; the image optimizer cannot fetch it. */}
                                <img src={url} alt="Photo sent in the chat" className="rounded-lg max-h-64 w-auto" />
                              </a>
                            )}
                            {url && !isImage && (
                              <audio controls preload="none" src={url} className="w-56 max-w-full mb-1">
                                <a href={url}>Voice note</a>
                              </audio>
                            )}
                            {!url && (m.media_path || m.media_note) && (
                              <p className="text-xs text-muted-foreground inline-flex items-center gap-1 mb-1">
                                <Mic className="w-3 h-3" /> {m.media_note || 'File could not be loaded. Open WhatsApp to see it.'}
                              </p>
                            )}
                            {m.media_text && (
                              <p className="text-sm whitespace-pre-wrap break-words mb-1">
                                <span className="block text-[10px] text-muted-foreground">{isImage ? 'Text in the photo (read by AI)' : 'What it says (by AI, check against the recording)'}</span>
                                {m.media_text}
                              </p>
                            )}
                            {m.body && <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>}
                            <p className="mt-1 flex flex-wrap items-center justify-end gap-2 text-[10px] text-muted-foreground">
                              {ref && <Link href="/dashboard/requests" className="text-primary hover:underline">Filed as {ref}</Link>}
                              <time dateTime={m.sent_at}>{timeOf(m.sent_at)}</time>
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </>,
  )
}
