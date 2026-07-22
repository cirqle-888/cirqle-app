'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AlertTriangle, ArrowRight } from 'lucide-react'

interface Props {
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  /** Optional override for the "Set pricing" link (defaults to a smart deep-link). */
  href?: string
}

/**
 * Red/urgent banner listing clients/services that were created without pricing
 * and are awaiting commercial details — unpriced items can't bill, so this is an
 * action-required alert. Render only for users with pricing access.
 *
 * Each listed name (and the "Set pricing" link) deep-links straight to the
 * Settings form for that item — a pending client opens its pricing form, a
 * pending service opens its price field — with a `returnTo` back to the page
 * the banner was shown on. Self-contained padding so it sits at the top of any page.
 */
export function PricingPendingBanner({ clients, services, href }: Props) {
  const pathname = usePathname()
  const total = clients.length + services.length
  if (total === 0) return null

  const ret = `&returnTo=${encodeURIComponent(pathname || '/dashboard')}`
  const clientHref  = (id: string) => `/dashboard/settings?tab=Clients&editClient=${id}${ret}`
  const serviceHref = (id: string) => `/dashboard/settings?tab=Services&editService=${id}${ret}`

  // "Set pricing" target: jump straight to the single item, otherwise the most
  // relevant bulk view (Services tab if only services pending, else the Pricing Matrix).
  const primaryHref = href
    ?? (total === 1
        ? (clients[0] ? clientHref(clients[0].id) : serviceHref(services[0].id))
        : (clients.length === 0 ? `/dashboard/settings?tab=Services${ret}` : '/dashboard/pricing-matrix'))

  const itemLinkCls = 'text-xs text-red-700/80 hover:text-red-800 underline decoration-red-500/30 underline-offset-2 hover:decoration-red-500 transition-colors dark:text-red-400/80 dark:hover:text-red-700 dark:text-red-300'

  return (
    <div className="px-4 sm:px-6 pt-4">
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 flex items-center gap-3">
        <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 dark:text-red-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-700 dark:text-red-700 dark:text-red-300">
            {total} {total === 1 ? 'item needs' : 'items need'} pricing
            <span className="font-normal text-red-700/70 dark:text-red-400/70">
              {' · '}{clients.length} client{clients.length !== 1 ? 's' : ''}, {services.length} service{services.length !== 1 ? 's' : ''}
            </span>
          </p>
          {/* Each item is a direct link to its own pricing field. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
            {clients.map(c => (
              <Link key={c.id} href={clientHref(c.id)} className={itemLinkCls}>{c.name}</Link>
            ))}
            {services.map(s => (
              <Link key={s.id} href={serviceHref(s.id)} className={itemLinkCls}>{s.name}</Link>
            ))}
          </div>
        </div>
        <Link href={primaryHref} className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-800 transition-colors dark:text-red-700 dark:text-red-300 dark:hover:text-red-700 dark:text-red-200">
          Set pricing <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  )
}
