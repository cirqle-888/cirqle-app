'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight, Home, ChevronDown, UserCircle } from 'lucide-react'
import { forwardRef, useState } from 'react'
import { usePermissions } from '@/contexts/permission-context'
import { usePrivacy } from '@/contexts/privacy-context'
import { CommandPaletteTrigger } from '@/components/ui/command-palette'
import { NotificationBell } from '@/components/layout/notification-bell'
import { AppLauncherTrigger } from '@/components/layout/app-launcher'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { ProfileActions, ChangePasswordModal } from '@/components/layout/sidebar'

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
  partners:      'Business Partners',
  payroll:       'HR & Payroll',
  reports:       'Reports',
  import:        'Bulk Import',
  settings:      'Settings',
  health:        'Business Health',
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
    <nav aria-label="Breadcrumb" className={`flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground/60 mb-1 ${isEmployee ? 'hidden sm:flex' : ''}`}>
      <Link href="/dashboard" className="hover:text-foreground transition-colors flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
        <Home className="w-3.5 h-3.5" />
      </Link>
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          <ChevronRight className="w-3.5 h-3.5 opacity-40" />
          {crumb.isLast ? (
            <span className="text-foreground tracking-tight">{crumb.label}</span>
          ) : (
            <Link href={crumb.href} className="hover:text-foreground transition-colors truncate max-w-[120px] sm:max-w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
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
  const { isUnlocked } = usePrivacy()
  const isEmployee = !user.isAdmin
  
  const [profileOpen, setProfileOpen] = useState(false)
  const [showPwdModal, setShowPwdModal] = useState(false)

  return (
    <div
      ref={ref}
      className={`flex flex-row items-center justify-between gap-3 pr-3 md:px-5 border-b border-border/80 bg-background/95 supports-[backdrop-filter]:bg-background/60 backdrop-blur-md sticky top-0 z-30 transition-all ${isEmployee ? 'pl-3 py-2 sm:pl-16 sm:py-3.5' : 'pl-14 sm:pl-16 py-3 sm:py-3.5'}`}
    >
      {/* Employee mobile: compact left branding strip (hidden on sm+) */}
      {isEmployee && (
        <div className="flex items-center gap-2 shrink-0 sm:hidden">
          <div className="w-7 h-7 rounded-lg gradient-bg flex items-center justify-center shrink-0 shadow-sm">
            <span className="text-white font-bold text-xs">C</span>
          </div>
          <span className="text-sm font-semibold text-foreground leading-none truncate max-w-[140px] tracking-tight">{title}</span>
        </div>
      )}

      {/* Title + breadcrumb — full display on sm+ (and always for admin) */}
      <div className={`min-w-0 flex-1 ${isEmployee ? 'hidden sm:flex flex-col justify-center' : 'flex flex-col justify-center'}`}>
        <Breadcrumbs isEmployee={isEmployee} />
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-lg md:text-xl font-semibold text-foreground truncate tracking-tight">{title}</h1>
          {subtitle && (
            <div className="text-sm text-muted-foreground truncate hidden lg:block tracking-tight">{subtitle}</div>
          )}
        </div>
      </div>

      <div className="flex items-center shrink-0 gap-3">
        {/* Local Page Actions */}
        {actions && (
          <div className="flex items-center gap-2 overflow-x-auto shrink-0 hide-scrollbar mr-1">
            {actions}
          </div>
        )}

        {/* Global Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 border-l border-border/60 pl-2 sm:pl-4">
          <CommandPaletteTrigger className="hidden md:flex w-52 lg:w-64" />
          <CommandPaletteTrigger className="md:hidden" isCollapsed={true} />
          
          <AppLauncherTrigger />
          <NotificationBell />

          {/* Profile Dropdown */}
          <div className="relative ml-1">
            <button 
              onClick={() => setProfileOpen(!profileOpen)}
              className="flex items-center gap-2 rounded-full hover:bg-secondary/80 p-1 pr-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary group"
              title="Account Settings"
            >
              {user.cqid ? (
                <EmployeeAvatar avatarUrl={null} name={user.cqid} cqid={user.cqid} size={28} rounded="full" className="shrink-0 ring-1 ring-border/50 shadow-sm transition-transform group-hover:scale-105" />
              ) : (
                <UserCircle className="w-7 h-7 text-muted-foreground shrink-0 transition-transform group-hover:scale-105" />
              )}
              <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform hidden sm:block ${profileOpen ? 'rotate-180' : ''}`} />
            </button>

            {profileOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-64 bg-card border border-border shadow-xl shadow-black/5 rounded-xl p-2 z-50 animate-in fade-in zoom-in-95 duration-200">
                  <div className="px-2 py-2 mb-2 border-b border-border/50">
                    <div className="font-semibold text-foreground text-sm truncate tracking-tight">{user.cqid ?? 'Account'}</div>
                    {isUnlocked && user.name && <div className="text-xs text-muted-foreground truncate">{user.name}</div>}
                    {user.designationName && (
                      <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border/50 whitespace-nowrap mt-1.5">
                        {user.designationName}
                      </span>
                    )}
                  </div>
                  <ProfileActions onChangePassword={() => { setShowPwdModal(true); setProfileOpen(false) }} compact />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {showPwdModal && <ChangePasswordModal onClose={() => setShowPwdModal(false)} />}
    </div>
  )
})

export default Header
