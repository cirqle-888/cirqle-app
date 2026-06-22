'use client'

import { useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { Inbox, Tag, Settings as SettingsIcon, ArrowRight, Sparkles, Link2, Copy, Check, MessageCircle, Users, ExternalLink } from 'lucide-react'
import { INTAKE_KIND_META } from '@/lib/services/intake'
import { whatsappShareUrl } from '@/lib/invoices/share'

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

interface MultiServiceClient {
  id: string; name: string; phone: string | null; hub_token: string; kinds: string[]
  lastActivity: string | null; requestCount: number
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function HubLinkRow({ client }: { client: MultiServiceClient }) {
  const [copied, setCopied] = useState(false)

  function hubUrl() {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://app.cirqle.work'
    return `${origin}/start/${client.hub_token}`
  }
  async function handleCopy() {
    await navigator.clipboard.writeText(hubUrl())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  function handleShare() {
    const text = `Hi ${client.name},\n\nHere's your Cirqle link — use it to submit ${client.kinds.map(k => INTAKE_KIND_META[k]?.label.toLowerCase() || k).join(' or ')}:\n${hubUrl()}`
    window.open(whatsappShareUrl(text, client.phone), '_blank', 'noopener,noreferrer')
  }
  function handleOpen() {
    window.open(hubUrl(), '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-secondary/40 border border-border/60">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{client.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {client.kinds.map(k => (
            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20">
              {INTAKE_KIND_META[k]?.label || k}
            </span>
          ))}
          {client.lastActivity && (
            <span className="text-[10px] text-muted-foreground">
              {relativeTime(client.lastActivity)} · {client.requestCount} request{client.requestCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
      <button onClick={handleOpen} title="Open link"
        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0">
        <ExternalLink className="w-3.5 h-3.5" />
      </button>
      <button onClick={handleCopy} title="Copy hub link"
        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0">
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      <button onClick={handleShare} title="Share via WhatsApp"
        className="p-1.5 rounded-lg text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0">
        <MessageCircle className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function AppsClient({ clientCounts, multiServiceClients = [] }: { clientCounts: Record<string, number>; multiServiceClients?: MultiServiceClient[] }) {
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

        {/* Multi-service clients — these are the ones who need the single
            Client Hub link (/start/<token>) instead of one app's direct link,
            since they have more than one intake app enabled. */}
        {multiServiceClients.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> Client Hub Links
            </h3>
            <p className="text-xs text-muted-foreground mb-3 flex items-start gap-1.5">
              <Users className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              These {multiServiceClients.length} client{multiServiceClients.length === 1 ? '' : 's'} have more than one app enabled — share this ONE link
              instead of separate app links; it shows them only the form(s) they need.
            </p>
            <div className="space-y-2">
              {multiServiceClients.map(c => <HubLinkRow key={c.id} client={c} />)}
            </div>
          </div>
        )}

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
