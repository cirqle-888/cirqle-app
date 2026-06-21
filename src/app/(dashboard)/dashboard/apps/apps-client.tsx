'use client'

import Link from 'next/link'
import Header from '@/components/layout/header'
import { Inbox, Tag, Settings as SettingsIcon, ArrowRight, Sparkles } from 'lucide-react'
import { INTAKE_KIND_META } from '@/lib/services/intake'

// Intake apps available today, in display order, with their config route.
const APPS: { kind: string; configHref: string; icon: typeof Inbox }[] = [
  { kind: 'request_portal', configHref: '/dashboard/apps/standard-request', icon: Inbox },
  { kind: 'offer_intake',   configHref: '/dashboard/apps/offer-intake',  icon: Tag },
]

// Planned modules (no portal yet) — surfaced so the roadmap is visible and the
// "add-on" model is obvious.
const COMING: { label: string; description: string }[] = [
  { label: 'Meta Ads Reports',   description: 'Ad-report intake for clients on a Meta Ads retainer.' },
  { label: 'Google Ads Reports', description: 'Google Ads performance submissions.' },
  { label: 'Website Requests',   description: 'Website change / build request intake.' },
  { label: 'SEO',                description: 'SEO task and report intake.' },
]

export default function AppsClient({ clientCounts }: { clientCounts: Record<string, number> }) {
  return (
    <div className="min-h-screen">
      <Header
        title="Apps Directory"
        subtitle="Client-facing intake add-ons — each feeds submissions into the Requests inbox"
      />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-4xl mx-auto mt-2 space-y-6">
        <p className="text-sm text-muted-foreground">
          Each app is a tokenised portal a client uses to submit work. Which app a client sees is decided by the
          services assigned to them (<span className="text-foreground">Settings → Services → Intake Form</span>).
          Submissions from every app land in one place — the <span className="text-foreground">Requests</span> inbox.
        </p>

        {/* Active apps */}
        <div className="grid sm:grid-cols-2 gap-4">
          {APPS.map(({ kind, configHref, icon: Icon }) => {
            const meta = INTAKE_KIND_META[kind]
            const count = clientCounts[kind] || 0
            return (
              <div key={kind} className="rounded-xl border border-border bg-card p-5 flex flex-col">
                <div className="flex items-center gap-2.5 mb-2">
                  <div className="w-9 h-9 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{meta?.label || kind}</h3>
                    <p className="text-[11px] text-muted-foreground">{count} client{count === 1 ? '' : 's'} enabled</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground flex-1">{meta?.description}</p>
                <Link
                  href={configHref}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-400 hover:underline"
                >
                  <SettingsIcon className="w-3.5 h-3.5" /> Configure &amp; manage links <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            )
          })}
        </div>

        {/* Roadmap */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" /> Planned modules
          </h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {COMING.map(c => (
              <div key={c.label} className="rounded-xl border border-dashed border-border/60 bg-card/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-foreground/70">{c.label}</h4>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border shrink-0">Coming soon</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{c.description}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-3">
            New modules plug in the same way: add the intake kind, build its portal, and tag the relevant services — no schema change.
          </p>
        </div>
      </div>
    </div>
  )
}
