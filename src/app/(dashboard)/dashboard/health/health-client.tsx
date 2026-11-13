'use client'

import Link from 'next/link'
import Header from '@/components/layout/header'
import {
  Wallet, TrendingUp, AlertTriangle, Users, Activity,
  CheckCircle2, XCircle, HelpCircle, Clock, ClipboardCheck,
} from 'lucide-react'
import type { OwnerCheck } from '@/lib/owner-alerts/rules'

interface Props {
  ownerCheck: OwnerCheck
  ownerCheckLines: string[]
  ownerCheckIncomplete: string[]
  showAmounts: boolean
  cash: {
    bankBalance: number; totalBilled: number; totalPaid: number; badDebtInr: number
    outstanding: number; toBeInvoiced: number
    collectionRatePct: number | null; totalExpectedCash: number
  }
  agingBuckets: Record<'0-30' | '31-60' | '61-90' | '90+', { count: number; amount: number }>
  clientRisk: { clientId: string; clientName: string; strategicScore: number; classification: string }[]
  cronStatus: { name: string; ranAt: string | null; ok: boolean | null; summary: any; error: string | null }[]
}

const CRON_LABELS: Record<string, string> = {
  'recurring-tasks': 'Recurring Tasks',
  'payroll-draft': 'Payroll Auto-Draft',
  'business-alerts': 'Business Alerts',
  'cleanup-product-images': 'Image Cleanup',
}

function fmt(n: number): string {
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(1)}L`
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(1)}K`
  return `₹${Math.round(n)}`
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never run'
  const ms = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(ms / 3600000)
  if (hours < 1) return 'Less than an hour ago'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const CLASS_TINT: Record<string, string> = {
  'Strategic Client': 'text-emerald-600 dark:text-emerald-400',
  'Growth Client': 'text-blue-600 dark:text-blue-400',
  'High Value Risk': 'text-orange-600 dark:text-orange-400',
  'Reliable Small Client': 'text-cyan-600 dark:text-cyan-400',
  'Watchlist Client': 'text-red-600 dark:text-red-400',
}

export default function HealthClient({ ownerCheck, ownerCheckLines, ownerCheckIncomplete, showAmounts, cash, agingBuckets, clientRisk, cronStatus }: Props) {
  const amt = (n: number) => showAmounts ? fmt(n) : '••••'
  const agingOrder: (keyof typeof agingBuckets)[] = ['0-30', '31-60', '61-90', '90+']
  const maxBucket = Math.max(1, ...agingOrder.map(k => agingBuckets[k].amount))

  return (
    <div className="min-h-screen">
      <Header title="Business Health Center" subtitle="Cash, collections, client risk, and whether your automations are actually running" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-6xl mx-auto mt-2 space-y-6">

        <OwnerCheckPanel check={ownerCheck} lines={ownerCheckLines} incomplete={ownerCheckIncomplete} amt={amt} />

        {/* ── Cash & Collections ──────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-3"><Wallet className="w-4 h-4 text-violet-500" /> Cash &amp; Collections</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: 'Bank Balance', value: amt(cash.bankBalance) },
              { label: 'Total Billed', value: amt(cash.totalBilled) },
              { label: 'Collected', value: amt(cash.totalPaid) },
              { label: 'Outstanding', value: amt(cash.outstanding) },
              { label: 'To Be Invoiced', value: amt(cash.toBeInvoiced) },
              { label: 'Collection Rate', value: cash.collectionRatePct !== null ? `${cash.collectionRatePct}%` : '—' },
              { label: 'Bad Debt', value: amt(cash.badDebtInr) },
            ].map(c => (
              <div key={c.label} className="bg-card border border-border rounded-xl p-4">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{c.label}</p>
                <p className="text-lg font-bold mt-1">{c.value}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Overdue Aging ────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-3"><AlertTriangle className="w-4 h-4 text-red-500" /> Overdue Aging</h2>
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            {agingOrder.map(key => {
              const b = agingBuckets[key]
              const pct = Math.round((b.amount / maxBucket) * 100)
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs font-medium text-muted-foreground w-16 shrink-0">{key} days</span>
                  <div className="flex-1 h-5 bg-secondary rounded-md overflow-hidden">
                    <div className={`h-full rounded-md ${key === '90+' ? 'bg-red-500' : key === '61-90' ? 'bg-orange-500' : key === '31-60' ? 'bg-amber-400' : 'bg-yellow-300'}`} style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-32 text-right shrink-0">{b.count} inv · {amt(b.amount)}</span>
                </div>
              )
            })}
          </div>
        </section>

        {/* ── Client Risk ──────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-3"><Users className="w-4 h-4 text-orange-500" /> Client Risk — lowest scoring clients</h2>
          <div className="bg-card border border-border rounded-xl divide-y divide-border">
            {clientRisk.length === 0 ? (
              <p className="text-xs text-muted-foreground/60 p-4 text-center">No clients with billing/work history yet</p>
            ) : clientRisk.map(c => (
              <div key={c.clientId} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{c.clientName}</p>
                  <p className={`text-[11px] font-medium ${CLASS_TINT[c.classification] || 'text-muted-foreground'}`}>{c.classification}</p>
                </div>
                <span className="text-sm font-bold tabular-nums">{Math.round(c.strategicScore)}<span className="text-[10px] text-muted-foreground font-normal">/100</span></span>
              </div>
            ))}
          </div>
          <Link href="/dashboard/clients/ranking" className="text-xs text-violet-500 hover:underline mt-2 inline-block">View full Client Ranking →</Link>
        </section>

        {/* ── Automation Health ────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-3"><Activity className="w-4 h-4 text-cyan-500" /> Automation Health</h2>
          <div className="bg-card border border-border rounded-xl divide-y divide-border">
            {cronStatus.map(c => (
              <div key={c.name} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2.5">
                  {c.ok === null ? <HelpCircle className="w-4 h-4 text-muted-foreground/50 shrink-0" /> :
                   c.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> :
                   <XCircle className="w-4 h-4 text-red-500 shrink-0" />}
                  <div>
                    <p className="text-sm font-medium">{CRON_LABELS[c.name] || c.name}</p>
                    {c.error && <p className="text-[11px] text-red-500 mt-0.5 max-w-md truncate">{c.error}</p>}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0"><Clock className="w-3 h-3" /> {relativeTime(c.ranAt)}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground/60 mt-2 flex items-center gap-1.5">
            <TrendingUp className="w-3 h-3" /> Task→Invoice and Payment→Cashbook automations run as database triggers with no separate log — not tracked here yet.
          </p>
        </section>

      </div>
    </div>
  )
}

// ── Owner check ──────────────────────────────────────────────────────────────

function OwnerCheckPanel({ check, lines, incomplete, amt }: {
  check: OwnerCheck
  lines: string[]
  incomplete: string[]
  amt: (n: number) => string
}) {
  const rows: { label: string; items: { key: string; text: string; href?: string }[] }[] = [
    {
      label: 'Invoices not sent',
      items: check.unsent.items.slice(0, 5).map(u => ({
        key: u.invoiceId, href: `/dashboard/invoices?id=${u.invoiceId}`,
        text: `${u.invoiceNumber} · ${u.clientName} · ${amt(u.totalInr)} · dated ${u.daysWaiting} days ago`,
      })),
    },
    {
      label: 'Largest overdue',
      items: check.overdue.top.map(t => ({
        key: t.invoiceId, href: `/dashboard/invoices?id=${t.invoiceId}`,
        text: `${t.invoiceNumber} · ${t.clientName} · ${amt(t.outstandingInr)} · ${t.daysOverdue} days overdue`,
      })),
    },
    {
      label: 'Regular clients gone quiet',
      items: check.quiet.slice(0, 5).map(q => ({
        key: q.clientId, href: `/dashboard/clients/${q.clientId}`,
        text: `${q.clientName} · no job for ${q.daysSilent} days · usually ${amt(q.monthlyAvgInr)}/month`,
      })),
    },
    {
      label: 'Spending less than half their usual',
      items: check.falling.slice(0, 5).map(f => ({
        key: f.clientId, href: `/dashboard/clients/${f.clientId}`,
        text: `${f.clientName} · ${amt(f.recentMonthlyInr)}/month now, was ${amt(f.priorMonthlyInr)}`,
      })),
    },
    {
      label: 'Requests past their due date',
      items: check.requestsOverdue.slice(0, 5).map(r => ({
        key: r.id, href: '/dashboard/requests',
        text: `REQ-${String(r.ref_no).padStart(4, '0')} ${r.title}${r.client_name ? ` · ${r.client_name}` : ''} · ${r.daysLate} days late`,
      })),
    },
    {
      label: 'Records to correct',
      items: check.recordIssues.map(i => ({ key: `${i.invoiceId}-${i.kind}`, href: `/dashboard/invoices?id=${i.invoiceId}`, text: `${i.invoiceNumber}: ${i.detail}` })),
    },
    {
      label: 'Automations failing',
      items: check.automationFailures.map(f => ({ key: f.name, text: `${f.name}: ${f.lastError || 'failed'} (${f.failedRuns} failed run${f.failedRuns === 1 ? '' : 's'} this week)` })),
    },
  ].filter(r => r.items.length > 0)

  return (
    <section id="owner-check" className="scroll-mt-20">
      <h2 className="text-sm font-semibold flex items-center gap-2 mb-1"><ClipboardCheck className="w-4 h-4 text-violet-500" /> Owner check</h2>
      <p className="text-[11px] text-muted-foreground mb-3">
        Everything that needs a person right now. The same list is sent as a notification every Monday morning.
        Switch alerts on or off in Settings → Company → Owner alerts.
      </p>
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        {incomplete.length > 0 && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">Some data could not be read, so this list may be incomplete: {incomplete.join('; ')}</p>
        )}
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500" /> Nothing needs you right now.</p>
        ) : (
          <ul className="text-sm space-y-1 list-disc pl-5">
            {lines.map(l => <li key={l}>{l}</li>)}
          </ul>
        )}
        {(check.cashbook.unreviewed > 0) && (
          <p className="text-[11px] text-muted-foreground">{check.cashbook.unreviewed} cash book entr{check.cashbook.unreviewed === 1 ? 'y' : 'ies'} from the last 90 days not yet marked reviewed.</p>
        )}
        {rows.map(r => (
          <div key={r.label}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{r.label}</p>
            <ul className="divide-y divide-border border border-border rounded-lg">
              {r.items.map(i => (
                <li key={i.key} className="px-3 py-2 text-xs">
                  {i.href ? <Link href={i.href} className="hover:underline">{i.text}</Link> : i.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
