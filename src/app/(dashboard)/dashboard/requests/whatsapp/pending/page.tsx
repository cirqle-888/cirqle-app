import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient } from '@/lib/supabase/server'
import { indiaDay, isMissingTable } from '@/lib/whatsapp-listener/chat-log'
import { REPORT_TABLE, latestReports, pendingLines, type PendingLine, type ReportRow } from '@/lib/whatsapp-listener/insights'
import { chatTitle, loadChatViewer } from '@/lib/whatsapp-listener/insights-run'
import { EmployeeName } from '@/components/ui/employee-name'
import { AskBox, DoneButton, RefreshReportsButton, WhatsAppTabs } from '../insights-client'

export const dynamic = 'force-dynamic'
/** "Update now" reads several chats through the AI in one go. */
export const maxDuration = 60

/**
 * WhatsApp pending — what is still open in each chat, worked out by AI from
 * the conversation: what is waiting on Cirqle, what is waiting on the client.
 * Only chats shared with the person looking. Read-only towards WhatsApp.
 */

const IST = 'Asia/Kolkata'
const waited = (days: number) => (days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`)

export default async function WhatsAppPendingPage() {
  const admin = createAdminClient()
  const cv = await loadChatViewer(admin)
  if (!cv.me || cv.visible.size === 0 && !cv.me.isAdmin) redirect('/dashboard')

  const ids = [...cv.visible]
  const today = indiaDay(new Date().toISOString())
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 45 * 86_400_000).toISOString().slice(0, 10)
  const res = ids.length
    ? await admin.from(REPORT_TABLE).select('chat_id, report_day, summary, items, message_count, covered_until, updated_at')
      .in('chat_id', ids).gte('report_day', since).order('report_day', { ascending: false }).limit(2000)
    : { data: [], error: null }
  const missing = isMissingTable(res.error)
  const latest = latestReports((res.data || []) as ReportRow[])
  const lines = pendingLines(latest, today)
  const ours = lines.filter(l => l.waitingOn === 'cirqle')
  const theirs = lines.filter(l => l.waitingOn === 'client')
  const lastUpdate = [...latest.values()].map(r => r.updated_at).sort().pop()

  const staff = new Map<string, { cqid: string | null; name: string | null }>()
  if (ours.length) {
    const { data } = await admin.from('employees').select('id, cqid, name')
    for (const e of (data || []) as { id: string; cqid: string | null; name: string | null }[]) staff.set(e.id, e)
  }
  const responsible = (chatId: string) => {
    const owner = cv.ctx.access[chatId]?.owner
    return owner ? staff.get(owner) ?? null : null
  }

  const list = (rows: PendingLine[], empty: string, showWho: boolean) => rows.length === 0
    ? <p className="px-4 py-5 text-sm text-muted-foreground">{empty}</p>
    : (
      <ul className="divide-y divide-border">
        {rows.map(l => (
          <li key={`${l.chatId}:${l.id}`} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex-1 min-w-[220px]">
              <p className="text-sm">{l.text}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                <Link href={`/dashboard/requests/whatsapp?chat=${encodeURIComponent(l.chatId)}`} className="text-primary hover:underline">{chatTitle(cv.ctx, l.chatId)}</Link>
                {showWho && <> · {l.who || (responsible(l.chatId) ? <EmployeeName emp={responsible(l.chatId)} /> : 'nobody assigned')}</>}
              </p>
            </div>
            <span className={`text-[11px] tabular-nums ${showWho && l.days >= 2 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground'}`}>
              waiting {waited(l.days)}
            </span>
            <DoneButton chatId={l.chatId} itemId={l.id} label={l.text} />
          </li>
        ))}
      </ul>
    )

  return (
    <div className="min-h-screen">
      <Header title="WhatsApp pending" subtitle="What is still open in the client chats, worked out by AI" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-5xl mx-auto mt-2 space-y-4">
        <Link href="/dashboard/requests" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Requests
        </Link>
        <WhatsAppTabs active="pending" />

        {missing ? (
          <div className="border border-border rounded-xl bg-card px-4 py-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Pending items and reports are not switched on yet.</p>
            <p className="mt-1">They need one database change: apply <code>supabase/migrations/20261114110000_whatsapp_chat_reports.sql</code>. The chat view keeps working meanwhile.</p>
          </div>
        ) : (
          <>
            <AskBox />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {lastUpdate
                  ? `Last read ${new Date(lastUpdate).toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. Updates every evening.`
                  : 'No chats have been read yet. The list fills in after the first evening run.'}
              </p>
              {cv.me.isAdmin && <RefreshReportsButton />}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: 'Waiting on Cirqle', value: ours.length },
                { label: 'Waiting 2+ days', value: ours.filter(l => l.days >= 2).length },
                { label: 'Waiting on clients', value: theirs.length },
              ].map(c => (
                <div key={c.label} className="bg-card border border-border rounded-xl p-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{c.label}</p>
                  <p className="text-lg font-bold mt-1 tabular-nums">{c.value}</p>
                </div>
              ))}
            </div>

            <section aria-label="Waiting on Cirqle" className="border border-border rounded-xl bg-card overflow-hidden">
              <h2 className="px-4 py-2.5 text-sm font-semibold border-b border-border">Action needed from Cirqle</h2>
              {list(ours, 'Nothing is waiting on Cirqle in the chats you can see.', true)}
            </section>

            <section aria-label="Waiting on clients" className="border border-border rounded-xl bg-card overflow-hidden">
              <h2 className="px-4 py-2.5 text-sm font-semibold border-b border-border">Waiting on the client</h2>
              {list(theirs, 'Nothing is waiting on a client.', false)}
            </section>

            <p className="text-[11px] text-muted-foreground/70">
              This list is written by AI from the messages, voice notes and photos in each chat, so it can miss or misread things.
              Open the chat to check. &quot;Done&quot; removes an item here only; nothing is sent to WhatsApp.
              The person named for an item, or the person responsible for the chat, gets a Cirqle notification when it first appears.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
