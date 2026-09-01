'use client'

import { Fragment, Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import {
  Receipt, Printer, Download, Search, AlertTriangle, Share2,
  TrendingUp, TrendingDown, Wallet, CalendarRange, ChevronRight, Loader2, ListTree,
} from 'lucide-react'
import { getStatementLineItems } from './actions'
import type { StatementLineItem } from './actions'
import { buildStatement } from '@/lib/statements/build'
import type { StatementCredit, StatementInvoice, StatementResult } from '@/lib/statements/build'
import { renderStatementHtml } from '@/lib/statements/render-html'
import { getCurrencySymbol } from '@/lib/calculations/currency'
import { todayISO, monthStartISO, lastDayOfMonthISO } from '@/lib/utils/local-date'
import { whatsappShareUrl } from '@/lib/invoices/share'
import { cn } from '@/lib/utils'
import { unitPriceOf } from '@/lib/invoices/line-math'

interface Client {
  id: string; name: string; code: string | null
  phone: string | null; email: string | null; address: string | null
}
interface Props {
  clients: Client[]
  invoices: (StatementInvoice & { client_id: string | null })[]
  credits: StatementCredit[]
  companySettings: Record<string, string>
  canViewAmounts: boolean
}

type Mode = 'month' | 'quarter' | 'year' | 'range' | 'all'

const QUARTERS = [
  { label: 'Q1 (Apr–Jun)', startMonth: 4 },
  { label: 'Q2 (Jul–Sep)', startMonth: 7 },
  { label: 'Q3 (Oct–Dec)', startMonth: 10 },
  { label: 'Q4 (Jan–Mar)', startMonth: 1 },
]

export default function StatementsClient(props: Props) {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <StatementsInner {...props} />
    </Suspense>
  )
}

function StatementsInner({
  clients, invoices, credits, companySettings, canViewAmounts,
}: Props) {
  // ?client=<id> lets the Invoices page hand off a selection — the "generate
  // statements for the selected invoices" bulk action lands here.
  const searchParams = useSearchParams()
  const [clientId, setClientId] = useState<string>(searchParams.get('client') || '')
  const [clientSearch, setClientSearch] = useState('')
  const [mode, setMode] = useState<Mode>('month')
  const [month, setMonth] = useState(todayISO().slice(0, 7))
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [quarter, setQuarter] = useState(0)
  const [dateFrom, setDateFrom] = useState(monthStartISO())
  const [dateTo, setDateTo] = useState(todayISO())
  const [summaryOnly, setSummaryOnly] = useState(false)

  // ── Line items, expanded per invoice ──────────────────────────────────────
  // Loaded on demand (see actions.ts): a statement expands a handful of rows,
  // and shipping every invoice_items row would outweigh the ledger itself.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [itemsByInvoice, setItemsByInvoice] = useState<Record<string, StatementLineItem[]>>({})
  const [loadingItems, setLoadingItems] = useState<Set<string>>(new Set())
  const [itemsError, setItemsError] = useState<string | null>(null)
  /** Print/download the expanded line items beneath each invoice. */
  const [includeLineItems, setIncludeLineItems] = useState(false)

  async function loadItems(invoiceIds: string[]) {
    const missing = invoiceIds.filter(id => !itemsByInvoice[id])
    if (!missing.length) return
    setLoadingItems(prev => new Set([...prev, ...missing]))
    const res = await getStatementLineItems(missing)
    setLoadingItems(prev => {
      const next = new Set(prev)
      missing.forEach(id => next.delete(id))
      return next
    })
    if (!res.ok) { setItemsError(res.error || 'Could not load line items'); return }
    setItemsError(null)
    // Seed EVERY requested id, so an invoice with genuinely no lines is
    // remembered as loaded-and-empty instead of refetching on each expand.
    setItemsByInvoice(prev => {
      const next = { ...prev }
      missing.forEach(id => { next[id] = [] })
      for (const item of res.data || []) (next[item.invoice_id] ||= []).push(item)
      return next
    })
  }

  async function toggleExpand(invoiceId: string) {
    const isOpen = expanded.has(invoiceId)
    setExpanded(prev => {
      const next = new Set(prev)
      if (isOpen) next.delete(invoiceId); else next.add(invoiceId)
      return next
    })
    if (!isOpen) await loadItems([invoiceId])
  }

  async function toggleAllItems(on: boolean) {
    setIncludeLineItems(on)
    if (!on || !statement) return
    // The printed document needs every invoice's lines, not just the open ones.
    await loadItems(statement.rows.filter(r => r.kind === 'invoice').map(r => r.invoiceId))
  }

  // Only clients that actually have billing history — a statement for a client
  // with no invoices is an empty page nobody wants to generate by accident.
  const billedClients = useMemo(() => {
    const withInvoices = new Set(invoices.map(i => i.client_id).filter(Boolean) as string[])
    return clients.filter(c => withInvoices.has(c.id))
  }, [clients, invoices])

  const visibleClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase()
    if (!q) return billedClients
    return billedClients.filter(c =>
      c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q))
  }, [billedClients, clientSearch])

  const client = useMemo(() => clients.find(c => c.id === clientId) || null, [clients, clientId])

  const { from, to, periodLabel } = useMemo(() => {
    if (mode === 'month') {
      const [y, m] = month.split('-').map(Number)
      return {
        from: `${month}-01`,
        to: lastDayOfMonthISO(y, m),
        periodLabel: new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      }
    }
    if (mode === 'quarter') {
      const q = QUARTERS[quarter]
      const y = Number(year)
      // Q4 is Jan–Mar of the FOLLOWING calendar year in an Apr–Mar fiscal year.
      const startYear = q.startMonth === 1 ? y + 1 : y
      const endMonth = q.startMonth === 1 ? 3 : q.startMonth + 2
      return {
        from: `${startYear}-${String(q.startMonth).padStart(2, '0')}-01`,
        to: lastDayOfMonthISO(startYear, endMonth),
        periodLabel: `${q.label} · FY ${y}–${String(y + 1).slice(2)}`,
      }
    }
    if (mode === 'year') {
      return { from: `${year}-01-01`, to: `${year}-12-31`, periodLabel: year }
    }
    if (mode === 'all') {
      return { from: '0000-01-01', to: '9999-12-31', periodLabel: 'All time' }
    }
    return {
      from: dateFrom, to: dateTo,
      periodLabel: dateFrom && dateTo
        ? `${new Date(dateFrom + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} – ${new Date(dateTo + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`
        : 'Custom range',
    }
  }, [mode, month, year, quarter, dateFrom, dateTo])

  const statement: StatementResult | null = useMemo(() => {
    if (!client) return null
    const mine = invoices.filter(i => i.client_id === client.id)
    if (!mine.length) return null
    const ids = new Set(mine.map(i => i.id))
    // Every client in this database bills in exactly one currency, so the
    // statement can safely present native amounts.
    const currency = mine.find(i => i.currency)?.currency || 'INR'
    return buildStatement({
      invoices: mine,
      credits: credits.filter(c => ids.has(c.invoiceId)),
      from, to, currency,
    })
  }, [client, invoices, credits, from, to])

  const sym = statement ? (getCurrencySymbol(statement.currency as never) || statement.currency) : '₹'
  const money = (n: number) => {
    const v = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return n < 0 ? `(${sym}${v})` : `${sym}${v}`
  }

  function docHtml(autoprint: boolean) {
    if (!statement || !client) return ''
    return renderStatementHtml(statement, client, companySettings, {
      autoprint, periodLabel, summaryOnly,
      lineItems: includeLineItems ? itemsByInvoice : undefined,
    })
  }

  function printStatement() {
    const w = window.open('', '_blank', 'width=860,height=960')
    if (w) { w.document.write(docHtml(true)); w.document.close() }
  }

  function downloadStatement() {
    // A real download event, unlike Print which only offers "Save as PDF".
    const blob = new Blob([docHtml(false)], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Statement_${(client?.code || client?.name || 'client').replace(/\s+/g, '_')}_${from}_${to}.html`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function shareOnWhatsApp() {
    if (!statement || !client) return
    const lines = [
      `*Statement of Account* — ${companySettings.company_name || 'Cirqle Works'}`,
      `${client.name}${client.code ? ` (${client.code})` : ''}`,
      `Period: ${periodLabel}`,
      '',
      `Opening balance: ${money(statement.openingBalance)}`,
      `Invoiced: ${money(statement.totalBilled)}`,
      `Received: ${money(statement.totalReceived)}`,
      `*Balance due: ${money(statement.closingBalance)}*`,
    ]
    if (statement.totalOutstanding > 0) {
      const overdue = statement.aging.filter(b => b.amount > 0 && b.label !== 'Not yet due')
      if (overdue.length) {
        lines.push('', 'Outstanding by age:')
        overdue.forEach(b => lines.push(`  ${b.label}: ${money(b.amount)}`))
      }
    }
    window.open(whatsappShareUrl(lines.join('\n'), client.phone), '_blank')
  }

  const hasStatement = !!statement && !!client

  return (
    <div className="flex flex-col h-full">
      <Header title="Statement of Account" subtitle="Running ledger, ageing and balance due — per client" />

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">

        {/* ── Controls ─────────────────────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">

          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Receipt className="w-4 h-4 text-blue-500" /> Client
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={clientSearch}
                onChange={e => setClientSearch(e.target.value)}
                placeholder="Search client…"
                className="w-full pl-8 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
            <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-0.5">
              {visibleClients.map(c => (
                <button
                  key={c.id}
                  onClick={() => setClientId(c.id)}
                  className={cn(
                    'w-full text-left px-2.5 py-2 rounded-lg text-sm transition-colors',
                    clientId === c.id ? 'bg-blue-500/15 text-foreground font-medium' : 'hover:bg-foreground/5',
                  )}
                >
                  <div className="truncate">{c.name}</div>
                  {c.code && <div className="text-[11px] text-muted-foreground font-mono">{c.code}</div>}
                </button>
              ))}
              {!visibleClients.length && (
                <div className="text-xs text-muted-foreground text-center py-6">No client matches that search.</div>
              )}
            </div>
          </div>

          <div className="bg-card border border-border/60 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CalendarRange className="w-4 h-4 text-violet-500" /> Period
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(['month', 'quarter', 'year', 'range', 'all'] as Mode[]).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className={cn('px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors',
                    mode === m ? 'bg-violet-500 text-white' : 'bg-foreground/5 hover:bg-foreground/10')}>
                  {m === 'range' ? 'Custom' : m === 'all' ? 'All time' : m}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {mode === 'month' && (
                <input type="month" value={month} onChange={e => setMonth(e.target.value)}
                  className="px-3 py-2 text-sm bg-background border border-border rounded-lg" />
              )}
              {(mode === 'quarter' || mode === 'year') && (
                <input type="number" value={year} onChange={e => setYear(e.target.value)}
                  className="w-28 px-3 py-2 text-sm bg-background border border-border rounded-lg" />
              )}
              {mode === 'quarter' && (
                <select value={quarter} onChange={e => setQuarter(Number(e.target.value))}
                  className="px-3 py-2 text-sm bg-background border border-border rounded-lg">
                  {QUARTERS.map((q, i) => <option key={q.label} value={i}>{q.label}</option>)}
                </select>
              )}
              {mode === 'range' && (
                <>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                    className="px-3 py-2 text-sm bg-background border border-border rounded-lg" />
                  <span className="text-muted-foreground text-sm">to</span>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                    className="px-3 py-2 text-sm bg-background border border-border rounded-lg" />
                </>
              )}
              <div className="flex items-center gap-3 ml-auto">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={includeLineItems}
                    onChange={e => void toggleAllItems(e.target.checked)} disabled={summaryOnly} />
                  <ListTree className="w-3.5 h-3.5" /> Line items
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={summaryOnly} onChange={e => setSummaryOnly(e.target.checked)} />
                  Summary only
                </label>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={printStatement} disabled={!hasStatement}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-foreground/5 hover:bg-foreground/10 disabled:opacity-40 transition-colors">
                <Printer className="w-4 h-4" /> Print
              </button>
              <button onClick={downloadStatement} disabled={!hasStatement}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-foreground/5 hover:bg-foreground/10 disabled:opacity-40 transition-colors">
                <Download className="w-4 h-4" /> Download
              </button>
              <button onClick={shareOnWhatsApp} disabled={!hasStatement}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors">
                <Share2 className="w-4 h-4" /> WhatsApp
              </button>
            </div>
          </div>
        </div>

        {/* ── Statement ────────────────────────────────────────────────── */}
        {!hasStatement ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Receipt className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <div className="text-sm text-muted-foreground">Choose a client to build their statement</div>
            <div className="text-xs text-muted-foreground/70 mt-1">
              {billedClients.length} client{billedClients.length === 1 ? '' : 's'} have billing history
            </div>
          </div>
        ) : (
          <>
            {itemsError && (
              <div className="text-xs text-red-500">{itemsError}</div>
            )}
            {statement!.discrepancies.length > 0 && (
              <div className="flex items-start gap-2.5 p-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07]">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-semibold text-amber-600 dark:text-amber-400">
                    {statement!.discrepancies.length} invoice{statement!.discrepancies.length === 1 ? '' : 's'} disagree with the recorded payments
                  </div>
                  <div className="text-muted-foreground mt-0.5">
                    This statement uses the dated payments as the source of truth. Worth checking on the Invoices page:
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {statement!.discrepancies.map(d => (
                      <li key={d.invoiceId} className="font-mono text-[11px]">
                        {d.invoiceNumber}: recorded {money(d.storedPaid)}, payments total {money(d.ledgerPaid)}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Opening balance" value={money(statement!.openingBalance)} icon={Wallet} />
              <Stat label="Invoiced" value={money(statement!.totalBilled)} icon={TrendingUp} tone="text-foreground" />
              <Stat label="Received" value={money(statement!.totalReceived)} icon={TrendingDown} tone="text-emerald-600 dark:text-emerald-400" />
              <Stat label="Balance due" value={money(statement!.closingBalance)} icon={Receipt}
                tone={statement!.closingBalance > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'} emphasise />
            </div>

            {statement!.totalOutstanding > 0 && (
              <div className="bg-card border border-border/60 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Outstanding by age · total {money(statement!.totalOutstanding)}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 divide-x divide-border/40">
                  {statement!.aging.map(b => (
                    <div key={b.label} className="p-3 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{b.label}</div>
                      <div className={cn('text-sm font-bold mt-1',
                        b.amount === 0 ? 'text-muted-foreground/40'
                          : b.label === '90+ days' ? 'text-red-600 dark:text-red-400'
                          : 'text-foreground')}>
                        {money(b.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-card border border-border/60 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border/50 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Ledger · {periodLabel}
                </div>
                <div className="text-xs text-muted-foreground">
                  {statement!.invoiceCount} invoice{statement!.invoiceCount === 1 ? '' : 's'}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border/50">
                      <th className="text-left font-medium px-4 py-2">Date</th>
                      <th className="text-left font-medium px-4 py-2">Reference</th>
                      <th className="text-left font-medium px-4 py-2">Description</th>
                      <th className="text-right font-medium px-4 py-2">Invoiced</th>
                      <th className="text-right font-medium px-4 py-2">Received</th>
                      <th className="text-right font-medium px-4 py-2">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border/30 bg-foreground/[0.02]">
                      <td colSpan={5} className="px-4 py-2 text-xs font-medium text-muted-foreground">Opening balance</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{money(statement!.openingBalance)}</td>
                    </tr>
                    {statement!.rows.map((r, i) => {
                      const isInvoice = r.kind === 'invoice'
                      const isOpen = expanded.has(r.invoiceId) && isInvoice
                      const items = itemsByInvoice[r.invoiceId]
                      const busy = loadingItems.has(r.invoiceId)
                      return (
                        <Fragment key={`${r.invoiceId}-${r.kind}-${i}`}>
                          <tr
                            className={cn('border-b border-border/20 hover:bg-foreground/[0.03]', isInvoice && 'cursor-pointer')}
                            onClick={isInvoice ? () => toggleExpand(r.invoiceId) : undefined}
                          >
                            <td className="px-4 py-2 whitespace-nowrap text-muted-foreground text-xs">
                              {new Date(r.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}
                            </td>
                            <td className="px-4 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                              <span className="inline-flex items-center gap-1">
                                {isInvoice && (
                                  busy
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : <ChevronRight className={cn('w-3 h-3 transition-transform', isOpen && 'rotate-90')} />
                                )}
                                {r.ref}
                              </span>
                            </td>
                            <td className="px-4 py-2">{r.description}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{r.debit ? money(r.debit) : ''}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{r.credit ? money(r.credit) : ''}</td>
                            <td className="px-4 py-2 text-right tabular-nums font-medium">{money(r.balance)}</td>
                          </tr>
                          {isOpen && (
                            <tr className="border-b border-border/20 bg-foreground/[0.02]">
                              <td colSpan={6} className="px-4 py-0">
                                {busy ? (
                                  <div className="py-3 text-xs text-muted-foreground flex items-center gap-2">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading line items…
                                  </div>
                                ) : !items?.length ? (
                                  <div className="py-3 text-xs text-muted-foreground">No line items on this invoice.</div>
                                ) : (
                                  <div className="py-2 pl-6 border-l-2 border-blue-500/30 my-1.5 space-y-1">
                                    {items.map(it => (
                                      <div key={it.id} className="flex items-baseline gap-3 text-xs">
                                        <span className="text-muted-foreground w-16 shrink-0 tabular-nums">
                                          {(it.task_date || it.line_date)
                                            ? new Date((it.task_date || it.line_date)! + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
                                            : ''}
                                        </span>
                                        <span className="flex-1 truncate">
                                          {it.description || it.task_title || 'Item'}
                                          {it.service_name && <span className="text-muted-foreground"> · {it.service_name}</span>}
                                        </span>
                                        {(it.quantity ?? 1) > 1 && unitPriceOf(it) != null && (
                                          <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                                            {it.quantity} × {money(unitPriceOf(it)!)}
                                          </span>
                                        )}
                                        <span className="tabular-nums w-24 text-right shrink-0">
                                          {it.total != null ? money(it.total) : '—'}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                    {!statement!.rows.length && (
                      <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        No invoices or payments in this period. The balance carried forward is {money(statement!.openingBalance)}.
                      </td></tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border/60 font-semibold">
                      <td colSpan={3} className="px-4 py-2.5 text-right text-xs uppercase tracking-wider text-muted-foreground">Closing balance</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{money(statement!.totalBilled)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{money(statement!.totalReceived)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-base">{money(statement!.closingBalance)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {!canViewAmounts && (
              <div className="text-xs text-muted-foreground text-center">
                Some figures may be hidden by your billing permissions.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, icon: Icon, tone, emphasise }: {
  label: string; value: string
  icon: React.ComponentType<{ className?: string }>
  tone?: string; emphasise?: boolean
}) {
  return (
    <div className={cn('bg-card border rounded-xl p-3.5',
      emphasise ? 'border-blue-500/40' : 'border-border/60')}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={cn('text-xl font-bold mt-1 tabular-nums', tone || 'text-foreground')}>{value}</div>
    </div>
  )
}
