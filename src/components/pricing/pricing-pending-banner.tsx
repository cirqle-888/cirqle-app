import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'

interface Props {
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  /** Where the "Set pricing" link points (defaults to Settings). */
  href?: string
}

/**
 * Red/urgent banner listing clients/services that were created without pricing
 * and are awaiting commercial details — unpriced items can't bill, so this is an
 * action-required alert. Render only for users with pricing access.
 * Self-contained padding so it sits correctly at the top of any page.
 */
export function PricingPendingBanner({ clients, services, href = '/dashboard/settings?tab=clients' }: Props) {
  const total = clients.length + services.length
  if (total === 0) return null

  const names = [...clients.map(c => c.name), ...services.map(s => s.name)].slice(0, 4)
  const more = total - names.length

  return (
    <div className="px-4 sm:px-6 pt-4">
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 flex items-center gap-3">
        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-300">
            {total} {total === 1 ? 'item needs' : 'items need'} pricing
            <span className="font-normal text-red-400/70">
              {' · '}{clients.length} client{clients.length !== 1 ? 's' : ''}, {services.length} service{services.length !== 1 ? 's' : ''}
            </span>
          </p>
          <p className="text-xs text-red-400/70 truncate">
            {names.join(', ')}{more > 0 ? ` +${more} more` : ''}
          </p>
        </div>
        <Link href={href} className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-red-300 hover:text-red-200 transition-colors">
          Set pricing <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  )
}
