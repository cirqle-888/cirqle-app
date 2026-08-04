'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, RefreshCw, AlertTriangle, Check } from 'lucide-react'
import { formatTaskDate } from '@/lib/utils/format-date'
import { computeTaskAmount, resolvePricingType } from '@/lib/tasks/pricing'

interface Client { id: string; name: string; code?: string | null }
interface Service { id: string; name: string; pricing_type?: string | null; default_price?: number | null }
interface Pricing {
  client_id: string
  service_id: string
  price?: number | null
  percentage_rate?: number | null
  currency?: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  clients: Client[]
  services: Service[]
  clientPricings: Pricing[]
  onApplied?: (affected: number) => void
}

interface TaskRow {
  id: string
  task_number: number | null
  title: string
  client_id: string
  service_id: string
  task_date: string
  quantity: number | null
  billing_amount_inr: number | null
  parent_task_id: string | null
}

interface PreviewRow {
  task: TaskRow
  client?: Client
  service?: Service
  pricing?: Pricing
  current: number
  next: number
  delta: number
}

/**
 * Compute the billing amount a task should have, given matrix + service config.
 * Delegates to the shared pricing engine so a bulk recalc can never disagree
 * with what the task forms would have computed for the same task.
 *
 * `quantity` carries the pricing type's own unit (creatives / hours / ad spend),
 * which is why it feeds all three inputs — see resolveTaskQuantity. The rate for
 * percentage_of_spend lives in its own column here, hence percentRate.
 */
function computeBilling(task: TaskRow, service?: Service, pricing?: Pricing): number {
  if (!service) return 0
  const qty = task.quantity ?? 1
  return computeTaskAmount({
    pricingType: resolvePricingType(service.pricing_type),
    unitPrice:   pricing?.price ?? service.default_price ?? 0,
    quantity:    qty,
    hours:       qty,
    spend:       qty,
    percentRate: pricing?.percentage_rate ?? 0,
  })
}

export function RecalcBillingModal({ open, onClose, clients, services, clientPricings, onApplied }: Props) {
  const supabase = createClient()

  // Form state
  const [scope, setScope] = useState<'zero_only' | 'all'>('zero_only')
  const [filterClient, setFilterClient] = useState('')
  const [filterService, setFilterService] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Result state
  const [loading, setLoading] = useState(false)
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null)
  const [totalMatching, setTotalMatching] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<{ affected: number; failed: number } | null>(null)

  // Reset everything when modal reopens
  useEffect(() => {
    if (!open) return
    setScope('zero_only')
    setFilterClient('')
    setFilterService('')
    setDateFrom('')
    setDateTo('')
    setPreviewRows(null)
    setTotalMatching(null)
    setError(null)
    setApplied(null)
  }, [open])

  const clientById  = useMemo(() => Object.fromEntries(clients.map(c => [c.id, c])), [clients])
  const serviceById = useMemo(() => Object.fromEntries(services.map(s => [s.id, s])), [services])
  const pricingByKey = useMemo(() => {
    const map: Record<string, Pricing> = {}
    clientPricings.forEach(p => { map[`${p.client_id}|${p.service_id}`] = p })
    return map
  }, [clientPricings])

  /** Build the Supabase query for tasks matching the current filter. */
  function buildQuery(countOnly = false) {
    let q = supabase.from('tasks')
      .select('id, task_number, title, client_id, service_id, task_date, quantity, billing_amount_inr, parent_task_id',
              countOnly ? { count: 'exact', head: true } : { count: 'exact' })
      .is('parent_task_id', null)  // never touch variant tasks
    if (scope === 'zero_only') q = q.or('billing_amount_inr.is.null,billing_amount_inr.eq.0')
    if (filterClient)  q = q.eq('client_id', filterClient)
    if (filterService) q = q.eq('service_id', filterService)
    if (dateFrom)      q = q.gte('task_date', dateFrom)
    if (dateTo)        q = q.lte('task_date', dateTo)
    return q
  }

  const PREVIEW_LIMIT = 500  // show up to 500 rows in the scrollable list

  async function runPreview() {
    setLoading(true); setError(null); setApplied(null); setPreviewRows(null)
    try {
      const { data, error: err, count } = await buildQuery(false)
        .order('task_number', { ascending: false, nullsFirst: false })
        .limit(PREVIEW_LIMIT)
      if (err) { setError(err.message); return }
      const rows: PreviewRow[] = (data ?? []).map((t: any) => {
        const svc = serviceById[t.service_id]
        const price = pricingByKey[`${t.client_id}|${t.service_id}`]
        const next = computeBilling(t, svc, price)
        const current = t.billing_amount_inr ?? 0
        return {
          task: t, client: clientById[t.client_id], service: svc, pricing: price,
          current, next, delta: next - current,
        }
      })
      setPreviewRows(rows)
      setTotalMatching(count ?? rows.length)
    } catch (e: any) {
      setError(e.message || 'Preview failed')
    } finally {
      setLoading(false)
    }
  }

  // Auto-load preview when modal opens or filters change — user can see at-a-glance which
  // tasks need pricing without clicking anything.
  useEffect(() => {
    if (!open) return
    runPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, filterClient, filterService, dateFrom, dateTo])

  // Stats from the preview rows (used to surface "X still need a matrix entry")
  const previewStats = useMemo(() => {
    if (!previewRows) return null
    const willChange   = previewRows.filter(r => r.next !== r.current).length
    const willStillBeZero = previewRows.filter(r => r.next === 0).length
    return { willChange, willStillBeZero }
  }, [previewRows])

  async function runApply() {
    if (totalMatching == null) { await runPreview(); return }
    if (!confirm(`Apply new billing amounts to ${totalMatching} task${totalMatching === 1 ? '' : 's'}? This will overwrite existing values.`)) return
    setLoading(true); setError(null); setApplied(null)
    try {
      // Fetch ALL matching tasks (not just 30), then batch-update
      const { data, error: err } = await buildQuery(false).limit(10_000)
      if (err) { setError(err.message); return }
      const tasks = (data ?? []) as TaskRow[]
      let success = 0, failed = 0
      const BATCH = 50
      for (let i = 0; i < tasks.length; i += BATCH) {
        const slice = tasks.slice(i, i + BATCH)
        // Update each task individually in parallel (Supabase has no JOIN-update)
        const results = await Promise.all(slice.map(async t => {
          const svc = serviceById[t.service_id]
          const price = pricingByKey[`${t.client_id}|${t.service_id}`]
          const amt = computeBilling(t, svc, price)
          const { error: updErr } = await supabase
            .from('tasks')
            .update({ billing_amount_inr: amt, billing_amount: amt })
            .eq('id', t.id)
          return !updErr
        }))
        success += results.filter(Boolean).length
        failed  += results.filter(r => !r).length
      }
      setApplied({ affected: success, failed })
      onApplied?.(success)
    } catch (e: any) {
      setError(e.message || 'Apply failed')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const fmtINR = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="font-semibold flex items-center gap-2"><RefreshCw className="w-4 h-4 text-violet-400" /> Recalculate Task Billing</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Apply current Pricing Matrix to existing tasks.</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {/* Scope */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">Scope</label>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer p-2.5 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60">
                <input type="radio" checked={scope === 'zero_only'} onChange={() => setScope('zero_only')} className="mt-0.5 accent-violet-500" />
                <div>
                  <div className="text-sm font-medium">Only tasks with ₹0 / no billing</div>
                  <div className="text-[11px] text-muted-foreground">Safe — leaves manually priced tasks untouched. Recommended.</div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer p-2.5 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60">
                <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} className="mt-0.5 accent-violet-500" />
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">All tasks <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /></div>
                  <div className="text-[11px] text-amber-700 dark:text-amber-300/80">Overwrites every task&apos;s billing — including manually edited ones.</div>
                </div>
              </label>
            </div>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">Client (optional)</label>
              <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-violet-500/50">
                <option value="">All clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">Service (optional)</label>
              <select value={filterService} onChange={e => setFilterService(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-violet-500/50">
                <option value="">All services</option>
                {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">Task date from</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-violet-500/50" />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">Task date to</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-violet-500/50" />
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>
          )}

          {applied && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 text-xs text-green-700 dark:text-green-300 flex items-center gap-2">
              <Check className="w-3.5 h-3.5" />
              Updated {applied.affected} task{applied.affected === 1 ? '' : 's'}.{applied.failed > 0 && ` ${applied.failed} failed.`}
            </div>
          )}

          {/* Summary stats — visible the moment the modal opens */}
          {previewStats && totalMatching != null && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">Matching</div>
                <div className="text-lg font-bold text-foreground">{totalMatching}</div>
              </div>
              <div className="rounded-lg border border-green-500/30 bg-green-500/[0.06] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-green-400/80 font-semibold">Will be fixed</div>
                <div className="text-lg font-bold text-green-700 dark:text-green-300">{previewStats.willChange - previewStats.willStillBeZero}</div>
              </div>
              <div className={`rounded-lg border px-3 py-2 ${previewStats.willStillBeZero > 0 ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-border bg-secondary/30'}`}>
                <div className={`text-[10px] uppercase tracking-wider font-semibold ${previewStats.willStillBeZero > 0 ? 'text-amber-400/80' : 'text-muted-foreground/70'}`}>Missing matrix entry</div>
                <div className={`text-lg font-bold ${previewStats.willStillBeZero > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-foreground'}`}>{previewStats.willStillBeZero}</div>
              </div>
            </div>
          )}

          {previewRows && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                  {previewRows.length < (totalMatching ?? 0)
                    ? `Showing first ${previewRows.length} of ${totalMatching}`
                    : `${previewRows.length} task${previewRows.length === 1 ? '' : 's'}`}
                </p>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Still ₹0 (matrix missing)</span>
                </div>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="max-h-[40vh] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-secondary/60 sticky top-0 z-10">
                      <tr className="border-b border-border">
                        <th className="text-left px-2.5 py-2 font-medium text-muted-foreground bg-secondary/95 backdrop-blur-sm">#</th>
                        <th className="text-left px-2.5 py-2 font-medium text-muted-foreground bg-secondary/95 backdrop-blur-sm">Task</th>
                        <th className="text-left px-2.5 py-2 font-medium text-muted-foreground bg-secondary/95 backdrop-blur-sm">Client / Service</th>
                        <th className="text-right px-2.5 py-2 font-medium text-muted-foreground bg-secondary/95 backdrop-blur-sm">Date</th>
                        <th className="text-right px-2.5 py-2 font-medium text-muted-foreground bg-secondary/95 backdrop-blur-sm">Current</th>
                        <th className="text-right px-2.5 py-2 font-medium text-violet-400 bg-secondary/95 backdrop-blur-sm">New</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.length === 0 ? (
                        <tr><td colSpan={6} className="px-2.5 py-6 text-center text-muted-foreground">No tasks match the current filters.</td></tr>
                      ) : previewRows.map(r => {
                        const stillZero = r.next === 0
                        return (
                          <tr key={r.task.id} className={`border-b border-border/30 last:border-b-0 ${stillZero ? 'bg-amber-500/[0.04]' : ''}`}>
                            <td className="px-2.5 py-2 font-mono text-muted-foreground">#{r.task.task_number ?? '?'}</td>
                            <td className="px-2.5 py-2 max-w-[160px] truncate" title={r.task.title}>{r.task.title}</td>
                            <td className="px-2.5 py-2 text-muted-foreground">
                              <div className="truncate max-w-[160px]" title={r.client?.name}>{r.client?.name ?? '—'}</div>
                              <div className="text-[10px] truncate max-w-[160px]" title={r.service?.name}>{r.service?.name ?? '—'}</div>
                            </td>
                            <td className="px-2.5 py-2 text-right font-mono">{formatTaskDate(r.task.task_date)}</td>
                            <td className="px-2.5 py-2 text-right font-mono text-muted-foreground">{fmtINR(r.current)}</td>
                            <td className={`px-2.5 py-2 text-right font-mono font-semibold ${
                              stillZero ? 'text-amber-700 dark:text-amber-300'
                              : r.next > r.current ? 'text-green-400'
                              : r.next < r.current ? 'text-red-400'
                              : 'text-foreground'
                            }`}>
                              {fmtINR(r.next)}
                              {stillZero && <div className="text-[9px] font-normal text-amber-400/70 normal-case mt-0.5">add to matrix</div>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              {previewStats && previewStats.willStillBeZero > 0 && (
                <div className="mt-2 flex items-start gap-2 bg-amber-500/[0.06] border border-amber-500/30 rounded-lg px-3 py-2 text-[11px] text-amber-700 dark:text-amber-200">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">{previewStats.willStillBeZero} task{previewStats.willStillBeZero === 1 ? '' : 's'}</span> would still show ₹0 after recalc because the Pricing Matrix has no entry for that client + service combo.
                    Add a price for those rows in the matrix above, then click Preview again.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border shrink-0">
          <div className="text-xs text-muted-foreground">
            {totalMatching != null && <>Will affect <span className="font-semibold text-foreground">{totalMatching}</span> task{totalMatching === 1 ? '' : 's'}</>}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:text-foreground">
              Close
            </button>
            <button type="button" onClick={runPreview} disabled={loading}
              className="px-3 py-2 rounded-lg border border-violet-500/40 bg-violet-500/10 text-xs font-medium text-violet-700 dark:text-violet-200 hover:bg-violet-500/20 disabled:opacity-50">
              {loading && !applied ? 'Loading…' : 'Preview'}
            </button>
            <button type="button" onClick={runApply} disabled={loading || (totalMatching != null && totalMatching === 0)}
              className="px-3 py-2 rounded-lg gradient-bg text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {loading && previewRows ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
