'use client'

/**
 * Derived Billing panel — the rule editor inside the Task Edit modal.
 *
 * A derived task ("Social Media Handling") is priced as a % of other tasks'
 * billing. This panel shows what the rule currently is, what it computed, and
 * the controls over it.
 *
 * Progressive disclosure, deliberately: the summary strip plus source services
 * and percentage are always visible; the lock, the source-task list, manual
 * recalculation and pause/archive live behind "Advanced", because on a normal
 * day none of them are needed. The amount itself is never a plain input — it is
 * computed, and typing over it would be silently undone by the next recompute.
 */

import { useState } from 'react'
import { RefreshCw, Lock, Unlock, Pause, Play, Archive, ChevronRight } from 'lucide-react'
import {
  serverSetDerivedOverride, serverRecalculateDerivedTask, serverSetDerivedRuleState,
} from '@/app/(dashboard)/dashboard/tasks/actions'
import { parseBillingRule, type BillingRule } from '@/lib/tasks/derived-billing'
import { formatCurrency } from '@/lib/calculations/currency'
import type { Currency } from '@/types'

interface Snapshot {
  basis_count?: number
  basis_sum_inr?: number
  basis_task_ids?: string[]
  computed_at?: string
  percent?: number
}

export interface DerivedBillingPanelProps {
  taskId: string
  taskStatus: string
  billingRule: unknown
  billingSnapshot: unknown
  amount: number | null
  currency: string
  services: { id: string; name: string }[]
  /** Loaded tasks, for naming the basis rows in the source viewer. */
  tasks?: { id: string; task_number?: number | null; title?: string | null; billing_amount?: number | null }[]
  onRuleChange: (rule: BillingRule) => void
  onRefresh?: () => void
}

const inputCls =
  'w-full bg-background border border-input rounded-lg px-3 py-2 text-sm shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20'

export function DerivedBillingPanel({
  taskId, taskStatus, billingRule, billingSnapshot, amount, currency,
  services, tasks = [], onRuleChange, onRefresh,
}: DerivedBillingPanelProps) {
  const parsed = parseBillingRule(billingRule)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showSources, setShowSources] = useState(false)
  const [overrideInput, setOverrideInput] = useState('')

  if (!parsed.ok) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-700 dark:text-amber-300">
        This task’s billing rule could not be read: {parsed.error}
      </div>
    )
  }
  const rule = parsed.rule
  const snap = (billingSnapshot ?? {}) as Snapshot

  const locked = !!rule.override
  const archived = !!rule.archivedAt
  const paused = rule.paused === true && !archived
  const billed = taskStatus === 'invoiced' || taskStatus === 'paid'

  const status = billed ? 'Final (invoiced)'
    : archived ? 'Archived'
    : locked ? 'Locked'
    : paused ? 'Paused'
    : 'Active'
  const statusTone = billed || archived ? 'bg-secondary text-muted-foreground border-border'
    : locked ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'
    : paused ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25'
    : 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/25'

  const sourceNames = rule.sources.serviceIds
    .map(id => services.find(s => s.id === id)?.name ?? 'Service')
  const set = (patch: Partial<BillingRule>) => onRuleChange({ ...rule, ...patch })

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(key); setMsg(null)
    const res = await fn()
    setBusy(null)
    setMsg(res.ok ? { kind: 'ok', text: okText } : { kind: 'err', text: res.error ?? 'Failed' })
    if (res.ok) onRefresh?.()
  }

  const basisIds = snap.basis_task_ids ?? []
  const basisRows = basisIds
    .map(id => tasks.find(t => t.id === id))
    .filter(Boolean) as NonNullable<DerivedBillingPanelProps['tasks']>

  return (
    <div className="rounded-xl border border-violet-500/25 bg-violet-500/[0.04] p-4 space-y-3">
      {/* ── Summary strip ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
            Billed from other services
            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal ${statusTone}`}>
              {status}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {rule.percent}% of {sourceNames.join(' + ') || '—'}
            {snap.basis_count != null && <> · {snap.basis_count} matching task{snap.basis_count === 1 ? '' : 's'} this month</>}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold">{formatCurrency(amount ?? 0, currency as Currency)}</p>
          {snap.computed_at && (
            <p className="text-[10px] text-muted-foreground/70">
              updated {new Date(snap.computed_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground/80">
        {billed ? 'This task has been invoiced, so the amount is final.'
          : locked ? 'Amount is locked to a manual figure — automatic updates are paused.'
          : 'Recalculates automatically when the source tasks change.'}
      </p>

      {/* ── Basic: sources + percent ──────────────────────────────────────── */}
      {!billed && (
        <>
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Source services</label>
            <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {services.map(s => {
                const on = rule.sources.serviceIds.includes(s.id)
                return (
                  <button
                    key={s.id} type="button"
                    onClick={() => set({
                      sources: {
                        ...rule.sources,
                        serviceIds: on
                          ? rule.sources.serviceIds.filter(id => id !== s.id)
                          : [...rule.sources.serviceIds, s.id],
                      },
                    })}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on ? 'border-violet-500 bg-violet-500 text-white'
                         : 'border-border bg-secondary text-muted-foreground hover:border-foreground/30'}`}
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="w-32">
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Percentage</label>
            <div className="flex items-center gap-1">
              <input
                type="number" min="0" max="100" step="any"
                value={rule.percent || ''}
                onChange={e => set({ percent: parseFloat(e.target.value) || 0 })}
                className={inputCls}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </>
      )}

      {msg && (
        <p className={`text-[11px] ${msg.kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
          {msg.text}
        </p>
      )}

      {/* ── Advanced ──────────────────────────────────────────────────────── */}
      <details className="rounded-lg border border-foreground/10">
        <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground">
          Advanced
        </summary>
        <div className="space-y-3 border-t border-foreground/[0.06] px-2.5 pb-2.5 pt-2.5">

          {/* Min / max charge */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Minimum charge (₹)</label>
              <input
                type="number" min="0" step="any" placeholder="none"
                value={rule.clamps?.minInr ?? ''}
                onChange={e => set({ clamps: { ...rule.clamps, minInr: e.target.value === '' ? null : parseFloat(e.target.value) } })}
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Maximum charge (₹)</label>
              <input
                type="number" min="0" step="any" placeholder="none"
                value={rule.clamps?.maxInr ?? ''}
                onChange={e => set({ clamps: { ...rule.clamps, maxInr: e.target.value === '' ? null : parseFloat(e.target.value) } })}
                className={inputCls}
              />
            </div>
          </div>

          {/* Source task viewer */}
          {basisIds.length > 0 && (
            <div>
              <button type="button" onClick={() => setShowSources(v => !v)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                <ChevronRight className={`h-3 w-3 transition-transform ${showSources ? 'rotate-90' : ''}`} />
                Based on {basisIds.length} task{basisIds.length === 1 ? '' : 's'}
                {snap.basis_sum_inr != null && ` · ₹${snap.basis_sum_inr.toLocaleString('en-IN')} total`}
              </button>
              {showSources && (
                <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                  {basisRows.map(t => (
                    <div key={t.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate">
                        {t.task_number ? <span className="text-muted-foreground">#{t.task_number} </span> : null}
                        {t.title}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatCurrency(t.billing_amount ?? 0, currency as Currency)}
                      </span>
                    </div>
                  ))}
                  {basisRows.length < basisIds.length && (
                    <p className="text-[10px] text-muted-foreground/60">
                      {basisIds.length - basisRows.length} more not on this page
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Manual lock */}
          {!billed && (
            <div className="rounded-lg border border-border p-2">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Manual amount</p>
              {locked ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    Locked at {formatCurrency(rule.override!.amount, currency as Currency)}
                    {rule.override!.note ? ` — ${rule.override!.note}` : ''}
                  </p>
                  <button type="button" disabled={busy !== null}
                    onClick={() => run('unlock', () => serverSetDerivedOverride(taskId, null), 'Unlocked — recalculated')}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40">
                    <Unlock className="h-3 w-3" /> Unlock
                  </button>
                </div>
              ) : (
                <div className="flex items-end gap-2">
                  <input
                    type="number" min="0" step="any" placeholder="e.g. 200"
                    value={overrideInput} onChange={e => setOverrideInput(e.target.value)}
                    className={inputCls}
                  />
                  <button type="button"
                    disabled={busy !== null || !overrideInput}
                    onClick={() => run('lock',
                      () => serverSetDerivedOverride(taskId, parseFloat(overrideInput)),
                      'Amount locked')}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-2 text-[11px] hover:bg-muted disabled:opacity-40">
                    <Lock className="h-3 w-3" /> Lock
                  </button>
                </div>
              )}
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                Locking keeps an agreed figure even when the source tasks change.
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={busy !== null || locked || billed}
              onClick={() => run('recalc',
                () => serverRecalculateDerivedTask(taskId),
                'Recalculated')}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted disabled:opacity-40">
              <RefreshCw className={`h-3 w-3 ${busy === 'recalc' ? 'animate-spin' : ''}`} /> Recalculate now
            </button>

            {!archived && (
              <button type="button" disabled={busy !== null}
                onClick={() => run('state',
                  () => serverSetDerivedRuleState(taskId, paused ? 'active' : 'paused'),
                  paused ? 'Rule resumed' : 'Rule paused')}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted disabled:opacity-40">
                {paused ? <><Play className="h-3 w-3" /> Resume</> : <><Pause className="h-3 w-3" /> Pause</>}
              </button>
            )}

            <button type="button" disabled={busy !== null}
              onClick={() => run('archive',
                () => serverSetDerivedRuleState(taskId, archived ? 'active' : 'archived'),
                archived ? 'Rule restored' : 'Rule archived')}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted disabled:opacity-40">
              <Archive className="h-3 w-3" /> {archived ? 'Restore' : 'Archive'}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            Archiving stops future months without touching anything already billed.
            Every recalculation is recorded on the Activity tab.
          </p>
        </div>
      </details>
    </div>
  )
}
