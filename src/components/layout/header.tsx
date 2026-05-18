'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight, Home } from 'lucide-react'

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

function Breadcrumbs() {
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
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[11px] text-muted-foreground/50 mb-0.5">
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

export default function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-4 pl-14 sm:pl-16 pr-4 py-3 sm:py-4 md:px-6 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30">
      <div className="w-full sm:w-auto">
        <Breadcrumbs />
        <h1 className="text-lg font-semibold text-foreground truncate">{title}</h1>
        {subtitle && <div className="text-sm text-muted-foreground truncate">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto pb-1 sm:pb-0 w-full sm:w-auto hide-scrollbar">{actions}</div>}
    </div>
  )
}
