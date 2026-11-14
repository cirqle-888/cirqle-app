import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, ExternalLink, TriangleAlert } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient } from '@/lib/supabase/server'
import { OFFER_STUDIO_URL } from '@/lib/offers/studio'
import { indiaDay } from '@/lib/whatsapp-listener/chat-log'
import { chatTitle, loadChatViewer } from '@/lib/whatsapp-listener/insights-run'
import { addDays, dateLabel } from '@/lib/whatsapp-listener/offer-plan'
import { STAGE_LABEL, isBehind, type FlyerStage } from '@/lib/whatsapp-listener/flyer-desk'
import { DESK_DAYS, loadFlyerDesk, type DeskFlyer } from '@/lib/whatsapp-listener/flyer-desk-run'
import { CopyListButton, WhatsAppTabs } from '../insights-client'

export const dynamic = 'force-dynamic'

/**
 * Flyer desk — every offer price list a client sent on WhatsApp, with how far
 * its flyer has got. The stage is read off the chat itself: a design posted by
 * Cirqle, the client's "ok", or the client asking for changes.
 * Only chats shared with the person looking. Read-only towards WhatsApp.
 */

const IST = 'Asia/Kolkata'
const TONE: Record<FlyerStage, string> = {
  new: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  sent: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  changes: 'bg-red-500/15 text-red-700 dark:text-red-300',
  approved: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
}
const time = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export default async function WhatsAppFlyersPage() {
  const admin = createAdminClient()
  const cv = await loadChatViewer(admin)
  if (!cv.me || cv.visible.size === 0 && !cv.me.isAdmin) redirect('/dashboard')

  const today = indiaDay(new Date().toISOString())
  const tomorrow = addDays(today, 1)
  const { flyers, missing } = await loadFlyerDesk(admin, cv.visible, today)
  const upcoming = flyers.filter(f => (f.offerEnd || f.offerStart) >= today)
  const past = flyers.filter(f => (f.offerEnd || f.offerStart) < today)
  const count = (s: FlyerStage) => upcoming.filter(f => f.progress.stage === s).length

  const row = (f: DeskFlyer) => {
    const title = f.client || chatTitle(cv.ctx, f.chatId)
    const late = isBehind(f.progress.stage, f.offerStart, today, tomorrow)
    return (
      <li key={f.itemId} className="px-4 py-3 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm font-medium flex-1 min-w-[180px]">{title}</p>
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${TONE[f.progress.stage]}`}>{STAGE_LABEL[f.progress.stage]}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          <span className={late ? 'text-red-600 dark:text-red-400 font-medium' : ''}>
            Offer {f.offerStart === today ? 'today' : f.offerStart === tomorrow ? 'tomorrow' : dateLabel({ start: f.offerStart, end: null })}
            {f.offerEnd ? ` to ${dateLabel({ start: f.offerEnd, end: null })}` : ''}
          </span>
          {f.dateAssumed && ' (date not given, set to the next day)'}
          {' · '}{f.products} products{f.fromPhoto && ', read from a photo'}
          {' · '}received {time(f.receivedAt)}
          {f.progress.designs > 0 && <>{' · '}{f.progress.designs} design{f.progress.designs === 1 ? '' : 's'} sent</>}
          {f.progress.corrections > 0 && <>{' · '}{f.progress.corrections} round{f.progress.corrections === 1 ? '' : 's'} of changes</>}
          {f.calendarStatus === 'requested' && ' · sent to Requests'}
        </p>
        {f.warnings.length > 0 && (
          <ul className="text-xs text-amber-700 dark:text-amber-300 space-y-0.5">
            {f.warnings.map(w => (
              <li key={w} className="flex items-start gap-1.5"><TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden /> <span>Check: {w}</span></li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <CopyListButton list={f.list} label={title} />
          <a href={OFFER_STUDIO_URL} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] border border-border bg-secondary hover:text-foreground text-muted-foreground">
            <ExternalLink className="w-3 h-3" /> Offer Studio
          </a>
          <Link href={`/dashboard/requests/whatsapp?chat=${encodeURIComponent(f.chatId)}`} className="text-[11px] text-primary hover:underline">Open chat</Link>
          <Link href="/dashboard/social-calendar" className="text-[11px] text-primary hover:underline">Social calendar</Link>
        </div>
      </li>
    )
  }

  return (
    <div className="min-h-screen">
      <Header title="WhatsApp flyers" subtitle="Offer price lists from the client chats, and how far each flyer has got" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-5xl mx-auto mt-2 space-y-4">
        <Link href="/dashboard/requests" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Requests
        </Link>
        <WhatsAppTabs active="flyers" />

        {missing ? (
          <p className="border border-border rounded-xl bg-card px-4 py-6 text-sm text-muted-foreground">The social calendar could not be read. Try again in a moment.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Not designed yet', value: count('new') },
                { label: 'Waiting for the client', value: count('sent') },
                { label: 'Changes asked', value: count('changes') },
                { label: 'Approved', value: count('approved') },
              ].map(c => (
                <div key={c.label} className="bg-card border border-border rounded-xl p-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{c.label}</p>
                  <p className="text-lg font-bold mt-1 tabular-nums">{c.value}</p>
                </div>
              ))}
            </div>

            <section aria-label="Current offers" className="border border-border rounded-xl bg-card overflow-hidden">
              <h2 className="px-4 py-2.5 text-sm font-semibold border-b border-border">Today and coming up</h2>
              {upcoming.length === 0
                ? <p className="px-4 py-5 text-sm text-muted-foreground">No offer lists are waiting. A price list a client sends in a listed chat appears here by itself.</p>
                : <ul className="divide-y divide-border">{upcoming.map(row)}</ul>}
            </section>

            {past.length > 0 && (
              <section aria-label="Past offers" className="border border-border rounded-xl bg-card overflow-hidden">
                <h2 className="px-4 py-2.5 text-sm font-semibold border-b border-border">Last {DESK_DAYS} days</h2>
                <ul className="divide-y divide-border">{past.map(row)}</ul>
              </section>
            )}

            <p className="text-[11px] text-muted-foreground/70">
              The stage is read from the chat: a photo or file posted by Cirqle counts as a design, the client&apos;s &quot;ok&quot; as approval, and anything else
              the client says after a design as changes. It can be wrong when people reply about something else, so open the chat to check.
              Price checks compare a list with the same client&apos;s earlier lists. Nothing is sent to WhatsApp.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
