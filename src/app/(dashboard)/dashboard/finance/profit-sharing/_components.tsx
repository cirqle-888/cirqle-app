'use client'

/**
 * Small shared pieces for the Profit Sharing screens. People are always shown
 * by CQID (employees) or their label (external investors) — never by name.
 */

import { useState, useTransition, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'

export { inr, pct, monthLabel, periodLabel, STATUS_TONE, inputCls, td, tdNum } from './_format'

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/investors', label: 'Investors & Capital' },
  { href: '/periods', label: 'Profit Periods' },
  { href: '/departments', label: 'Departments' },
  { href: '/settlements', label: 'Settlements' },
  { href: '/devices', label: 'Device Valuation' },
  { href: '/settings', label: 'Settings' },
  { href: '/history', label: 'Audit History' },
]

export function ProfitSharingTabs() {
  const path = usePathname()
  const base = '/dashboard/finance/profit-sharing'
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border px-4 md:px-6" aria-label="Profit Sharing sections">
      {TABS.map(t => {
        const href = base + t.href
        const active = t.href === '' ? path === base : path.startsWith(href)
        return (
          <Link key={t.href} href={href}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${active
              ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

export function Card({ title, subtitle, actions, children, className = '' }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={`rounded-xl border border-border bg-card ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'muted' }) {
  const color = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'bad' ? 'text-red-600 dark:text-red-400' : ''
  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** A labelled figure that opens to show how it was worked out. */
export function Workings({ label, value, children }: { label: ReactNode; value: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm">
        <span>{label}</span>
        <span className="font-semibold tabular-nums">{value}</span>
      </summary>
      <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{children}</div>
    </details>
  )
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'good' | 'warn' | 'bad' | 'info' }) {
  const cls = {
    muted: 'bg-secondary text-muted-foreground',
    good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    bad: 'bg-red-500/15 text-red-700 dark:text-red-300',
    info: 'bg-primary/15 text-primary',
  }[tone]
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{children}</span>
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function Button({ children, onClick, busy, disabled, variant = 'secondary', type = 'button' }: {
  children: ReactNode; onClick?: () => void; busy?: boolean; disabled?: boolean
  variant?: 'primary' | 'secondary' | 'danger'; type?: 'button' | 'submit'
}) {
  const cls = variant === 'primary'
    ? 'gradient-bg text-white hover:opacity-90'
    : variant === 'danger'
      ? 'border border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400'
      : 'border border-border bg-card hover:bg-secondary'
  return (
    <button type={type} onClick={onClick} disabled={disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${cls}`}>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  )
}

type ActionResult = { ok: boolean; error?: string }

/** Run a server action with a toast and a refresh. Returns the toast host to render. */
export function useAction() {
  const router = useRouter()
  const { toasts, dismiss, success, toastError } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  async function run(key: string, fn: () => Promise<ActionResult>, done?: string): Promise<boolean> {
    setBusy(key)
    try {
      const res = await fn()
      if (!res.ok) { toastError('Not saved', res.error); return false }
      if (done) success(done)
      startTransition(() => router.refresh())
      return true
    } catch (e) {
      toastError('Something went wrong', e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  const host = <ToastContainer toasts={toasts} onDismiss={dismiss} />
  return { run, busy, host }
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            {head.map((h, i) => <th key={i} className="px-2 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
