import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient } from '@/lib/supabase/server'
import { indiaDay, isMissingTable } from '@/lib/whatsapp-listener/chat-log'
import { REPORT_TABLE, parseItems, type ReportRow } from '@/lib/whatsapp-listener/insights'
import { chatTitle, loadChatViewer } from '@/lib/whatsapp-listener/insights-run'
import { WhatsAppTabs } from '../insights-client'

export const dynamic = 'force-dynamic'

/**
 * WhatsApp daily report — one day at a time: what happened in each chat
 * (text, voice notes and photos, summarised in plain English by AI) and what
 * was left open at the end of that day. Only chats shared with the person looking.
 */

const IST = 'Asia/Kolkata'
const DAY = /^\d{4}-\d{2}-\d{2}$/
const dayLabel = (day: string) => new Date(`${day}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10)

export default async function WhatsAppReportPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const admin = createAdminClient()
  const cv = await loadChatViewer(admin)
  if (!cv.me || cv.visible.size === 0 && !cv.me.isAdmin) redirect('/dashboard')

  const today = indiaDay(new Date().toISOString())
  const { day: dayParam } = await searchParams
  const day = dayParam && DAY.test(dayParam) && dayParam <= today ? dayParam : today

  const ids = [...cv.visible]
  const res = ids.length
    ? await admin.from(REPORT_TABLE).select('chat_id, report_day, summary, items, message_count, covered_until, updated_at')
      .in('chat_id', ids).eq('report_day', day)
    : { data: [], error: null }
  const missing = isMissingTable(res.error)
  const rows = ((res.data || []) as ReportRow[]).sort((a, b) => b.message_count - a.message_count)
  const messages = rows.reduce((n, r) => n + r.message_count, 0)
  const href = (d: string) => `/dashboard/requests/whatsapp/report?day=${d}`

  return (
    <div className="min-h-screen">
      <Header title="WhatsApp daily report" subtitle="What happened in each chat, day by day" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-5xl mx-auto mt-2 space-y-4">
        <Link href="/dashboard/requests" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Requests
        </Link>
        <WhatsAppTabs active="report" />

        {missing ? (
          <div className="border border-border rounded-xl bg-card px-4 py-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Daily reports are not switched on yet.</p>
            <p className="mt-1">They need one database change: apply <code>supabase/migrations/20261114110000_whatsapp_chat_reports.sql</code>.</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{dayLabel(day)}{day === today && <span className="font-normal text-muted-foreground"> · today</span>}</h2>
              <div className="flex items-center gap-2 text-xs">
                <Link href={href(shift(day, -1))} className="px-2.5 py-1.5 rounded-md border border-border bg-card hover:bg-secondary">Previous day</Link>
                {day < today && <Link href={href(shift(day, 1))} className="px-2.5 py-1.5 rounded-md border border-border bg-card hover:bg-secondary">Next day</Link>}
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground bg-card border border-border rounded-xl p-6 text-center">
                No report for this day. Either no messages arrived in the chats you can see, or the day has not been read yet (reports are written every evening).
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{rows.length} chat{rows.length === 1 ? '' : 's'} active · {messages} message{messages === 1 ? '' : 's'} read</p>
                <div className="space-y-3">
                  {rows.map(r => {
                    const items = parseItems(r.items)
                    return (
                      <article key={r.chat_id} className="border border-border rounded-xl bg-card p-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="text-sm font-semibold">
                            <Link href={`/dashboard/requests/whatsapp?chat=${encodeURIComponent(r.chat_id)}`} className="hover:underline">{chatTitle(cv.ctx, r.chat_id)}</Link>
                          </h3>
                          <span className="text-[11px] text-muted-foreground tabular-nums">{r.message_count} message{r.message_count === 1 ? '' : 's'}</span>
                        </div>
                        <p className="text-sm mt-1.5">{r.summary || 'No summary was written.'}</p>
                        {items.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {items.map(i => (
                              <li key={i.id} className="text-xs flex gap-2">
                                <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium ${i.waitingOn === 'cirqle'
                                  ? 'bg-amber-500/12 text-amber-700 border-amber-500/25 dark:text-amber-400'
                                  : 'bg-violet-500/12 text-violet-700 border-violet-500/25 dark:text-violet-300'}`}>
                                  {i.waitingOn === 'cirqle' ? 'On Cirqle' : 'On client'}
                                </span>
                                <span>{i.text}{i.who && <span className="text-muted-foreground"> · {i.who}</span>}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    )
                  })}
                </div>
              </>
            )}
            <p className="text-[11px] text-muted-foreground/70">
              Summaries are written by AI and can miss or misread things, especially in voice notes. Open the chat to check.
              The items shown are what was open when that day was last read.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
