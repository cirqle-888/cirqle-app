'use client'

/**
 * Small pieces shared by the Marketing client list and the client hub, so the
 * two screens look like one product.
 */

import Link from 'next/link'
import { ArrowRight, type LucideIcon } from 'lucide-react'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import { avatarHue, initials } from '@/lib/marketing/hub'

export const compact = (n: number | null | undefined) =>
  n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

export const inr = (n: number | null | undefined, dp = 0) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: dp })}`

export function ClientAvatar({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  const hue = avatarHue(id)
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-xl font-semibold text-white shadow-sm"
      style={{
        width: size, height: size, fontSize: Math.round(size * 0.36),
        background: `linear-gradient(135deg, hsl(${hue} 70% 52%), hsl(${(hue + 40) % 360} 72% 44%))`,
      }}
    >
      {initials(name)}
    </span>
  )
}

const DOT: Record<string, string> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' }
const DOT_LABEL: Record<string, string> = { green: 'Healthy', amber: 'Needs a look', red: 'Something is broken' }

export function HealthDot({ state, className = '' }: { state: 'green' | 'amber' | 'red'; className?: string }) {
  return (
    <span title={DOT_LABEL[state]} className={`inline-flex items-center ${className}`}>
      <span className={`h-2 w-2 rounded-full ${DOT[state]}`} aria-hidden />
      <span className="sr-only">{DOT_LABEL[state]}</span>
    </span>
  )
}

/** A KPI tile: label, big number, one line of context. */
export function Stat({ icon: Icon, label, value, sub, tone }: {
  icon: LucideIcon
  label: string
  value: string
  sub?: string
  tone?: 'pink' | 'blue' | 'violet' | 'emerald' | 'amber'
}) {
  const TONE: Record<string, string> = {
    pink: 'text-pink-500 bg-pink-500/10',
    blue: 'text-blue-500 bg-blue-500/10',
    violet: 'text-violet-500 bg-violet-500/10',
    emerald: 'text-emerald-500 bg-emerald-500/10',
    amber: 'text-amber-500 bg-amber-500/10',
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${TONE[tone ?? 'violet']}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

/** Card with a titled header and an optional link on the right. */
export function Panel({ title, icon: Icon, action, children, className = '' }: {
  title: string
  icon?: LucideIcon
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-border bg-card ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />} {title}
        </h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

export interface HubClient { id: string; name: string; code: string | null; isActive: boolean }

export function EmptyHint({ text, cta }: { text: string; cta?: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-start gap-2 py-2 text-sm text-muted-foreground">
      <p>{text}</p>
      {cta && (
        <Link href={cta.href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {cta.label} <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  )
}

export function AccountAvatar({ url, platform, size = 36 }: { url: string | null; platform: string; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full rounded-full border border-border object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full bg-secondary">
          <PlatformIcon platform={platform} className={`h-4 w-4 ${platform === 'instagram' ? 'text-pink-500' : 'text-blue-500'}`} />
        </span>
      )}
      <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-card p-0.5">
        <PlatformIcon platform={platform} className={`h-3 w-3 ${platform === 'instagram' ? 'text-pink-500' : 'text-blue-500'}`} />
      </span>
    </span>
  )
}

export function DateBadge({ iso }: { iso: string | null }) {
  if (!iso) return <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-xs text-muted-foreground">—</span>
  const d = new Date(`${iso}T00:00:00`)
  return (
    <span className="inline-flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-secondary leading-none">
      <span className="text-[10px] font-medium uppercase text-muted-foreground">{d.toLocaleString('en-GB', { month: 'short' })}</span>
      <span className="text-sm font-bold tabular-nums">{d.getDate()}</span>
    </span>
  )
}
