'use client'

/**
 * The Cash Book allocation board: filters, one-click suggestions, and an
 * editor for one unit / General / a split by % or ₹ / left out.
 */

import { useMemo, useState } from 'react'
import { Lightbulb, Pencil, Plus, Sparkles, X } from 'lucide-react'
import { Badge, Button, Card, Empty, Table, useAction } from '../../finance/profit-sharing/_components'
import { inr, inputCls, td, tdNum } from '../../finance/profit-sharing/_format'
import { allocateEntry, applySuggestions, type EntryAllocationChoice } from '../actions'
import { percentsByWeight } from '@/lib/units/suggest'

export interface BoardRow {
  id: string
  date: string
  type: 'inflow' | 'outflow'
  amountInr: number
  description: string | null
  categoryName: string | null
  status: 'unit' | 'split' | 'general' | 'excluded' | 'waiting'
  current: string
  manual: boolean
  split: { parts: { unitId: string; share: number }[]; basis: 'percent' | 'amount' } | null
  unitId: string | null
  suggestion: { label: string; reason: string; confidence: 'high' | 'medium' } | null
}

type Unit = { id: string; name: string; color: string | null; sharesGeneralCosts: boolean }
type Filter = 'all' | 'waiting' | 'suggested' | 'unit' | 'split' | 'general' | 'excluded'

const STATUS_TONE: Record<BoardRow['status'], 'good' | 'info' | 'warn' | 'muted' | 'bad'> = {
  unit: 'good', split: 'info', general: 'info', excluded: 'muted', waiting: 'warn',
}

export function AllocateBoard({ month, rows, units, totals, generalSplitBetween, revenueByUnit }: {
  month: string
  rows: BoardRow[]
  units: Unit[]
  revenueByUnit: Record<string, number>
  totals: { payments: number; units: number; split: number; general: number; excluded: number; waiting: number; waitingCount: number; suggested: number }
  generalSplitBetween: string[]
}) {
  const { run, busy, host } = useAction()
  const [filter, setFilter] = useState<Filter>(totals.waitingCount ? 'waiting' : 'all')
  const [editing, setEditing] = useState<string | null>(null)
  const shown = useMemo(() => rows.filter(r =>
    filter === 'all' ? true : filter === 'suggested' ? r.status === 'waiting' && !!r.suggestion : r.status === filter,
  ), [rows, filter])

  const tile = (label: string, value: string, hint?: string, warn?: boolean) => (
    <div className={`rounded-lg border p-3 ${warn ? 'border-amber-500/50 bg-amber-500/5' : 'border-border bg-card'}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )

  return (
    <div className="space-y-5">
      {host}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tile('Company payments', inr(totals.payments))}
        {tile('To one unit', inr(totals.units))}
        {tile('Split', inr(totals.split))}
        {tile('General', inr(totals.general), generalSplitBetween.length ? `equally: ${generalSplitBetween.join(', ')}` : 'no unit carries it')}
        {tile('Left out', inr(totals.excluded), 'not a unit cost')}
        {tile('Waiting', inr(totals.waiting), `${totals.waitingCount} entries · ${totals.suggested} with a suggestion`, totals.waitingCount > 0)}
      </div>

      <p className="text-xs text-muted-foreground">
        Revenue this month, for splitting by revenue:{' '}
        {units.map((u, i) => <span key={u.id}>{i ? ' · ' : ''}<b className="text-foreground">{u.name}</b> {inr(revenueByUnit[u.id] ?? 0)}</span>)}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {([['waiting', 'Waiting'], ['suggested', 'With a suggestion'], ['unit', 'One unit'], ['split', 'Split'], ['general', 'General'], ['excluded', 'Left out'], ['all', 'All']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === k ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {l} <span className="tabular-nums opacity-70">{k === 'all' ? rows.length : k === 'suggested' ? totals.suggested : rows.filter(r => r.status === k).length}</span>
            </button>
          ))}
        </div>
        {totals.suggested > 0 && (
          <Button variant="primary" busy={busy === 'all'} onClick={() => run('all', async () => {
            const r = await applySuggestions(month)
            return r.ok ? { ok: true } : r
          }, `Applied ${totals.suggested} suggestions`)}>
            <Sparkles className="h-3.5 w-3.5" /> Apply all {totals.suggested} suggestions
          </Button>
        )}
      </div>

      <Card title={`Entries (${shown.length})`} subtitle="Invoice payments, transfers and rebilled costs are not listed: they are counted elsewhere or are not a unit's cost.">
        {shown.length === 0 ? <Empty>Nothing here.</Empty> : (
          <Table head={['Date', 'Entry', 'Amount', 'Now', 'Suggestion', '']}>
            {shown.map(r => (
              <Row key={r.id} r={r} units={units} month={month} revenueByUnit={revenueByUnit} editing={editing === r.id} setEditing={setEditing} />
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

function Row({ r, units, month, revenueByUnit, editing, setEditing }: {
  r: BoardRow; units: Unit[]; month: string; revenueByUnit: Record<string, number>; editing: boolean; setEditing: (id: string | null) => void
}) {
  const { run, busy, host } = useAction()
  return (
    <>
      <tr className="border-b border-border/60 last:border-0">
        <td className={td}><span className="whitespace-nowrap text-xs">{r.date}</span></td>
        <td className={td}>
          <div className="text-sm">{r.description ?? '—'}</div>
          <div className="text-[11px] text-muted-foreground">{r.categoryName ?? 'No category'}</div>
        </td>
        <td className={tdNum}><span className={r.type === 'inflow' ? 'text-emerald-600 dark:text-emerald-400' : ''}>{r.type === 'inflow' ? '+' : '−'}{inr(r.amountInr)}</span></td>
        <td className={td}>
          <div className="flex flex-col gap-1">
            <Badge tone={STATUS_TONE[r.status]}>{r.status === 'waiting' ? 'Waiting' : r.status === 'excluded' ? 'Left out' : r.status}</Badge>
            {r.status !== 'waiting' && <span className="text-[11px] text-muted-foreground">{r.current}{r.manual ? '' : ' · automatic'}</span>}
          </div>
        </td>
        <td className={td}>
          {host}
          {r.suggestion ? (
            <div className="space-y-1">
              <div className="flex items-start gap-1 text-xs"><Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" /><span className="font-medium">{r.suggestion.label}</span></div>
              <div className="text-[11px] text-muted-foreground">{r.suggestion.reason}{r.suggestion.confidence === 'medium' ? ' · check' : ''}</div>
              <Button busy={busy === 'one'} onClick={() => run('one', async () => {
                const res = await applySuggestions(month, [r.id])
                return res.ok ? { ok: true } : res
              }, 'Applied')}>Apply</Button>
            </div>
          ) : r.status === 'waiting' ? <span className="text-[11px] text-muted-foreground">No clear signal — decide by hand</span> : null}
        </td>
        <td className={td}>
          <button aria-label="Change allocation" className="rounded-md border border-border p-1.5 hover:bg-secondary" onClick={() => setEditing(editing ? null : r.id)}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </td>
      </tr>
      {editing && (
        <tr className="border-b border-border/60 bg-muted/20">
          <td colSpan={6} className="px-2 py-3"><Editor r={r} units={units} revenueByUnit={revenueByUnit} onDone={() => setEditing(null)} /></td>
        </tr>
      )}
    </>
  )
}

function Editor({ r, units, revenueByUnit, onDone }: { r: BoardRow; units: Unit[]; revenueByUnit: Record<string, number>; onDone: () => void }) {
  const { run, busy, host } = useAction()
  type Mode = 'unit' | 'split' | 'general' | 'exclude' | 'auto'
  const [mode, setMode] = useState<Mode>(r.status === 'split' ? 'split' : r.status === 'general' && r.manual ? 'general' : r.status === 'excluded' && r.manual ? 'exclude' : r.unitId ? 'unit' : 'unit')
  const [unitId, setUnitId] = useState(r.unitId ?? units[0]?.id ?? '')
  const [basis, setBasis] = useState<'percent' | 'amount'>(r.split?.basis ?? 'percent')
  const [parts, setParts] = useState<{ unitId: string; value: number }[]>(
    r.split?.parts.map(p => ({ unitId: p.unitId, value: p.share }))
      ?? units.slice(0, 2).map((u, i, a) => ({ unitId: u.id, value: Math.round((100 / a.length) * 100) / 100 + (i === 0 ? 100 - Math.round((100 / a.length) * 100) / 100 * a.length : 0) })),
  )
  const target = basis === 'percent' ? 100 : Math.round(r.amountInr * 100) / 100
  const total = Math.round(parts.reduce((t, p) => t + (Number(p.value) || 0), 0) * 100) / 100
  const left = Math.round((target - total) * 100) / 100

  function switchBasis(b: 'percent' | 'amount') {
    if (b === basis) return
    // Convert what is typed so the split keeps its shape.
    setParts(parts.map(p => ({ ...p, value: Math.round((b === 'amount' ? (p.value / 100) * r.amountInr : (p.value / (r.amountInr || 1)) * 100) * 100) / 100 })))
    setBasis(b)
  }

  async function save() {
    const choice: EntryAllocationChoice =
      mode === 'unit' ? { kind: 'unit', unitId }
      : mode === 'split' ? { kind: 'split', basis, parts: parts.map(p => ({ unitId: p.unitId, value: Number(p.value) })) }
      : { kind: mode }
    const ok = await run('save', () => allocateEntry(r.id, choice), 'Saved')
    if (ok) onDone()
  }

  const opt = (m: Mode, label: string) => (
    <label className="flex items-center gap-1.5 text-sm"><input type="radio" checked={mode === m} onChange={() => setMode(m)} /> {label}</label>
  )

  return (
    <div className="space-y-3">
      {host}
      <div className="flex flex-wrap gap-4">
        {opt('unit', 'One unit')}
        {opt('split', 'Split between units')}
        {opt('general', 'General (split equally)')}
        {opt('exclude', 'Leave out')}
        {opt('auto', 'Automatic')}
      </div>

      {mode === 'unit' && (
        <select aria-label="Unit" className={`${inputCls} max-w-xs`} value={unitId} onChange={e => setUnitId(e.target.value)}>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      )}

      {mode === 'split' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Enter as</span>
            {(['percent', 'amount'] as const).map(b => (
              <button key={b} onClick={() => switchBasis(b)}
                className={`rounded-md border px-2 py-0.5 ${basis === b ? 'border-primary bg-primary/10' : 'border-border'}`}>{b === 'percent' ? '%' : '₹'}</button>
            ))}
            <span className={`ml-auto font-medium tabular-nums ${Math.abs(left) < 0.01 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'}`}>
              {Math.abs(left) < 0.01 ? 'Adds up' : `${left > 0 ? 'Left' : 'Over'}: ${basis === 'percent' ? `${Math.abs(left)}%` : inr(Math.abs(left))}`}
            </span>
          </div>
          {parts.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <select aria-label="Unit in split" className={inputCls} value={p.unitId}
                onChange={e => setParts(parts.map((x, j) => j === i ? { ...x, unitId: e.target.value } : x))}>
                {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <div className="relative w-36 shrink-0">
                <input type="number" min={0} step="0.01" className={`${inputCls} pr-7 text-right`} value={p.value} aria-label="Share"
                  onChange={e => setParts(parts.map((x, j) => j === i ? { ...x, value: Number(e.target.value) } : x))} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{basis === 'percent' ? '%' : '₹'}</span>
              </div>
              <button title="Give this unit whatever is still left" disabled={Math.abs(left) < 0.01}
                className="whitespace-nowrap rounded-md border border-border px-2 py-1 text-[11px] hover:bg-secondary disabled:opacity-40"
                onClick={() => setParts(parts.map((x, j) => j === i ? { ...x, value: Math.max(0, Math.round((x.value + left) * 100) / 100) } : x))}>Rest here</button>
              <span className="w-24 text-right text-[11px] tabular-nums text-muted-foreground">
                {basis === 'percent' ? inr((p.value / 100) * r.amountInr) : `${Math.round((p.value / (r.amountInr || 1)) * 1000) / 10}%`}
              </span>
              <button aria-label="Remove from split" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary"
                onClick={() => setParts(parts.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => {
              const free = units.find(u => !parts.some(p => p.unitId === u.id))
              if (free) setParts([...parts, { unitId: free.id, value: Math.max(0, left) }])
            }}><Plus className="h-3.5 w-3.5" /> Add unit</Button>
            <Button onClick={() => {
              const n = parts.length || 1
              const each = Math.floor((target / n) * 100) / 100
              setParts(parts.map((p, i) => ({ ...p, value: i === 0 ? Math.round((target - each * (n - 1)) * 100) / 100 : each })))
            }}>Split equally</Button>
            <Button disabled={!units.some(u => (revenueByUnit[u.id] ?? 0) > 0)} onClick={() => {
              // Every unit with revenue this month, by its share of that revenue.
              const earning = units.filter(u => (revenueByUnit[u.id] ?? 0) > 0)
              const pct = percentsByWeight(earning.map(u => revenueByUnit[u.id]))
              setBasis('percent')
              setParts(earning.map((u, i) => ({ unitId: u.id, value: pct[i] })))
            }}>By revenue</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            <b>Split equally</b> gives each unit the same. <b>By revenue</b> uses each unit&apos;s income this month.
            <b> Rest here</b> gives a unit whatever is still left — for a fixed amount to one unit and the remainder to another.
          </p>
        </div>
      )}

      {mode === 'general' && <p className="text-xs text-muted-foreground">Shared equally, each month, between the units that carry general costs.</p>}
      {mode === 'exclude' && <p className="text-xs text-muted-foreground">Not a cost of any unit — a loan, an owner&apos;s withdrawal, money moving between accounts.</p>}
      {mode === 'auto' && <p className="text-xs text-muted-foreground">Back to the automatic rules: its service, its category, or waiting.</p>}

      <div className="flex gap-2">
        <Button variant="primary" busy={busy === 'save'} onClick={save}>Save</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  )
}
