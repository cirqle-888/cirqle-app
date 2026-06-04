'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import {
  Landmark, Wallet, TrendingUp, TrendingDown, ArrowLeft,
  ChevronDown, ChevronRight, Plus, Search, Calendar,
  ArrowUpRight, ArrowDownRight,
} from 'lucide-react'
import { round2 } from '@/lib/calculations/currency'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Account {
  id: string
  name: string
  type: string          // 'bank' | 'cash' | 'wallet' | 'other'
  account_number?: string
  bank_name?: string
  opening_balance?: number
  currency?: string
  is_active: boolean
}

interface Entry {
  id: string
  entry_date: string
  type: 'inflow' | 'outflow'
  amount?: number
  amount_inr?: number
  currency: string
  description?: string
  reference?: string
  bank_account_id?: string
  category?: { id: string; name: string; type: string }
  bank_account?: { id: string; name: string; type: string }
  allocations?: { id: string; allocated_amount: number; deleted_at?: string | null; invoice?: { invoice_number: string; client?: { name: string } } }[]
}

interface Category { id: string; name: string; type: string }

interface Props {
  entries: Entry[]
  accounts: Account[]
  categories: Category[]
  isAdmin: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function fmtDate(d: string) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function monthLabel(k: string) {
  const [yr, mo] = k.split('-')
  return new Date(Number(yr), Number(mo) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

function accountIcon(type: string, cls = 'w-5 h-5') {
  return type === 'cash' || type === 'wallet'
    ? <Wallet  className={cls} />
    : <Landmark className={cls} />
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AccountsClient({ entries, accounts, isAdmin }: Props) {
  const [selectedId, setSelectedId]   = useState<string | null>(accounts[0]?.id ?? null)
  const [search, setSearch]           = useState('')
  const [openMonths, setOpenMonths]   = useState<Set<string>>(() => {
    // open the two most-recent months by default
    const months = new Set<string>()
    for (let i = entries.length - 1; i >= 0 && months.size < 2; i--) {
      months.add(entries[i].entry_date.slice(0, 7))
    }
    return months
  })

  // "Cash in Hand" virtual account for entries with no account link
  const CASH_ID = '__cash__'
  const cashAccount: Account = { id: CASH_ID, name: 'Cash in Hand', type: 'cash', is_active: true }
  const hasCash = entries.some(e => !e.bank_account_id)

  const allAccounts: Account[] = [
    ...accounts.filter(a => a.is_active),
    ...(hasCash ? [cashAccount] : []),
  ]

  // ── Per-account summary cards ──────────────────────────────────────────────
  const summaries = useMemo(() => {
    const map: Record<string, { inflow: number; outflow: number; lastDate: string; count: number }> = {}
    for (const a of allAccounts) map[a.id] = { inflow: 0, outflow: 0, lastDate: '', count: 0 }

    for (const e of entries) {
      const k = e.bank_account_id ?? CASH_ID
      if (!map[k]) map[k] = { inflow: 0, outflow: 0, lastDate: '', count: 0 }
      if (e.type === 'inflow')  map[k].inflow  += e.amount_inr ?? 0
      else                      map[k].outflow += e.amount_inr ?? 0
      if (e.entry_date > (map[k].lastDate ?? '')) map[k].lastDate = e.entry_date
      map[k].count++
    }
    return map
  }, [entries])

  const totalBalance = useMemo(() =>
    Object.values(summaries).reduce((s, v) => s + round2(v.inflow - v.outflow), 0)
  , [summaries])

  // ── Entries for the selected account ──────────────────────────────────────
  const selected = allAccounts.find(a => a.id === selectedId)
  const q = search.toLowerCase().trim()

  const accountEntries = useMemo(() => {
    return entries
      .filter(e => (e.bank_account_id ?? CASH_ID) === selectedId)
      .filter(e => !q || (e.description ?? '').toLowerCase().includes(q) || (e.category?.name ?? '').toLowerCase().includes(q))
  }, [entries, selectedId, q])

  // Running balance (oldest → newest, with opening balance if set)
  const opening = accounts.find(a => a.id === selectedId)?.opening_balance ?? 0
  const entriesWithRunning = useMemo(() => {
    let running = opening
    return accountEntries.map(e => {
      running = round2(running + (e.type === 'inflow' ? (e.amount_inr ?? 0) : -(e.amount_inr ?? 0)))
      return { ...e, running }
    })
  }, [accountEntries, opening])

  // Group by month (newest first for display)
  const byMonth = useMemo(() => {
    const map: Record<string, typeof entriesWithRunning> = {}
    for (const e of entriesWithRunning) {
      const k = e.entry_date.slice(0, 7)
      if (!map[k]) map[k] = []
      map[k].push(e)
    }
    return Object.entries(map)
      .sort(([a], [b]) => b.localeCompare(a))  // newest month first
      .map(([k, rows]) => ({
        key: k,
        label: monthLabel(k),
        entries: [...rows].reverse(),  // within each month: newest first
        inflow:  rows.reduce((s, e) => s + (e.type === 'inflow'  ? (e.amount_inr ?? 0) : 0), 0),
        outflow: rows.reduce((s, e) => s + (e.type === 'outflow' ? (e.amount_inr ?? 0) : 0), 0),
        closingBalance: rows[rows.length - 1]?.running ?? opening,
      }))
  }, [entriesWithRunning, opening])

  const toggleMonth = (k: string) =>
    setOpenMonths(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })

  const sel = summaries[selectedId ?? '']
  const selBalance = sel ? round2(sel.inflow - sel.outflow) : 0

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <Header
        title="Account Balances"
        subtitle="Detailed ledger view per account"
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/cashbook"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground border border-border bg-secondary rounded-lg px-3 py-2 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Cash Book
            </Link>
            <Link
              href="/dashboard/cashbook?addEntry=1"
              className="flex items-center gap-1.5 text-sm font-medium gradient-bg text-white rounded-lg px-3 py-2 hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" /> Add Entry
            </Link>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">

        {/* ── Account cards row ────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {allAccounts.map(acct => {
            const s = summaries[acct.id]
            const bal = s ? round2(s.inflow - s.outflow) : 0
            const isSelected = selectedId === acct.id
            const isPos = bal >= 0
            return (
              <button
                key={acct.id}
                onClick={() => { setSelectedId(acct.id); setSearch('') }}
                className={`text-left rounded-xl border p-4 transition-all ${
                  isSelected
                    ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card hover:border-border/80 hover:bg-secondary/30'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                    acct.type === 'cash' || acct.type === 'wallet' ? 'bg-amber-500/10 text-amber-500' : 'bg-primary/10 text-primary'
                  }`}>
                    {accountIcon(acct.type)}
                  </div>
                  {isSelected && (
                    <span className="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Selected</span>
                  )}
                </div>
                <p className="text-sm font-semibold truncate mb-0.5">{acct.name}</p>
                {acct.bank_name && <p className="text-[11px] text-muted-foreground/70 truncate mb-2">{acct.bank_name}{acct.account_number ? ` · ···${acct.account_number.slice(-4)}` : ''}</p>}
                <p className={`text-xl font-bold tabular-nums ${isPos ? 'text-foreground' : 'text-red-400'}`}>
                  {isPos ? '' : '−'}{inr(Math.abs(bal))}
                </p>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px] text-muted-foreground">{s?.count ?? 0} entries</span>
                  {s?.lastDate && <span className="text-[11px] text-muted-foreground/60">{fmtDate(s.lastDate)}</span>}
                </div>
              </button>
            )
          })}

          {/* Total card */}
          <div className="rounded-xl border border-border bg-secondary/20 p-4 flex flex-col justify-between">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-9 h-9 rounded-lg bg-foreground/5 flex items-center justify-center">
                <span className="text-sm font-bold text-muted-foreground">Σ</span>
              </div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total</span>
            </div>
            <p className={`text-xl font-bold tabular-nums ${totalBalance >= 0 ? 'text-foreground' : 'text-red-400'}`}>
              {totalBalance >= 0 ? '' : '−'}{inr(Math.abs(totalBalance))}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">across {allAccounts.length} account{allAccounts.length !== 1 ? 's' : ''}</p>
          </div>
        </div>

        {/* ── Selected account ledger ──────────────────────────────────────── */}
        {selected && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            {/* Ledger header */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border bg-secondary/30">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  selected.type === 'cash' || selected.type === 'wallet' ? 'bg-amber-500/10 text-amber-500' : 'bg-primary/10 text-primary'
                }`}>
                  {accountIcon(selected.type, 'w-4 h-4')}
                </div>
                <div>
                  <span className="text-sm font-semibold">{selected.name}</span>
                  {selected.bank_name && <span className="text-xs text-muted-foreground ml-2">{selected.bank_name}</span>}
                </div>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <span className="text-muted-foreground">In: <span className="text-green-400 font-semibold">{inr(sel?.inflow ?? 0)}</span></span>
                <span className="text-muted-foreground">Out: <span className="text-red-400 font-semibold">{inr(sel?.outflow ?? 0)}</span></span>
                <span className={`font-bold text-base tabular-nums ${selBalance >= 0 ? 'text-foreground' : 'text-red-400'}`}>
                  {selBalance >= 0 ? '' : '−'}{inr(Math.abs(selBalance))}
                </span>
              </div>
            </div>

            {/* Search */}
            <div className="px-4 py-2.5 border-b border-border bg-secondary/10">
              <div className="flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2 max-w-sm">
                <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search description, category…"
                  className="bg-transparent text-sm flex-1 focus:outline-none placeholder:text-muted-foreground/50"
                />
              </div>
            </div>

            {/* Opening balance row */}
            {opening !== 0 && (
              <div className="flex items-center gap-3 px-4 py-2.5 bg-secondary/20 border-b border-border text-xs text-muted-foreground">
                <span className="flex-1">Opening balance</span>
                <span className="font-mono font-semibold text-foreground tabular-nums">{inr(opening)}</span>
              </div>
            )}

            {accountEntries.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                {q ? 'No entries match your search.' : 'No entries for this account.'}
              </div>
            ) : (
              <div>
                {byMonth.map(({ key, label, entries: rows, inflow, outflow, closingBalance }) => {
                  const isOpen = openMonths.has(key)
                  return (
                    <div key={key} className="border-b border-border last:border-b-0">
                      {/* Month accordion header */}
                      <button
                        onClick={() => toggleMonth(key)}
                        className="w-full flex items-center gap-3 px-4 py-3 bg-secondary/25 hover:bg-secondary/40 transition-colors text-left"
                      >
                        <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="text-xs font-semibold text-foreground uppercase tracking-wide flex-1">{label}</span>
                        <span className="text-xs text-green-400 font-mono tabular-nums">+{inr(inflow)}</span>
                        <span className="mx-1 text-muted-foreground/40 text-xs">·</span>
                        <span className="text-xs text-red-400 font-mono tabular-nums">−{inr(outflow)}</span>
                        <span className="mx-2 text-muted-foreground/40 text-xs">|</span>
                        <span className="text-xs font-semibold tabular-nums text-foreground">{inr(closingBalance)}</span>
                        {isOpen
                          ? <ChevronDown  className="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-1" />
                          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-1" />}
                      </button>

                      {/* Entry rows */}
                      {isOpen && (
                        <div>
                          {/* Column header */}
                          <div className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[90px_1fr_120px_auto_110px] gap-x-3 px-4 py-1.5 border-b border-border/50 bg-secondary/10">
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide hidden sm:block">Date</span>
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Description</span>
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide hidden sm:block">Category</span>
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Amount</span>
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right hidden sm:block">Running Bal.</span>
                          </div>
                          {rows.map(e => {
                            const isIn = e.type === 'inflow'
                            const amt  = e.amount_inr ?? 0
                            const inv  = (e.allocations ?? []).find(a => !a.deleted_at && a.invoice)?.invoice
                            return (
                              <div
                                key={e.id}
                                className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[90px_1fr_120px_auto_110px] gap-x-3 items-center px-4 py-2.5 border-b border-border/40 hover:bg-secondary/20 transition-colors last:border-b-0"
                              >
                                {/* Date */}
                                <span className="text-xs text-muted-foreground tabular-nums hidden sm:block whitespace-nowrap">{fmtDate(e.entry_date)}</span>

                                {/* Description */}
                                <div className="min-w-0">
                                  <p className="text-xs font-medium truncate">
                                    {e.description || (isIn ? 'Income' : 'Expense')}
                                  </p>
                                  {inv && (
                                    <p className="text-[11px] text-muted-foreground/70 truncate">
                                      {inv.invoice_number}{inv.client?.name ? ` · ${inv.client.name}` : ''}
                                    </p>
                                  )}
                                  <p className="text-[11px] text-muted-foreground/60 sm:hidden">{fmtDate(e.entry_date)}</p>
                                </div>

                                {/* Category */}
                                {e.category ? (
                                  <span className="text-[11px] text-muted-foreground truncate hidden sm:block">{e.category.name}</span>
                                ) : <span className="hidden sm:block" />}

                                {/* Amount */}
                                <div className="flex items-center gap-1 justify-end shrink-0">
                                  {isIn
                                    ? <ArrowUpRight   className="w-3 h-3 text-green-400 shrink-0" />
                                    : <ArrowDownRight className="w-3 h-3 text-red-400 shrink-0" />}
                                  <span className={`text-sm font-semibold tabular-nums ${isIn ? 'text-green-400' : 'text-red-400'}`}>
                                    {isIn ? '+' : '−'}{inr(amt)}
                                  </span>
                                </div>

                                {/* Running balance */}
                                <span className="text-xs font-mono font-semibold tabular-nums text-right hidden sm:block text-foreground/80">
                                  {e.running >= 0 ? '' : '−'}{inr(Math.abs(e.running))}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Footer summary */}
            {accountEntries.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 bg-secondary/30 border-t border-border">
                <span className="text-xs text-muted-foreground">{accountEntries.length} entries total</span>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-muted-foreground">Balance:</span>
                  <span className={`font-bold tabular-nums ${selBalance >= 0 ? 'text-foreground' : 'text-red-400'}`}>
                    {selBalance >= 0 ? '' : '−'}{inr(Math.abs(selBalance))}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
