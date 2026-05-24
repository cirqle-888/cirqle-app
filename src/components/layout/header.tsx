'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight, Home } from 'lucide-react'
import { forwardRef } from 'react'
import { usePermissions } from '@/contexts/permission-context'

interface HeaderProps {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}

const ROUTE_LABELS: Record<string, string> = {
  dashboard:     'Dashboard',
  tasks:         'Tasks',
  contributions: 'Contributions',
  invoices:      'Invoices',
  quotations:    'Quotations',
  cashbook:      'Cash Book',
  payroll:       'HR & Payroll',
  reports:       'Reports',
  import:        'Bulk Import',
  settings:      'Settings',
}

function Breadcrumbs({ isEmployee }: { isEmployee: boolean }) { // eslint-disable-line @typescript-eslint/no-unused-vars
  const pathname = usePathname()
  // e.g. /dashboard/tasks  →  ['dashboard', 'tasks']
  const segments = pathname.split('/').filter(Boolean)

  // Build cumulative hrefs
  const crumbs = segments.map((seg, i) => ({
    label: ROUTE_LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1),
    href:  '/' + segments.slice(0, i + 1).join('/'),
    isLast: i === segments.length - 1,
  }))

  // Only show breadcrumbs when there's more than one level (not just /dashboard)
  if (crumbs.length <= 1) return null

  return (
    <nav aria-label="Breadcrumb" className={`flex items-center gap-1 text-[11px] text-muted-foreground/50 mb-0.5 ${isEmployee ? 'hidden sm:flex' : ''}`}>
      <Link href="/dashboard" className="hover:text-muted-foreground transition-colors">
        <Home className="w-3 h-3" />
      </Link>
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1">
          <ChevronRight className="w-3 h-3 opacity-40" />
          {crumb.isLast ? (
            <span className="text-muted-foreground/70">{crumb.label}</span>
          ) : (
            <Link href={crumb.href} className="hover:text-muted-foreground transition-colors">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  )
}

const Header = forwardRef<HTMLDivElement, HeaderProps>(function Header(
  { title, subtitle, actions },
  ref,
) {
  const { user } = usePermissions()
  const isEmployee = !user.isAdmin

  return (
    <div
      ref={ref}
      className={`flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-3 pl-14 sm:pl-16 pr-4 md:px-6 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30 ${isEmployee ? 'py-1.5 sm:py-4' : 'py-3 sm:py-4'}`}
    >
      {/* Title + breadcrumb */}
      <div className="min-w-0 flex-1">
        <Breadcrumbs isEmployee={isEmployee} />
        <h1 className={`font-semibold text-foreground truncate ${isEmployee ? 'text-base sm:text-lg hidden sm:block' : 'text-lg'}`}>
          {title}
        </h1>
        {subtitle && (
          <div className={`text-muted-foreground truncate ${isEmployee ? 'text-xs sm:text-sm hidden sm:block' : 'text-sm'}`}>
            {subtitle}
          </div>
        )}
      </div>
      {/* Action buttons — scrollable on mobile so they never wrap or overflow */}
      {actions && (
        <div className="flex items-center gap-2 overflow-x-auto shrink-0 pb-0.5 sm:pb-0 max-w-full hide-scrollbar">
          {actions}
        </div>
      )}
    </div>
  )
})

export default Header
