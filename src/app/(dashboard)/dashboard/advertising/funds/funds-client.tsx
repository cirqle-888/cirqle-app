'use client'

/**
 * Ad Funds — top up Meta in one step, see what to top up, triage Meta
 * payments, and the spend-vs-invoiced statement.
 *
 * The pieces are exported so the client workspace (and the Client Hub's Ads
 * tab, which renders the same workspace) shows the same top-up form and the
 * same statement filtered to one client.
 */

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Wallet, RefreshCw, ExternalLink, Loader2, CheckCircle2, AlertTriangle, XCircle, Link2,
  ChevronDown, Printer, Plus, Info, EyeOff, Download,
} from 'lucide-react'
import type {
  FundsData, FundsAccount, FundsCampaign, FundsSuggestion, FundsTodo, ClientFundsData,
} from './_data'
import type { StatementClient, StatementMonth } from '@/lib/advertising/funds-core'
import { recordAdTopUp, linkFundingEventToEntry, dismissFundingEvent, syncAdBillingNow } from './actions'
import { todayISO } from '@/lib/utils/local-date'
import { renderAdStatementHtml, type AdStatementParty, type AdStatementTopUp } from '@/lib/advertising/ad-statement-html'

const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`

const monthName = (p: string) =>
  new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/** Meta's billing page for the account — its "Add funds" button is on it. */
export const metaAddFundsUrl = (accountId: string) =>
  `https://business.facebook.com/billing_hub/payment_activity?asset_id=${encodeURIComponent(accountId.replace(/^act_/, ''))}`

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FundsClient({ data, canManage, initialClientId }: {
  data: FundsData
  canManage: boolean
  initialClientId: string | null
}) {
  const router = useRouter()
  const [prefill, setPrefill] = useState<{ clientId: string | null; amount: number | null; key: number }>(
    { clientId: initialClientId, amount: null, key: 0 },
  )
  const [syncing, startSync] = useTransition()
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const clientName = useMemo(() => new Map(data.clients.map(c => [c.id, c.name])), [data.clients])
  const monthSpend = data.statement.reduce((sum, item) =>
    sum + (item.months.find(m => m.period === data.currentPeriod)?.spendInclGst ?? 0), 0)
  const needToAdd = data.suggestions.reduce((sum, item) =>
    sum + ((item.level === 'low' || item.level === 'empty') ? (item.suggestedInr ?? 0) : 0), 0)
  const knownBalances = data.accounts.length > 0 && data.accounts.every(a => a.availableBalance != null)
  const totalBalance = knownBalances ? data.accounts.reduce((sum, a) => sum + (a.availableBalance ?? 0), 0) : null
  const attentionCount = data.todos.length


  if (!data.migrated) {
    return (
      <div className="p-6 max-w-3xl">
        <Header />
        <p className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          Ad Funds isn&apos;t set up yet. Apply the database migration
          <code className="mx-1 rounded bg-secondary px-1">20261027120000_ad_funds_autopilot.sql</code>
          and reload.
        </p>
      </div>
    )
  }

  function sync() {
    setSyncMsg(null)
    startSync(async () => {
      const res = await syncAdBillingNow()
      if (!res.ok) setSyncMsg(res.error || 'Sync failed.')
      else setSyncMsg(res.data?.failed.length ? `Synced with problems: ${res.data.failed.join(' · ')}` : `Synced ${res.data?.accounts ?? 0} account(s) from Meta.`)
      router.refresh()
    })
  }

  const suggest = (s: FundsSuggestion) => {
    setPrefill(p => ({ clientId: s.clientId, amount: s.suggestedInr, key: p.key + 1 }))
    document.getElementById('top-up')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 print:p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <Header />
        {canManage && (
          <button onClick={sync} disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50">
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync from Meta
          </button>
        )}
      </div>
      {syncMsg && <p className="text-xs text-muted-foreground print:hidden">{syncMsg}</p>}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 print:hidden" aria-label="Ad funds overview">
        {[
          { label: 'Meta balance', value: totalBalance == null ? 'Not synced' : inr(totalBalance, 2), note: 'Across connected accounts' },
          { label: 'Spent this month', value: inr(monthSpend, 2), note: 'Includes GST' },
          { label: 'Need to add', value: inr(needToAdd, 2), note: 'Suggested top-ups only' },
          { label: 'Billing status', value: attentionCount ? `${attentionCount} to review` : 'No alerts', note: 'Check details below' },
        ].map(card => (
          <div key={card.label} className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className="mt-2 text-xl font-semibold tabular-nums">{card.value}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{card.note}</p>
          </div>
        ))}
      </section>
      <details className="rounded-xl border border-border bg-card p-4 print:hidden">
        <summary className="cursor-pointer text-sm font-semibold">Account balances and sync details</summary>
        <div className="mt-3"><AccountStrip accounts={data.accounts} /></div>
      </details>

      <div className="grid gap-6 lg:grid-cols-2 print:hidden">
        <section id="top-up" className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Plus className="h-4 w-4 text-pink-500" /> Add fund</h2>
          {canManage ? (
            <TopUpForm
              key={prefill.key}
              clients={data.clients}
              accounts={data.accounts}
              banks={data.banks}
              campaigns={data.campaigns}
              initialClientId={prefill.clientId}
              initialAmount={prefill.amount}
              onDone={() => router.refresh()}
            />
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">You can view ad funds but not add them.</p>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Wallet className="h-4 w-4 text-pink-500" /> Top-up suggestions</h2>
          <SuggestionList suggestions={data.suggestions} clientName={clientName} onPick={canManage ? suggest : undefined} />
        </section>
      </div>

      <details className="rounded-xl border border-border bg-card p-4 print:hidden" open={attentionCount > 0}>
        <summary className="cursor-pointer text-sm font-semibold">Reconciliation and funding checks ({attentionCount})</summary>
        <div className="mt-3"><TodoList todos={data.todos} data={data} canManage={canManage} clientName={clientName} onDone={() => router.refresh()} /></div>
      </details>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Statement — ad spend vs invoiced</h2>
          <button onClick={() => window.print()}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-secondary print:hidden">
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
        </div>
        <StatementView statement={data.statement} clientName={clientName} doc={{
          brand: data.brand,
          party: id => data.clients.find(c => c.id === id) ?? null,
          topUps: id => data.topUpsByClient[id] ?? [],
          balance: id => data.suggestions.find(x => x.clientId === id)?.balanceInr ?? null,
        }} />
      </section>
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-pink-500" /> Ad Funds</h1>
      <p className="text-sm text-muted-foreground mt-0.5">
        Top up Meta, see which client every rupee is for, and check that all ad spend is invoiced (actual spend + 18% GST).
      </p>
    </div>
  )
}

function AccountStrip({ accounts }: { accounts: FundsAccount[] }) {
  if (!accounts.length) {
    return <p className="text-xs text-muted-foreground">No ad accounts connected. Connect one in <Link href="/dashboard/connections" className="underline">Ad Accounts</Link>.</p>
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {accounts.map(a => (
        <div key={a.id} className="rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{a.name}</span>
            <a href={metaAddFundsUrl(a.accountId)} target="_blank" rel="noreferrer"
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 print:hidden">
              Meta billing <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Prepaid balance</span>
            <span className="text-sm font-semibold tabular-nums">{inr(a.availableBalance, 2)}</span>
          </div>
          <div className={`mt-0.5 text-[10px] ${a.syncError ? 'text-red-500' : 'text-muted-foreground'}`}>
            {a.syncError ? `Sync problem: ${a.syncError}` : `Synced ${ago(a.syncedAt)}`}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Top-up form ──────────────────────────────────────────────────────────────

export function TopUpForm({ clients, accounts, banks, campaigns, initialClientId, initialAmount, fixedClient = false, onDone }: {
  clients: { id: string; name: string }[]
  accounts: FundsAccount[]
  banks: { id: string; name: string; isDefault: boolean }[]
  campaigns: FundsCampaign[]
  initialClientId: string | null
  initialAmount: number | null
  /** Client workspace: the client is fixed, no picker. */
  fixedClient?: boolean
  onDone: () => void
}) {
  const [clientId, setClientId] = useState<string>(() => {
    if (initialClientId) return initialClientId
    if (fixedClient || typeof window === 'undefined') return ''
    try {
      const saved = JSON.parse(localStorage.getItem('cirqle:ad-funds:defaults') || '{}')
      if (typeof saved.clientId === 'string' && clients.some(c => c.id === saved.clientId)) return saved.clientId
    } catch { /* optional preference */ }
    return ''
  })
  const clientCampaigns = campaigns.filter(c => c.clientId === clientId)
  const defaultAccount = clientCampaigns.find(c => c.status === 'active' && c.adAccountId)?.adAccountId
    ?? clientCampaigns.find(c => c.adAccountId)?.adAccountId ?? accounts[0]?.id ?? ''
  const [accountId, setAccountId] = useState<string>(defaultAccount)
  const [amount, setAmount] = useState(initialAmount ? String(initialAmount) : '')
  const [date, setDate] = useState(todayISO())
  const [bankId, setBankId] = useState(banks.find(b => b.isDefault)?.id ?? '')
  const [projectId, setProjectId] = useState('')
  const [reference, setReference] = useState('')
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const account = accounts.find(a => a.id === accountId)
  const onAccount = clientCampaigns.filter(c => c.adAccountId === accountId && c.status !== 'cancelled' && c.status !== 'completed')
  const amt = Number(amount) || 0

  function pickClient(id: string) {
    setClientId(id)
    const cc = campaigns.filter(c => c.clientId === id)
    const acc = cc.find(c => c.status === 'active' && c.adAccountId)?.adAccountId ?? cc.find(c => c.adAccountId)?.adAccountId
    if (acc) setAccountId(acc)
    setProjectId('')
  }

  async function record() {
    if (!fixedClient && !clientId) { setErr('Pick the client this money is for.'); return }
    if (amt <= 0) { setErr('Enter the amount you added in Meta.'); return }
    setBusy(true); setErr(null)
    const res = await recordAdTopUp({
      clientId: clientId || null, adAccountId: accountId, amount: amt, entryDate: date,
      bankAccountId: bankId || null, projectId: projectId || null, reference: reference || null,
    })
    setBusy(false)
    if (!res.ok) { setErr(res.error || 'Could not record the top-up.'); return }
    setDone(res.data?.warning ?? `Recorded ${inr(amt, 2)} — Cashbook entry added, wallet credited${res.data?.allocatedTo ? ' and allocated to the campaign' : ''}.`)
    try { localStorage.setItem('cirqle:ad-funds:defaults', JSON.stringify({ clientId, accountId, bankId })) }
    catch { /* optional preference */ }
    setAmount(''); setReference(''); setOpened(false)
    onDone()
  }

  if (!accounts.length) return <p className="mt-2 text-xs text-muted-foreground">Connect a Meta ad account first.</p>

  const field = 'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs'
  const label = 'block text-[10px] font-medium text-muted-foreground mb-1'

  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {!fixedClient && (
          <div>
            <label className={label}>Client</label>
            <select value={clientId} onChange={e => pickClient(e.target.value)} className={field}>
              <option value="">Select client…</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={label}>Ad account</label>
          <select value={accountId} onChange={e => { setAccountId(e.target.value); setProjectId('') }} className={field}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Amount (₹, as paid in Meta)</label>
          <input type="number" min="0" step="1" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="e.g. 1000" className={`${field} tabular-nums`} />
        </div>
      </div>

      <div className="rounded-lg bg-secondary/50 p-3 space-y-2">
        <div className="text-xs font-medium">1. Pay in Meta</div>
        <p className="text-[11px] text-muted-foreground">
          Meta does not let any app pay for you. Open the account&apos;s billing page, click <b>Add funds</b> and pay {amt > 0 ? <b>{inr(amt, 2)}</b> : 'the amount'} by UPI.
        </p>
        {account && (
          <a href={metaAddFundsUrl(account.accountId)} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
            Open Meta billing <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      <div className="rounded-lg bg-secondary/50 p-3 space-y-2">
        <div className="text-xs font-medium">2. Record it {opened && <span className="font-normal text-muted-foreground">— once Meta shows the payment as successful</span>}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className={label}>Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={field} />
          </div>
          <div>
            <label className={label}>Paid from</label>
            <select value={bankId} onChange={e => setBankId(e.target.value)} className={field}>
              <option value="">Default bank</option>
              {banks.map(b => <option key={b.id} value={b.id}>{b.name}{b.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Allocate to campaign</label>
            <select value={projectId} onChange={e => setProjectId(e.target.value)} className={field}>
              <option value="">{onAccount.length === 1 ? `Auto — ${onAccount[0].name}` : 'Auto (only if one is running)'}</option>
              {onAccount.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>UPI / reference (optional)</label>
            <input value={reference} onChange={e => setReference(e.target.value)} className={field} />
          </div>
        </div>
        <button onClick={record} disabled={busy || amt <= 0 || (!fixedClient && !clientId)}
          className="inline-flex items-center gap-1 rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          I&apos;ve paid — record {amt > 0 ? inr(amt, 2) : 'it'}
        </button>
        <p className="text-[10px] text-muted-foreground">
          Adds the Cashbook entry (Online Spend, tagged to the client), credits their ad wallet and allocates it to the campaign.
          It is not added to the invoice — the client is billed actual spend + GST each month.
        </p>
      </div>
      {err && <p className="text-[11px] text-red-500">{err}</p>}
      {done && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{done}</p>}
    </div>
  )
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

const LEVEL: Record<FundsSuggestion['level'], { text: string; cls: string }> = {
  empty: { text: 'Out of funds', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  low:   { text: 'Running low',  cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  ok:    { text: 'OK',           cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  idle:  { text: 'Not spending', cls: 'bg-secondary text-muted-foreground' },
}

export function SuggestionList({ suggestions, clientName, onPick }: {
  suggestions: FundsSuggestion[]
  clientName: Map<string, string>
  onPick?: (s: FundsSuggestion) => void
}) {
  if (!suggestions.length) return <p className="mt-2 text-xs text-muted-foreground">No client campaigns are spending right now.</p>
  return (
    <div className="mt-3 divide-y divide-border">
      {suggestions.map(s => (
        <div key={s.clientId} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{clientName.get(s.clientId) ?? 'Client'}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${LEVEL[s.level].cls}`}>{LEVEL[s.level].text}</span>
            </div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              Balance {inr(s.balanceInr, 2)} · spending {inr(s.dailyBurnInr)}/day
              {s.runwayDays != null && <> · lasts ~{s.runwayDays} day{s.runwayDays === 1 ? '' : 's'}</>}
            </div>
          </div>
          {s.suggestedInr != null && onPick && (
            <button onClick={() => onPick(s)}
              className="inline-flex items-center gap-1 rounded-lg gradient-bg px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
              <Plus className="h-3.5 w-3.5" /> Add {inr(s.suggestedInr)}
            </button>
          )}
          {s.suggestedInr != null && !onPick && (
            <span className="text-xs font-medium">Suggest adding {inr(s.suggestedInr)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── To-dos ───────────────────────────────────────────────────────────────────

const TODO_ICON: Record<FundsTodo['kind'], React.ReactNode> = {
  unrecorded:  <Info className="h-4 w-4 text-sky-500" />,
  failed:      <XCircle className="h-4 w-4 text-red-500" />,
  unconfirmed: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  unmapped:    <AlertTriangle className="h-4 w-4 text-amber-500" />,
  short:       <AlertTriangle className="h-4 w-4 text-red-500" />,
}

export function TodoList({ todos, data, canManage, clientName, onDone, fixedClientId }: {
  todos: FundsTodo[]
  data: Pick<FundsData, 'clients' | 'campaigns'> & { linkableEntries?: FundsData['linkableEntries'] }
  canManage: boolean
  clientName: Map<string, string>
  onDone: () => void
  fixedClientId?: string
}) {
  if (!todos.length) {
    return <p className="mt-2 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Nothing to check — every Meta payment is recorded and all closed months are invoiced.</p>
  }
  return (
    <div className="mt-3 divide-y divide-border">
      {todos.map(t => <TodoRow key={t.key} t={t} data={data} canManage={canManage} clientName={clientName} onDone={onDone} fixedClientId={fixedClientId} />)}
    </div>
  )
}

function TodoRow({ t, data, canManage, clientName, onDone, fixedClientId }: {
  t: FundsTodo
  data: Pick<FundsData, 'clients' | 'campaigns'> & { linkableEntries?: FundsData['linkableEntries'] }
  canManage: boolean
  clientName: Map<string, string>
  onDone: () => void
  fixedClientId?: string
}) {
  const [clientId, setClientId] = useState(fixedClientId ?? t.suggestedClientId ?? '')
  const [entryId, setEntryId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run(kind: string, fn: () => Promise<{ ok: boolean; error?: string; data?: { warning?: string } | unknown }>) {
    setBusy(kind); setErr(null)
    const r = await fn()
    setBusy(null)
    if (!r.ok) setErr(r.error || 'Failed.')
    else {
      const warning = (r.data as { warning?: string } | undefined)?.warning
      if (warning) setErr(warning)
      onDone()
    }
  }

  const candidates = (data.linkableEntries ?? []).filter(e => t.amount == null || Math.abs(e.amount - t.amount) < 1)

  return (
    <div className="py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{TODO_ICON[t.kind]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t.title}</div>
          <div className="text-[11px] text-muted-foreground">{t.detail}</div>
          {t.kind === 'unrecorded' && t.suggestedClientId && !fixedClientId && (
            <div className="text-[11px] text-sky-600 dark:text-sky-400">Probably for {clientName.get(t.suggestedClientId) ?? 'a client'} — their campaign was spending on this account then.</div>
          )}

          {canManage && t.kind === 'unrecorded' && t.eventId && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {!fixedClientId && (
                <select value={clientId} onChange={e => setClientId(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2 py-1 text-xs">
                  <option value="">Which client?</option>
                  {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <button disabled={!clientId || !!busy}
                onClick={() => run('record', () => recordAdTopUp({ clientId, adAccountId: t.adAccountId ?? '', amount: t.amount ?? 0, fundingEventId: t.eventId }))}
                className="inline-flex items-center gap-1 rounded-lg gradient-bg px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
                {busy === 'record' ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Record for client
              </button>
              {candidates.length > 0 && (
                <>
                  <span className="text-[11px] text-muted-foreground">or already in the Cashbook:</span>
                  <select value={entryId} onChange={e => setEntryId(e.target.value)}
                    className="max-w-[16rem] rounded-lg border border-border bg-background px-2 py-1 text-xs">
                    <option value="">Pick entry…</option>
                    {candidates.map(e => <option key={e.id} value={e.id}>{e.date} — {e.description || 'Entry'} · {inr(e.amount, 2)}</option>)}
                  </select>
                  <button disabled={!entryId || !!busy}
                    onClick={() => run('link', () => linkFundingEventToEntry(t.eventId!, entryId))}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium disabled:opacity-50">
                    <Link2 className="h-3 w-3" /> Link
                  </button>
                </>
              )}
            </div>
          )}
          {t.kind === 'unconfirmed' && <Link href="/dashboard/cashbook" className="mt-1 inline-block text-[11px] underline">Open Cashbook</Link>}
          {t.kind === 'unmapped' && <Link href="/dashboard/connections" className="mt-1 inline-block text-[11px] underline">Map campaign</Link>}
          {t.kind === 'short' && <Link href="/dashboard/invoices?tab=all" className="mt-1 inline-block text-[11px] underline">Open invoices</Link>}
          {err && <p className="mt-1 text-[11px] text-red-500">{err}</p>}
        </div>
        {canManage && t.eventId && (t.kind === 'unrecorded' || t.kind === 'failed') && (
          <button title="Hide this" disabled={!!busy} onClick={() => run('dismiss', () => dismissFundingEvent(t.eventId!))}
            className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50">
            {busy === 'dismiss' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Statement ────────────────────────────────────────────────────────────────

const STATUS: Record<StatementMonth['status'], { text: string; cls: string }> = {
  ok:           { text: 'Invoiced',      cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  short:        { text: 'Under-invoiced', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  over:         { text: 'Over-invoiced', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  not_invoiced: { text: 'Not invoiced',  cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  running:      { text: 'This month',    cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' },
}

/** What the printable client statement needs beyond the numbers. */
export interface StatementDocContext {
  brand: Record<string, string>
  party: (clientId: string) => AdStatementParty | null
  topUps: (clientId: string) => AdStatementTopUp[]
  balance: (clientId: string) => number | null
}

export function StatementView({ statement, clientName, defaultOpen = false, doc }: {
  statement: StatementClient[]
  clientName: Map<string, string>
  defaultOpen?: boolean
  doc?: StatementDocContext
}) {
  if (!statement.length) return <p className="text-xs text-muted-foreground">No ad spend recorded yet.</p>
  return (
    <div className="space-y-3">
      {statement.map(c => <StatementCard key={c.clientId ?? 'unmapped'} c={c} name={c.clientId ? clientName.get(c.clientId) ?? 'Client' : 'Not linked to a client'} defaultOpen={defaultOpen || statement.length === 1} doc={doc} />)}
    </div>
  )
}

function StatementCard({ c, name, defaultOpen, doc }: { c: StatementClient; name: string; defaultOpen: boolean; doc?: StatementDocContext }) {
  const [open, setOpen] = useState(defaultOpen)
  const diffTone = c.differenceInr > 1 ? 'text-red-600 dark:text-red-400' : c.differenceInr < -1 ? 'text-amber-600' : 'text-emerald-600 dark:text-emerald-400'

  // The client document — same letterhead as invoices / Statement of Account.
  const canDoc = !!doc && !!c.clientId
  function docHtml(autoprint: boolean): string {
    if (!doc || !c.clientId) return ''
    return renderAdStatementHtml(c, doc.party(c.clientId) ?? { name }, doc.brand, {
      autoprint, origin: window.location.origin,
      topUps: doc.topUps(c.clientId), balanceInr: doc.balance(c.clientId),
    })
  }
  function printDoc() {
    const w = window.open('', '_blank', 'width=860,height=960')
    if (w) { w.document.write(docHtml(true)); w.document.close() }
  }
  function downloadDoc() {
    const blob = new Blob([docHtml(false)], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const party = doc && c.clientId ? doc.party(c.clientId) : null
    a.href = url
    a.download = `Ad_Spend_Statement_${(party?.code || name).replace(/\s+/g, '_')}_${todayISO()}.html`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden break-inside-avoid">
      {canDoc && (
        <div className="flex justify-end gap-2 px-4 pt-3 print:hidden">
          <button onClick={printDoc}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-secondary">
            <Printer className="h-3.5 w-3.5" /> Print / PDF
          </button>
          <button onClick={downloadDoc}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-secondary">
            <Download className="h-3.5 w-3.5" /> Download
          </button>
        </div>
      )}
      <button onClick={() => setOpen(v => !v)} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-secondary/40">
        <span className="font-semibold">{name}</span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
          <span>Spent <b>{inr(c.spendInclGst, 2)}</b></span>
          <span>Invoiced <b>{inr(c.billedInr, 2)}</b></span>
          <span className={diffTone}>
            {c.clientId === null ? 'Cannot be invoiced' : c.differenceInr > 1 ? `${inr(c.differenceInr, 2)} not invoiced` : c.differenceInr < -1 ? `${inr(-c.differenceInr, 2)} invoiced extra` : 'All invoiced'}
          </span>
          <ChevronDown className={`h-4 w-4 transition-transform print:hidden ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      <div className={open ? 'block' : 'hidden print:block'}>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Month / campaign</th>
                <th className="px-3 py-2 text-right">Days</th>
                <th className="px-3 py-2 text-right">Ad cost</th>
                <th className="px-3 py-2 text-right">GST 18%</th>
                <th className="px-3 py-2 text-right">Spent</th>
                <th className="px-3 py-2 text-right">Invoiced</th>
                <th className="px-3 py-2 text-right">Difference</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...c.months].reverse().map(m => (
                <MonthRows key={m.period} m={m} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2 text-[10px] text-muted-foreground">
          Spent = Meta-reported cost + 18% GST (what Meta actually charged). Invoiced = ad-spend lines plus older lines that billed top-ups.
          If a top-up was billed in a different month from when it was spent, the months can differ — the client total is the one to trust.
        </p>
      </div>
    </div>
  )
}

function MonthRows({ m }: { m: StatementMonth }) {
  const s = STATUS[m.status]
  return (
    <>
      <tr className="bg-secondary/30 font-medium">
        <td className="px-3 py-2">{monthName(m.period)}</td>
        <td />
        <td className="px-3 py-2 text-right tabular-nums">{inr(m.campaigns.reduce((t, c) => t + c.spendExGst, 0), 2)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{inr(m.campaigns.reduce((t, c) => t + c.gst, 0), 2)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{inr(m.spendInclGst, 2)}</td>
        <td className="px-3 py-2 text-right tabular-nums" title={m.invoices.map(i => `${i.number ?? 'Invoice'} (${i.status}) ${inr(i.amountInr, 2)}`).join('\n')}>
          {inr(m.billedInr, 2)}
          {m.invoices.length > 0 && <div className="text-[10px] font-normal text-muted-foreground">{[...new Set(m.invoices.map(i => i.number).filter(Boolean))].join(', ')}</div>}
        </td>
        <td className={`px-3 py-2 text-right tabular-nums ${m.differenceInr > 1 ? 'text-red-600 dark:text-red-400' : ''}`}>{inr(m.differenceInr, 2)}</td>
        <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.cls}`}>{s.text}</span></td>
      </tr>
      {m.campaigns.map(c => (
        <tr key={c.campaignKey} className="text-muted-foreground">
          <td className="px-3 py-1.5 pl-6 truncate max-w-[18rem]" title={c.campaignName}>{c.campaignName}</td>
          <td className="px-3 py-1.5 text-right tabular-nums">{c.days}</td>
          <td className="px-3 py-1.5 text-right tabular-nums">{inr(c.spendExGst, 2)}</td>
          <td className="px-3 py-1.5 text-right tabular-nums">{inr(c.gst, 2)}</td>
          <td className="px-3 py-1.5 text-right tabular-nums">{inr(c.spendInclGst, 2)}</td>
          <td colSpan={3} />
        </tr>
      ))}
    </>
  )
}

// ─── Client workspace panel ───────────────────────────────────────────────────

/** Top-up + suggestion + to-dos + statement for one client (workspace / Client Hub). */
export function ClientAdFundsPanel({ funds, clientName: name, canManage, onDone }: {
  funds: ClientFundsData
  clientName: string
  canManage: boolean
  onDone: () => void
}) {
  const [showForm, setShowForm] = useState(false)
  const names = useMemo(() => new Map([[funds.clientId, name]]), [funds.clientId, name])
  if (!funds.migrated) return null
  const s = funds.suggestion
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Wallet className="h-4 w-4 text-pink-500" /> Meta ad funds</h2>
          <div className="flex items-center gap-2">
            <Link href={`/dashboard/advertising/funds?client=${funds.clientId}`} className="text-xs text-muted-foreground underline">All clients</Link>
            {canManage && (
              <button onClick={() => setShowForm(v => !v)}
                className="inline-flex items-center gap-1 rounded-lg gradient-bg px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
                <Plus className="h-3.5 w-3.5" /> Top up Meta{s?.suggestedInr ? ` (${inr(s.suggestedInr)} suggested)` : ''}
              </button>
            )}
          </div>
        </div>
        {s && <SuggestionList suggestions={[s]} clientName={names} />}
        {showForm && canManage && (
          <TopUpForm clients={funds.clients} accounts={funds.accounts} banks={funds.banks} campaigns={funds.campaigns}
            initialClientId={funds.clientId} initialAmount={s?.suggestedInr ?? null} fixedClient
            onDone={() => { setShowForm(false); onDone() }} />
        )}
        {funds.todos.length > 0 && (
          <TodoList todos={funds.todos} data={{ clients: funds.clients, campaigns: funds.campaigns }} canManage={canManage}
            clientName={names} onDone={onDone} fixedClientId={funds.clientId} />
        )}
      </div>
      {funds.statement && (
        <div>
          <h2 className="mb-2 text-sm font-semibold">Ad spend vs invoiced</h2>
          <StatementView statement={[funds.statement]} clientName={names} defaultOpen doc={{
            brand: funds.brand,
            party: () => funds.clients[0] ?? { name },
            topUps: () => funds.topUps,
            balance: () => funds.suggestion?.balanceInr ?? null,
          }} />
        </div>
      )}
    </div>
  )
}
