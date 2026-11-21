import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { todayISO } from '@/lib/utils/local-date'
import { buildPayCheck } from '@/lib/autopilot/pay-check'
import { checkPeriod } from '@/lib/autopilot/pay-check-rules'
import { daysInMonth, monthLabel } from '@/lib/autopilot/social-rules'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Contribution and pay check: what the morning autopilot found, live.
 * Read-only; every fix happens on the page each row links to.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const niceDate = (d: string | null) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : 'no date')
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

export default async function AutoCheckPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  const allowed = me.isAdmin || me.permissions.has(PERMS.CONTRIBUTIONS_VIEW_ALL) || me.permissions.has(PERMS.PAYROLL_VIEW)
  if (!allowed) redirect('/dashboard/contributions')

  const today = todayISO()
  const sp = await searchParams
  let period = checkPeriod(today)
  if (sp.month && /^\d{4}-\d{2}$/.test(sp.month)) {
    const month = `${sp.month}-01`
    const end = `${sp.month}-${String(daysInMonth(month)).padStart(2, '0')}`
    period = { from: month, to: end < today ? end : today, month }
  }
  const built = await buildPayCheck(createAdminClient(), today, period)
  const showMoney = me.isAdmin || me.permissions.has(PERMS.PAYROLL_VIEW_AMOUNTS)

  const prev = new Date(`${period.month}T00:00:00Z`); prev.setUTCMonth(prev.getUTCMonth() - 1)
  const prevKey = prev.toISOString().slice(0, 7)
  const nextKey = (() => { const n = new Date(`${period.month}T00:00:00Z`); n.setUTCMonth(n.getUTCMonth() + 1); return n.toISOString().slice(0, 7) })()

  const Section = ({ title, hint, count, children }: { title: string; hint: string; count: number; children: React.ReactNode }) => (
    <section className="space-y-2">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title} <span className="text-foreground">({count})</span></h2>
        <p className="text-[11px] text-muted-foreground/70">{hint}</p>
      </div>
      {count === 0
        ? <p className="text-sm text-muted-foreground bg-card border border-border rounded-xl p-3">Nothing here.</p>
        : <div className="divide-y divide-border bg-card border border-border rounded-xl text-sm">{children}</div>}
    </section>
  )

  return (
    <div className="min-h-screen">
      <Header title="Contribution and pay check" subtitle="Who made what, checked against WhatsApp and Instagram, before pay day" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-4xl mx-auto mt-2 space-y-6">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Link href="/dashboard/contributions" className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Contributions
          </Link>
          <span className="ml-auto flex items-center gap-2">
            <Link href={`?month=${prevKey}`} className="px-2 py-1 rounded border border-border hover:bg-secondary">&larr; {monthLabel(`${prevKey}-01`)}</Link>
            <span className="font-medium">{monthLabel(period.month)}{period.to < `${period.month.slice(0, 7)}-${String(daysInMonth(period.month)).padStart(2, '0')}` ? ` (to ${niceDate(period.to)})` : ''}</span>
            {nextKey <= today.slice(0, 7) && <Link href={`?month=${nextKey}`} className="px-2 py-1 rounded border border-border hover:bg-secondary">{monthLabel(`${nextKey}-01`)} &rarr;</Link>}
          </span>
        </div>

        {!built.ok ? (
          <p className="text-sm text-red-600">The check could not run: {built.error}</p>
        ) : (() => {
          const r = built.report
          return (
            <>
              {r.pay.length > 0 && (
                <Section title="Pay due" hint="Last month's salaries due within three days or late. Check the lists below first, then mark them paid on Payroll." count={r.pay.length}>
                  {r.pay.map(p => (
                    <Link key={p.employee_id} href="/dashboard/payroll" className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/40">
                      <span className="flex-1">{p.name}{showMoney ? ` · ${inr(p.net)}` : ''}</span>
                      <span className={p.late ? 'text-red-600 font-medium' : 'text-muted-foreground'}>{p.late ? 'late, was due' : 'due'} {niceDate(p.payDate)}</span>
                    </Link>
                  ))}
                </Section>
              )}

              <Section title="Finished, nobody credited" hint="Delivered or done tasks with no contributors. Open one and apply the suggestion, or credit the right people." count={r.noContributors.length}>
                {r.noContributors.map(t => (
                  <Link key={t.id} href={`/dashboard/contributions?highlight=${t.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/40">
                    <span className="flex-1 min-w-0 truncate">{t.label} <span className="text-muted-foreground">· {t.client}</span></span>
                    <span className="text-xs text-muted-foreground shrink-0">{niceDate(t.date)}{t.assignees.length ? ` · assigned ${t.assignees.join(', ')}` : ''}</span>
                  </Link>
                ))}
              </Section>

              <Section title="Sent the design, not credited" hint="This person posted designs in the client's WhatsApp group, but the client's tasks around that day credit someone else." count={r.uncredited.length}>
                {r.uncredited.map((u, i) => (
                  <div key={i} className="px-4 py-2.5 space-y-1">
                    <p><span className="font-medium">{u.person}</span> sent {u.count} design{u.count === 1 ? '' : 's'} to {u.client} on {niceDate(u.day)}</p>
                    {u.tasks.map(t => (
                      <Link key={t.id} href={`/dashboard/contributions?highlight=${t.id}`} className="block text-xs text-muted-foreground hover:text-foreground">
                        {t.label} credits {t.credited.join(', ')}
                      </Link>
                    ))}
                  </div>
                ))}
              </Section>

              <Section title="Designs sent, no task" hint="Cirqle people sent designs in the client's group, but the client has no task within three days. Add the task if this was work." count={r.deliveriesWithoutTask.length}>
                {r.deliveriesWithoutTask.map((d, i) => (
                  <Link key={i} href={`/dashboard/contributions?client=${d.clientId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/40">
                    <span className="flex-1">{d.client} <span className="text-muted-foreground">· {d.count} file{d.count === 1 ? '' : 's'} by {d.people.join(', ')}</span></span>
                    <span className="text-xs text-muted-foreground">{niceDate(d.day)}</span>
                  </Link>
                ))}
              </Section>

              <Section title="Live posts, no task" hint="Posts on the client's own Instagram or Facebook with no task for that client in the week before. Some may be the client's own posts." count={r.postsWithoutTask.length}>
                {r.postsWithoutTask.map((p, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="flex-1">{p.client} <span className="text-muted-foreground">· {(p.kind || 'post').toLowerCase()}</span></span>
                    <span className="text-xs text-muted-foreground">{niceDate(p.day)}</span>
                    {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" className="text-xs inline-flex items-center gap-1 text-primary">Open <ExternalLink className="w-3 h-3" /></a>}
                  </div>
                ))}
              </Section>

              <Section title="Finished, not billed" hint={`Billable work delivered or done in this period with no invoice line${showMoney ? ` (${inr(r.unbilled.total_inr)} in all)` : ''}. Package work is left out.`} count={r.unbilled.count}>
                {r.unbilled.items.map((t, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="flex-1 min-w-0 truncate">#{t.task_number} {t.title} <span className="text-muted-foreground">· {t.client}</span></span>
                    <span className="text-xs text-muted-foreground shrink-0">{niceDate(t.task_date)}{showMoney ? ` · ${inr(t.amount_inr)}` : ''}</span>
                  </div>
                ))}
              </Section>

              {r.notes.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-1 border-t border-border pt-4">
                  {r.notes.map((n, i) => <p key={i}>{n}</p>)}
                </div>
              )}
            </>
          )
        })()}
      </div>
    </div>
  )
}
