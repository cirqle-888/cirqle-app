'use client'

/**
 * Financial Timeline — month cards.
 *
 * The whole month-end ritual lives here: open, glance, pay, lock. Anything
 * deeper (editing a payslip, fixing a cashbook entry) deep-links to the page
 * that already owns it rather than being duplicated — duplicated payroll UI
 * would drift, and a single owner cannot afford to maintain two of anything.
 */

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Lock, LockOpen, Loader2, TrendingUp, TrendingDown, AlertTriangle, ArrowRight, RefreshCw,
} from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { lockMonth, unlockMonth, rescanAdjustments } from './actions'

export interface MonthCard {
  month: number
  year: number
  revenueInr: number
  contributionInr: number
  baseSalariesInr: number
  expensesInr: number
  profitInr: number
  frozen: boolean
  locked: boolean
  explicitlyLocked: boolean
  payrollTotal: number
  payrollPaid: number
  payrollNetInr: number
  pendingAdjustments: number
  pendingAdjustmentInr: number
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`

export default function MonthsClient({ cards, canManage, canSeeAmounts }: {
  cards: MonthCard[]
  canManage: boolean
  canSeeAmounts: boolean
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so Reopen did nothing
  // at all — the one button that unblocks a wrongly-closed month sat there
  // dead, with no error to explain it.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string
    body: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)

  const key = (c: MonthCard) => `${c.year}-${c.month}`

  function onLock(c: MonthCard) {
    if (c.payrollTotal > 0 && c.payrollPaid < c.payrollTotal) {
      setConfirmPrompt({
        title: `Lock ${MONTHS[c.month - 1]} ${c.year} with unpaid payslips?`,
        body: `${c.payrollPaid} of ${c.payrollTotal} payslips are paid. Locking freezes the month anyway — unpaid payslips stay unpaid and can no longer be recalculated.`,
        confirmLabel: 'Lock month',
        danger: true,
        onConfirm: () => { void applyLock(c) },
      })
      return
    }
    void applyLock(c)
  }

  async function applyLock(c: MonthCard) {
    setBusy(key(c))
    const res = await lockMonth(c.month, c.year)
    setBusy(null)
    if (!res.ok) { toastError('Could not lock the month', res.error); return }
    success(`${MONTHS[c.month - 1]} ${c.year} locked`, 'Profit is frozen and money writers are blocked for this month.')
    startTransition(() => router.refresh())
  }

  function onUnlock(c: MonthCard) {
    setConfirmPrompt({
      title: `Reopen ${MONTHS[c.month - 1]} ${c.year}?`,
      body: 'Figures become live again and contributions can be edited. The profit snapshot taken at lock time is kept for audit.',
      confirmLabel: 'Reopen',
      onConfirm: () => { void applyUnlock(c) },
    })
  }

  async function applyUnlock(c: MonthCard) {
    setBusy(key(c))
    const res = await unlockMonth(c.month, c.year)
    setBusy(null)
    if (!res.ok) { toastError('Could not reopen the month', res.error); return }
    success(`${MONTHS[c.month - 1]} ${c.year} reopened`)
    startTransition(() => router.refresh())
  }

  async function onRescan(c: MonthCard) {
    setBusy(key(c))
    const res = await rescanAdjustments(c.month, c.year)
    setBusy(null)
    if (!res.ok) { toastError('Could not scan', res.error); return }
    const n = res.data?.recorded ?? 0
    success(n > 0 ? `${n} adjustment${n === 1 ? '' : 's'} found` : 'No new corrections', n > 0
      ? 'They will be paid with the next open payroll.'
      : `${MONTHS[c.month - 1]} ${c.year} matches what was paid.`)
    startTransition(() => router.refresh())
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      {/* pl-14 on mobile clears the global sidebar hamburger (fixed top-left,
          16–52px) which otherwise sits on top of the heading; md:pl-0 restores
          normal padding where the hamburger is hidden. */}
      <div className="pl-14 md:pl-0">
        <h1 className="text-2xl font-bold">Financial Timeline</h1>
        <p className="text-sm text-muted-foreground mt-1">
          One card per month: what came in, what the team earned, what the company spent, and what is left.
          Review it, pay payroll, then lock the month to close the books.
        </p>
      </div>

      <div className="space-y-4">
        {cards.map(c => {
          const isBusy = busy === key(c)
          const positive = c.profitInr >= 0
          return (
            <div key={key(c)}
              className={`rounded-xl border bg-card overflow-hidden ${c.locked ? 'border-border' : 'border-primary/30'}`}>
              {/* Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold">{MONTHS[c.month - 1]} {c.year}</span>
                  {c.locked ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Lock className="h-3 w-3" /> Locked
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                      <LockOpen className="h-3 w-3" /> Open
                    </span>
                  )}
                  {c.frozen && (
                    <span className="text-[10px] text-muted-foreground" title="Figures come from the snapshot taken when this month was locked">
                      snapshot
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {c.locked && (
                    <button onClick={() => onRescan(c)} disabled={isBusy || !canManage}
                      title="Check this closed month for late corrections"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      Check corrections
                    </button>
                  )}
                  {canManage && (c.explicitlyLocked ? (
                    <button onClick={() => onUnlock(c)} disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">
                      <LockOpen className="h-3.5 w-3.5" /> Reopen
                    </button>
                  ) : !c.locked ? (
                    <button onClick={() => onLock(c)} disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                      Lock month
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground" title="Payroll for this month has been paid, which closes it">
                      closed by payroll
                    </span>
                  ))}
                </div>
              </div>

              {/* Composition — the profit engine's terms, in the order it computes them */}
              {canSeeAmounts ? (
                <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-5">
                  <Stat label="Revenue" value={inr(c.revenueInr)} />
                  <Stat label="Team earnings" value={`− ${inr(c.contributionInr)}`} />
                  <Stat label="Base salaries" value={`− ${inr(c.baseSalariesInr)}`} />
                  <Stat label="Company expenses" value={`− ${inr(c.expensesInr)}`} />
                  <Stat
                    label="Net profit"
                    value={inr(c.profitInr)}
                    tone={positive ? 'good' : 'bad'}
                    icon={positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  />
                </div>
              ) : (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  You do not have permission to see financial amounts.
                </p>
              )}

              {/* Payroll + corrections */}
              <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2.5 text-xs">
                <Link href="/dashboard/payroll"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                  Payroll:&nbsp;
                  <span className="font-semibold text-foreground">
                    {c.payrollTotal === 0 ? 'not drafted' : `${c.payrollPaid}/${c.payrollTotal} paid`}
                  </span>
                  {canSeeAmounts && c.payrollNetInr > 0 && <span className="text-muted-foreground"> · {inr(c.payrollNetInr)}</span>}
                  <ArrowRight className="h-3 w-3" />
                </Link>

                {c.pendingAdjustments > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    {c.pendingAdjustments} correction{c.pendingAdjustments === 1 ? '' : 's'} from this month
                    {canSeeAmounts && ` · ${inr(c.pendingAdjustmentInr)}`}
                    <span className="font-normal opacity-80">— pays with the next open payroll</span>
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          body={confirmPrompt.body}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onConfirm={() => { const run = confirmPrompt.onConfirm; setConfirmPrompt(null); run() }}
          onCancel={() => setConfirmPrompt(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

function Stat({ label, value, tone, icon }: {
  label: string; value: string; tone?: 'good' | 'bad'; icon?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 flex items-center gap-1 text-base font-semibold tabular-nums truncate ${
        tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
        : tone === 'bad' ? 'text-red-600 dark:text-red-400' : ''
      }`} title={value}>
        {icon}{value}
      </div>
    </div>
  )
}
