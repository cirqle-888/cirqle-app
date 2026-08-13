'use client'

/**
 * Packages — one screen: what's committed, what's delivered, what's left.
 *
 * Deliberately one list and one primary action. The essential fields (client,
 * name, type, price, start, what's included) are always visible; everything
 * optional (end date, extra-work rate, notes, status) folds away, so committing
 * a package is six fields.
 *
 * Progress is DERIVED here from the linked tasks using the same pure function
 * the invoice builder uses, never read from a stored figure — see
 * @/lib/packages/progress.
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { OverflowMenu } from '@/components/ui/overflow-menu'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { formatDate } from '@/lib/utils/format-date'
import { resolveCoverageForPackage, cycleForMonth, lastDayOfMonth } from '@/lib/packages/progress'
import type { PackageBillingType, PackageStatus, PackageTaskLike } from '@/lib/packages/types'
import {
  savePackage, setPackageStatus, deletePackage,
  type PackageWithItems, type PackageItemInput,
} from './actions'
import {
  Plus, X, Package as PackageIcon, Pencil, Trash2, Pause, Play,
  CheckCircle2, AlertTriangle, ExternalLink, ChevronLeft, ChevronRight, Receipt,
} from 'lucide-react'

const CURRENCIES = ['INR', 'AED', 'USD', 'SAR', 'QAR', 'GBP', 'EUR']

const money = (cur: string, n: number) =>
  cur === 'INR' ? `₹${Math.round(n).toLocaleString('en-IN')}` : `${cur} ${Math.round(n).toLocaleString('en-US')}`

const thisMonth = () => new Date().toISOString().slice(0, 7)
const today = () => new Date().toISOString().slice(0, 10)

/** "2026-08" → "Aug 2026". Named explicitly so "this month" is never ambiguous. */
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${MON[m] ?? '?'} ${y}`
}

/** Step a `YYYY-MM` by whole months, rolling the year over correctly. */
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return d.toISOString().slice(0, 7)
}

const STATUS_CHIP: Record<PackageStatus, string> = {
  active:    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
  paused:    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
  completed: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25',
  cancelled: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25',
}

interface FormState {
  id?: string
  clientId: string
  name: string
  billingType: PackageBillingType
  price: string
  currency: string
  extraTaskPrice: string
  startDate: string
  endDate: string
  firstCycleEnd: string
  status: PackageStatus
  notes: string
  items: { id?: string; serviceId: string; includedQuantity: string }[]
}

const emptyForm = (): FormState => ({
  clientId: '', name: '', billingType: 'monthly', price: '', currency: 'INR',
  extraTaskPrice: '', startDate: today(), endDate: '', firstCycleEnd: '',
  status: 'active', notes: '',
  items: [{ serviceId: '', includedQuantity: '1' }],
})

const fromRow = (p: PackageWithItems): FormState => ({
  id: p.id,
  clientId: p.client_id,
  name: p.name,
  billingType: p.billing_type,
  price: String(p.price ?? ''),
  currency: p.currency,
  extraTaskPrice: p.extra_task_price != null ? String(p.extra_task_price) : '',
  startDate: p.start_date,
  endDate: p.end_date ?? '',
  firstCycleEnd: p.first_cycle_end ?? '',
  status: p.status,
  notes: p.notes ?? '',
  items: (p.items ?? []).map(i => ({
    id: i.id, serviceId: i.service_id, includedQuantity: String(i.included_quantity),
  })),
})

interface LinkedTask extends PackageTaskLike {
  package_id: string | null
  title: string
  status: string
}

/** Where a package has been billed, and whether that money has arrived. */
export interface PackageBilling {
  packageId: string
  invoices: { id: string; number: string | null; status: string | null; paid: boolean }[]
  /** Every invoice carrying this package's fee is settled. */
  allPaid: boolean
  anyBilled: boolean
}

/** Finished business — kept, but out of the way. */
const ARCHIVED: PackageStatus[] = ['completed', 'cancelled']

/**
 * Deep link to exactly the work behind a figure on this page.
 *
 * Ids, not names: `?q=Elara` would also match a differently-named client whose
 * text happens to contain it, and the count on the card would not match the
 * list it opens.
 */
function tasksHref(
  clientId: string,
  range: { from: string; to: string } | null,
  serviceId?: string,
): string {
  const p = new URLSearchParams({ client: clientId })
  if (serviceId) p.set('service', serviceId)
  if (range) { p.set('from', range.from); p.set('to', range.to) }
  return `/dashboard/tasks?${p.toString()}`
}

export default function PackagesClient({
  initialPackages, loadError, clients, services, linkedTasks, billing, canManage,
}: {
  initialPackages: PackageWithItems[]
  loadError: string | null
  clients: { id: string; name: string; code: string | null; is_active: boolean | null }[]
  services: { id: string; name: string; is_active: boolean | null }[]
  linkedTasks: LinkedTask[]
  billing: PackageBilling[]
  canManage: boolean
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [, startTransition] = useTransition()
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PackageWithItems | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  // A monthly package's allowance resets each month, so "delivered" is only
  // meaningful against a stated month. One selector drives every card.
  const [month, setMonth] = useState(thisMonth())

  const packages = initialPackages

  // Name lookups run over EVERY client/service so an archived one still
  // resolves on a package that already references it. The pickers below offer
  // only active records, so a new package can't be built on a dead one.
  const clientName = (id: string) => clients.find(c => c.id === id)?.name ?? '—'
  const serviceName = (id: string) => services.find(s => s.id === id)?.name ?? '—'

  const clientOptions = useMemo(
    () => clients.filter(c => c.is_active !== false).map(c => ({ id: c.id, label: c.name, sub: c.code ?? undefined })),
    [clients],
  )
  const serviceOptions = useMemo(
    () => services.filter(s => s.is_active !== false).map(s => ({ id: s.id, label: s.name })),
    [services],
  )

  const refresh = () => startTransition(() => router.refresh())

  // package_id → its tasks. Computed once, reused by every card.
  const tasksByPackage = useMemo(() => {
    const m = new Map<string, LinkedTask[]>()
    for (const t of linkedTasks) {
      if (!t.package_id) continue
      const arr = m.get(t.package_id)
      if (arr) arr.push(t)
      else m.set(t.package_id, [t])
    }
    return m
  }, [linkedTasks])

  const activeCount = packages.filter(p => p.status === 'active').length

  // Finished packages move out of the way rather than out of existence — the
  // history still has to be reachable, so they fold into a section instead of
  // being deleted.
  const live = packages.filter(p => !ARCHIVED.includes(p.status))
  const archived = packages.filter(p => ARCHIVED.includes(p.status))
  const billingByPackage = useMemo(
    () => new Map(billing.map(b => [b.packageId, b])),
    [billing],
  )

  async function handleSave() {
    if (!form) return
    setSaving(true)
    const res = await savePackage({
      id: form.id,
      clientId: form.clientId,
      name: form.name,
      billingType: form.billingType,
      price: Number(form.price) || 0,
      currency: form.currency,
      extraTaskPrice: form.extraTaskPrice.trim() === '' ? null : Number(form.extraTaskPrice),
      startDate: form.startDate,
      endDate: form.endDate || null,
      firstCycleEnd: form.firstCycleEnd || null,
      status: form.status,
      notes: form.notes || null,
      items: form.items
        .filter(i => i.serviceId)
        .map((i): PackageItemInput => ({
          id: i.id, serviceId: i.serviceId, includedQuantity: Number(i.includedQuantity) || 0,
        })),
    })
    setSaving(false)
    if (res.ok) {
      success(
        form.id ? 'Package updated' : 'Package created',
        `${form.name.trim()} — ${money(form.currency, Number(form.price) || 0)}${form.billingType === 'monthly' ? ' a month' : ' one-time'}`,
      )
      setForm(null)
      setShowAdvanced(false)
      refresh()
    } else {
      toastError('Could not save', res.error)
    }
  }

  async function changeStatus(p: PackageWithItems, status: PackageStatus) {
    setBusyId(p.id)
    const res = await setPackageStatus(p.id, status)
    setBusyId(null)
    if (res.ok) { success(`${p.name} ${status}`); refresh() }
    else toastError('Could not update', res.error)
  }

  async function applyDelete(p: PackageWithItems) {
    setBusyId(p.id)
    const res = await deletePackage(p.id)
    setBusyId(null)
    if (res.ok) { success(`${p.name} deleted`); refresh() }
    else toastError('Could not delete', res.error)
  }

  const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'
  const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

  return (
    <>
      <Header
        title="Packages"
        subtitle={
          activeCount > 0
            ? `${activeCount} active · billed as one line, tracked task by task`
            : 'Work committed at one agreed price — tracked here, billed as a single invoice line'
        }
        actions={canManage ? (
          <button onClick={() => { setForm(emptyForm()); setShowAdvanced(false) }}
            className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap">
            <Plus className="w-4 h-4" /> Add
          </button>
        ) : undefined}
      />

      <div className="p-4 md:p-6 space-y-4 max-w-4xl">
        {loadError && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            Couldn&rsquo;t load packages. {loadError}
          </div>
        )}

        {/* Month selector — only matters when a monthly package is on screen. */}
        {packages.some(p => p.billing_type === 'monthly') && (
          <div className="flex items-center gap-1">
            <button onClick={() => setMonth(m => shiftMonth(m, -1))}
              aria-label="Previous month"
              className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-medium tabular-nums px-2 min-w-[5.5rem] text-center">
              {monthLabel(month)}
            </span>
            <button onClick={() => setMonth(m => shiftMonth(m, 1))}
              aria-label="Next month"
              className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            {month !== thisMonth() && (
              <button onClick={() => setMonth(thisMonth())}
                className="ml-1 text-[11px] text-primary hover:underline">
                Back to {monthLabel(thisMonth())}
              </button>
            )}
          </div>
        )}

        {live.length === 0 && archived.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={PackageIcon}
              title="No packages yet"
              body="A package is work you've committed to at one agreed price — a monthly retainer, or a one-off bundle. Add the tasks in Tasks as usual and tick them onto the package; the invoice then shows one line for the package instead of every task, and this page tracks what's still owed."
              action={canManage ? { label: 'Add a package', onClick: () => setForm(emptyForm()) } : undefined}
            />
          </div>
        ) : (
          <div className="space-y-3">
            {live.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing running right now — everything is archived below.
              </p>
            )}
            {live.map(p => {
              const tasks = tasksByPackage.get(p.id) ?? []
              const cycle = cycleForMonth(p, month)
              const bill = billingByPackage.get(p.id)
              // One-time cycles are unbounded, so a date range would be
              // meaningless — the link filters by client and service alone.
              const range = p.billing_type === 'monthly'
                ? { from: cycle.start, to: cycle.end }
                : null
              const cov = resolveCoverageForPackage(p, tasks, p.items, month)
              const pct = cov.totalIncluded > 0
                ? Math.min(100, Math.round((cov.totalDelivered / cov.totalIncluded) * 100))
                : 0
              const extras = cov.extraTaskIds.length
              // An extended opening cycle carries ONE allowance across several
              // months, so naming the month alone would misread as a reset.
              const periodLabel = p.billing_type !== 'monthly'
                ? 'in total'
                : cycle.isFirstCycle
                  ? `in the first cycle (${formatDate(cycle.start)} → ${formatDate(cycle.end)})`
                  : `in ${monthLabel(month)}`
              // Linked work that falls outside the cycle on screen. Without
              // this, a card can read "1 linked task · 0 delivered" and look
              // broken when it is simply showing a different month.
              const outsideMonth = p.billing_type === 'monthly'
                ? tasks.filter(t => {
                    const d = String(t.task_date ?? '')
                    return d < cycle.start || d > cycle.end
                  }).length
                : 0

              return (
                <div key={p.id} className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="px-4 py-3.5 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{p.name}</p>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border">
                          {p.billing_type === 'monthly' ? 'Monthly' : 'One-time'}
                        </span>
                        {p.status !== 'active' && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border capitalize ${STATUS_CHIP[p.status]}`}>
                            {p.status}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <Link href={`/dashboard/clients/${p.client_id}`} className="hover:text-foreground hover:underline">
                          {clientName(p.client_id)}
                        </Link>
                        {' · '}{formatDate(p.start_date)} → {p.end_date ? formatDate(p.end_date) : 'ongoing'}
                      </p>
                      {p.billing_type === 'monthly' && p.first_cycle_end && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          First cycle {formatDate(p.start_date)} → {formatDate(lastDayOfMonth(p.first_cycle_end.slice(0, 7)))} —
                          billed once, then monthly.
                        </p>
                      )}
                    </div>

                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold">{money(p.currency, p.price)}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {p.billing_type === 'monthly' ? 'per month' : 'one-time'}
                      </p>
                    </div>

                    {canManage && (
                      <OverflowMenu
                        items={[
                          { label: 'Edit', icon: Pencil, onClick: () => { setForm(fromRow(p)); setShowAdvanced(false) } },
                          p.status === 'active'
                            ? { label: 'Pause billing', icon: Pause, onClick: () => changeStatus(p, 'paused'), disabled: busyId === p.id }
                            : { label: 'Resume', icon: Play, onClick: () => changeStatus(p, 'active'), disabled: busyId === p.id },
                          { label: 'Mark completed', icon: CheckCircle2, onClick: () => changeStatus(p, 'completed'), disabled: busyId === p.id || p.status === 'completed' },
                          { label: 'Delete', icon: Trash2, danger: true, separatorBefore: true, onClick: () => setDeleteTarget(p) },
                        ]}
                      />
                    )}
                  </div>

                  {/* Progress — derived, never stored */}
                  {cov.totalIncluded > 0 && (
                    <div className="px-4 pb-3">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
                        <span>
                          <span className="font-semibold text-foreground tabular-nums">{cov.totalDelivered}</span>
                          {' of '}{cov.totalIncluded} delivered {periodLabel}
                          {/* A task that exists but isn't done is not delivered —
                              saying so is the difference between "we're finished"
                              and "someone still has to finish it". */}
                          {cov.totalScheduled > 0 && (
                            <> · <span className="tabular-nums text-blue-600 dark:text-blue-400">{cov.totalScheduled}</span> in progress</>
                          )}
                          {cov.totalRemaining > 0 && <> · <span className="tabular-nums">{cov.totalRemaining}</span> left</>}
                        </span>
                        <span className="tabular-nums">{pct}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${extras > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>

                      {/* Per included line */}
                      <div className="mt-2.5 space-y-1">
                        {cov.perItem.map(it => (
                          <div key={it.serviceId} className="flex items-center justify-between text-[11px]">
                            {/* Straight to the work behind this figure: this
                                client, this service, this cycle. */}
                            <Link
                              href={tasksHref(p.client_id, range, it.serviceId)}
                              className="text-muted-foreground truncate hover:text-foreground hover:underline"
                            >
                              {serviceName(it.serviceId)}
                            </Link>
                            <span className="tabular-nums shrink-0 ml-3">
                              <span className="text-foreground font-medium">{it.delivered}</span>
                              <span className="text-muted-foreground">/{it.included}</span>
                              {it.scheduled > 0 && (
                                <span className="ml-1.5 text-blue-600 dark:text-blue-400">+{it.scheduled} in progress</span>
                              )}
                              {it.extra > 0 && (
                                <span className="ml-1.5 text-amber-600 dark:text-amber-400">+{it.extra} extra</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>

                      {extras > 0 && (
                        <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                          <span>
                            {extras} task{extras === 1 ? '' : 's'} beyond what&rsquo;s included — billed separately
                            {p.extra_task_price != null
                              ? ` at ${money(p.currency, p.extra_task_price)} each`
                              : ' at the normal price'}.
                          </span>
                        </p>
                      )}

                      {outsideMonth > 0 && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {outsideMonth} more linked task{outsideMonth === 1 ? '' : 's'} outside this period — the
                          allowance resets each cycle, so {outsideMonth === 1 ? 'it counts' : 'they count'} toward
                          {outsideMonth === 1 ? ' its' : ' their'} own.
                        </p>
                      )}

                      {cov.unmatchedTaskIds.length > 0 && (
                        <p className="mt-2 text-[11px] text-muted-foreground flex items-start gap-1.5">
                          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                          <span>
                            {cov.unmatchedTaskIds.length} linked task{cov.unmatchedTaskIds.length === 1 ? ' is' : 's are'} on
                            a service this package doesn&rsquo;t include — {cov.unmatchedTaskIds.length === 1 ? 'it bills' : 'they bill'} on
                            {cov.unmatchedTaskIds.length === 1 ? ' its' : ' their'} own. Add the service above, or unlink.
                          </span>
                        </p>
                      )}
                    </div>
                  )}

                  {cov.totalIncluded === 0 && (
                    <p className="px-4 pb-3 text-[11px] text-muted-foreground">
                      Nothing is listed as included yet, so nothing can be tracked against this package.
                    </p>
                  )}

                  {/*
                    Everything committed has been delivered. Say so, and offer
                    the one action that follows — the alternative is the owner
                    having to notice 2/2 and remember what to do about it.
                  */}
                  {canManage && p.status === 'active' && cov.totalIncluded > 0
                    && cov.totalDelivered >= cov.totalIncluded && p.billing_type === 'one_time' && (
                    <div className="mx-4 mb-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5">
                      <p className="text-[11px] text-emerald-700 dark:text-emerald-300 flex items-start gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span>
                          <strong>Everything included has been delivered.</strong>{' '}
                          {bill?.anyBilled
                            ? bill.allPaid
                              ? 'The invoice is paid, so this can be closed and archived.'
                              : 'It has been invoiced but not yet paid — worth waiting for the money before archiving.'
                            : 'It has not been invoiced yet.'}
                        </span>
                      </p>
                      <button
                        onClick={() => changeStatus(p, 'completed')}
                        disabled={busyId === p.id}
                        className="mt-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 hover:underline disabled:opacity-50"
                      >
                        {busyId === p.id ? 'Saving…' : 'Mark completed & archive'}
                      </button>
                    </div>
                  )}

                  {(tasks.length > 0 || bill?.anyBilled) && (
                    <div className="px-4 py-2 border-t border-border/60 bg-secondary/20 flex items-center gap-3 flex-wrap">
                      {tasks.length > 0 && (
                        <Link
                          href={tasksHref(p.client_id, range)}
                          className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          {/* Every linked task the link will actually show —
                              unfinished ones included, or the count on the card
                              would not match the list it opens. */}
                          {cov.totalDelivered + cov.totalScheduled + cov.unmatchedTaskIds.length} task
                          {cov.totalDelivered + cov.totalScheduled + cov.unmatchedTaskIds.length === 1 ? '' : 's'}
                          {p.billing_type === 'monthly' ? ' this cycle' : ''}
                          {' '}<ExternalLink className="w-3 h-3" />
                        </Link>
                      )}
                      {bill?.anyBilled && (
                        <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
                          <Receipt className="w-3 h-3" />
                          {bill.invoices.map((inv, i) => (
                            <span key={inv.id}>
                              {i > 0 && ', '}
                              {/* ?client= is what the Invoices page actually
                                  reads; there is no per-invoice deep link. */}
                              <Link href={`/dashboard/invoices?client=${p.client_id}`} className="hover:text-foreground hover:underline">
                                {inv.number || 'Invoice'}
                              </Link>
                              <span className={inv.paid ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                                {' '}{inv.paid ? 'paid' : (inv.status ?? 'unpaid')}
                              </span>
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Archive — closed business, folded away but never lost. */}
        {archived.length > 0 && (
          <div>
            <button onClick={() => setShowArchived(v => !v)}
              className="text-xs text-muted-foreground hover:text-foreground">
              {showArchived ? '−' : '+'} Archived ({archived.length})
            </button>

            {showArchived && (
              <div className="mt-3 space-y-2">
                {archived.map(p => {
                  const bill = billingByPackage.get(p.id)
                  const tasks = tasksByPackage.get(p.id) ?? []
                  return (
                    <div key={p.id} className="rounded-xl border border-border bg-card/50 px-4 py-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm text-muted-foreground">{p.name}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border capitalize ${STATUS_CHIP[p.status]}`}>
                            {p.status}
                          </span>
                          {bill?.anyBilled && (
                            <span className={`text-[10px] ${bill.allPaid ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                              {bill.allPaid ? 'paid' : 'payment outstanding'}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {clientName(p.client_id)} · {formatDate(p.start_date)}
                          {tasks.length > 0 && <> · {tasks.length} task{tasks.length === 1 ? '' : 's'}</>}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground shrink-0">{money(p.currency, p.price)}</p>
                      {canManage && (
                        <OverflowMenu
                          items={[
                            { label: 'Reopen', icon: Play, onClick: () => changeStatus(p, 'active'), disabled: busyId === p.id },
                            { label: 'Edit', icon: Pencil, onClick: () => { setForm(fromRow(p)); setShowAdvanced(false) } },
                            { label: 'Delete', icon: Trash2, danger: true, separatorBefore: true, onClick: () => setDeleteTarget(p) },
                          ]}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Add / edit ── */}
      {form && (
        <ModalOverlay onClose={() => { setForm(null); setShowAdvanced(false) }} sheetOnMobile>
          <div className="w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="font-semibold">{form.id ? 'Edit package' : 'New package'}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                The name becomes the line your client sees on the invoice.
              </p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className={labelCls}>Client</label>
                <Combobox
                  options={clientOptions}
                  value={form.clientId}
                  onChange={id => setForm(f => f && ({ ...f, clientId: id }))}
                  placeholder="Search client…"
                  sortKey="clients"
                />
              </div>

              <div>
                <label className={labelCls}>Package name</label>
                <input value={form.name} onChange={e => setForm(f => f && ({ ...f, name: e.target.value }))}
                  className={field} placeholder="e.g. Social Media Management" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Billing</label>
                  <AppSelect value={form.billingType}
                    onChange={e => setForm(f => f && ({ ...f, billingType: e.target.value as PackageBillingType }))}>
                    <option value="monthly">Every month</option>
                    <option value="one_time">One-time</option>
                  </AppSelect>
                </div>
                <div>
                  <label className={labelCls}>Starts</label>
                  <input type="date" value={form.startDate}
                    onChange={e => setForm(f => f && ({ ...f, startDate: e.target.value }))}
                    className={field} />
                </div>
              </div>

              <div>
                <label className={labelCls}>Price {form.billingType === 'monthly' ? '(per month)' : '(one-time)'}</label>
                <div className="flex gap-2">
                  <select value={form.currency}
                    onChange={e => setForm(f => f && ({ ...f, currency: e.target.value }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm w-24 shrink-0">
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input type="number" min="0" step="0.01" value={form.price}
                    onChange={e => setForm(f => f && ({ ...f, price: e.target.value }))}
                    className={field} placeholder="0.00" />
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  What the client pays. Task prices still come from the Pricing Matrix and are what the team is paid from.
                </p>
              </div>

              {/*
                Longer opening cycle. Shown only when it can actually matter — a
                monthly package that starts mid-month — or when one is already
                set, so an existing value can never be stranded by an edit that
                hides its own control.
              */}
              {form.billingType === 'monthly'
                && (form.startDate.slice(8) !== '01' || form.firstCycleEnd !== '') && (
                <div className="rounded-lg border border-border bg-secondary/30 px-3 py-3">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.firstCycleEnd !== ''}
                      onChange={e => setForm(f => f && ({
                        ...f,
                        // Default to the end of the month AFTER the start —
                        // "20 Jul → 31 Aug", the shape this exists for.
                        firstCycleEnd: e.target.checked
                          ? lastDayOfMonth(shiftMonth(f.startDate.slice(0, 7), 1))
                          : '',
                      }))}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="text-xs">
                      <span className="font-medium">Combine the first part-month with the next month</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">
                        Starting {form.startDate ? formatDate(form.startDate) : 'mid-month'} would otherwise
                        bill a full {form.price ? money(form.currency, Number(form.price) || 0) : 'month'} for
                        a part month. Tick this and the opening cycle bills once and carries one allowance.
                      </span>
                    </span>
                  </label>

                  {form.firstCycleEnd !== '' && (
                    <div className="mt-3 pl-6">
                      <label className={labelCls}>First cycle runs until</label>
                      <input type="date" value={form.firstCycleEnd}
                        onChange={e => setForm(f => f && ({ ...f, firstCycleEnd: e.target.value }))}
                        className={field} />
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        Billed once as{' '}
                        <strong className="text-foreground">
                          {formatDate(form.startDate)} → {formatDate(lastDayOfMonth(form.firstCycleEnd.slice(0, 7)))}
                        </strong>
                        , then normal months. The whole end month is included, so a part-month is never left
                        uncounted.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* What's included */}
              <div>
                <label className={labelCls}>What&rsquo;s included {form.billingType === 'monthly' && <span className="font-normal">(per month)</span>}</label>
                <div className="space-y-2">
                  {form.items.map((it, idx) => (
                    <div key={idx} className="flex gap-2 items-start">
                      <div className="flex-1 min-w-0">
                        <Combobox
                          options={serviceOptions}
                          value={it.serviceId}
                          onChange={id => setForm(f => f && ({
                            ...f, items: f.items.map((x, i) => i === idx ? { ...x, serviceId: id } : x),
                          }))}
                          placeholder="Search service…"
                          sortKey="services"
                        />
                      </div>
                      <input type="number" min="0" step="1" value={it.includedQuantity}
                        onChange={e => setForm(f => f && ({
                          ...f, items: f.items.map((x, i) => i === idx ? { ...x, includedQuantity: e.target.value } : x),
                        }))}
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm w-20 shrink-0"
                        placeholder="Qty" />
                      {form.items.length > 1 && (
                        <button type="button"
                          onClick={() => setForm(f => f && ({ ...f, items: f.items.filter((_, i) => i !== idx) }))}
                          className="p-2 text-muted-foreground hover:text-destructive shrink-0">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button type="button"
                  onClick={() => setForm(f => f && ({ ...f, items: [...f.items, { serviceId: '', includedQuantity: '1' }] }))}
                  className="mt-2 text-xs font-medium text-primary hover:underline">
                  + Add another service
                </button>
              </div>

              {/* Everything optional folds away */}
              <div className="border-t border-border pt-3">
                <button type="button" onClick={() => setShowAdvanced(v => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground">
                  {showAdvanced ? '− Fewer options' : '+ End date, extra-work rate, notes'}
                </button>

                {showAdvanced && (
                  <div className="mt-3 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Ends (optional)</label>
                        <input type="date" value={form.endDate}
                          onChange={e => setForm(f => f && ({ ...f, endDate: e.target.value }))}
                          className={field} />
                      </div>
                      <div>
                        <label className={labelCls}>Status</label>
                        <AppSelect value={form.status}
                          onChange={e => setForm(f => f && ({ ...f, status: e.target.value as PackageStatus }))}>
                          <option value="active">Active</option>
                          <option value="paused">Paused</option>
                          <option value="completed">Completed</option>
                          <option value="cancelled">Cancelled</option>
                        </AppSelect>
                      </div>
                    </div>

                    <div>
                      <label className={labelCls}>Extra work, per task (optional)</label>
                      <input type="number" min="0" step="0.01" value={form.extraTaskPrice}
                        onChange={e => setForm(f => f && ({ ...f, extraTaskPrice: e.target.value }))}
                        className={field} placeholder={`${form.currency} — leave blank to use the normal price`} />
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        Charged for each task beyond what&rsquo;s included. Blank means extras bill at their normal Pricing-Matrix price.
                      </p>
                    </div>

                    <div>
                      <label className={labelCls}>Notes (optional)</label>
                      <textarea value={form.notes} rows={2}
                        onChange={e => setForm(f => f && ({ ...f, notes: e.target.value }))}
                        className={field + ' resize-none'} placeholder="Anything worth remembering about this deal" />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3 px-6 py-4 border-t border-border sticky bottom-0 bg-card">
              <button onClick={() => { setForm(null); setShowAdvanced(false) }}
                className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-secondary transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 rounded-lg gradient-bg text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
                {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create package'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.name}?`}
          body="The tasks already delivered under it stay exactly as they are, and any invoice line already sent is untouched. Future invoices simply stop including this package."
          confirmLabel="Delete package"
          danger
          onConfirm={() => { const t = deleteTarget; setDeleteTarget(null); applyDelete(t) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </>
  )
}
