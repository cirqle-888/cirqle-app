'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ChevronRight, Home, ChevronDown, UserCircle, Sparkles, MessageCircle } from 'lucide-react'
import { forwardRef, useState, useRef, useEffect } from 'react'
import { usePermissions } from '@/contexts/permission-context'
import { usePrivacy } from '@/contexts/privacy-context'
import { CommandPaletteTrigger } from '@/components/ui/command-palette'
import { NotificationBell } from '@/components/layout/notification-bell'
import { AppLauncherTrigger } from '@/components/layout/app-launcher'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { EmployeePresenceDot, PresenceNote } from '@/components/ui/presence-dot'
import { StatusMenu } from '@/components/layout/status-menu'
import { usePresence } from '@/contexts/presence-context'
import { LiveClock } from '@/components/layout/live-clock'
import { ProfileActions, ChangePasswordModal } from '@/components/layout/sidebar'

interface HeaderProps {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  /**
   * Label for the final breadcrumb on detail routes, whose last segment is a
   * record id. Without it a UUID route falls back to "Details" rather than
   * printing the raw id at the user.
   */
  crumbLabel?: string
}

const ROUTE_LABELS: Record<string, string> = {
  dashboard:     'Dashboard',
  tasks:         'Tasks',
  contributions: 'Contributions',
  invoices:      'Invoices',
  packages:      'Packages',
  connections:   'Connections',
  feed:          'Feed Planner',
  assets:        'Asset Assignment',
  'cirqle-accounts': 'Cirqle Accounts',
  quotations:    'Quotations',
  cashbook:      'Cash Book',
  recurring:     'Recurring Expenses',
  clients:       'Clients',
  ranking:       'Client Ranking',
  capture:       'AI Capture',
  'pricing-matrix': 'Pricing Matrix',
  partners:      'Business Partners',
  payroll:       'HR & Payroll',
  reports:       'Reports',
  workspace:     'My Planner',
  'role-earnings': 'Earnings by Role',
  import:        'Bulk Import',
  settings:      'Settings',
  health:        'Business Health',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function Breadcrumbs({ isEmployee, crumbLabel }: { isEmployee: boolean; crumbLabel?: string }) {  
  const pathname = usePathname()
  // e.g. /dashboard/tasks  →  ['dashboard', 'tasks']
  const segments = pathname.split('/').filter(Boolean)

  // Build cumulative hrefs
  const crumbs = segments.map((seg, i) => {
    const isLast = i === segments.length - 1
    const fallback = UUID_RE.test(seg)
      ? 'Details'                                  // never print a raw record id
      : ROUTE_LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1)
    return {
      label: isLast && crumbLabel ? crumbLabel : fallback,
      href:  '/' + segments.slice(0, i + 1).join('/'),
      isLast,
    }
  })

  // Only show breadcrumbs when there's more than one level (not just /dashboard)
  if (crumbs.length <= 1) return null

  const middle = crumbs.slice(0, -1)
  const last = crumbs[crumbs.length - 1]
  const parent = crumbs.length > 2 ? crumbs[crumbs.length - 2] : null

  // Mobile shows a compact trail — Home › … › Current — because the full one
  // can't fit a phone width; the "…" links to the immediate parent. The last
  // crumb truncates so a long record name ("Nazer (Sea Star)") can never wrap
  // over the header action icons. Desktop keeps the full trail.
  return (
    <nav aria-label="Breadcrumb" className={`flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground/60 mb-1 min-w-0 ${isEmployee ? 'hidden sm:flex' : ''}`}>
      <Link href="/dashboard" className="hover:text-foreground transition-colors flex items-center shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
        <Home className="w-3.5 h-3.5" />
      </Link>
      {/* Full trail — sm and up */}
      {middle.map(crumb => (
        <span key={crumb.href} className="hidden sm:flex items-center gap-1.5 min-w-0">
          <ChevronRight className="w-3.5 h-3.5 opacity-40 shrink-0" />
          <Link href={crumb.href} className="hover:text-foreground transition-colors truncate max-w-[200px] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
            {crumb.label}
          </Link>
        </span>
      ))}
      {/* Condensed middle — mobile only, when deeper than Home › Page */}
      {parent && (
        <span className="flex sm:hidden items-center gap-1.5 shrink-0">
          <ChevronRight className="w-3.5 h-3.5 opacity-40 shrink-0" />
          <Link
            href={parent.href}
            aria-label={`Back to ${parent.label}`}
            className="hover:text-foreground transition-colors px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
          >
            …
          </Link>
        </span>
      )}
      <span className="flex items-center gap-1.5 min-w-0">
        <ChevronRight className="w-3.5 h-3.5 opacity-40 shrink-0" />
        <span className="text-foreground tracking-tight truncate whitespace-nowrap">{last.label}</span>
      </span>
    </nav>
  )
}

const Header = forwardRef<HTMLDivElement, HeaderProps>(function Header(
  { title, subtitle, actions, crumbLabel },
  ref,
) {
  const { user } = usePermissions()
  const { isUnlocked } = usePrivacy()
  const { mine, available: presenceAvailable } = usePresence()
  const router = useRouter()
  const isEmployee = !user.isAdmin
  
  const [profileOpen, setProfileOpen] = useState(false)
  const [showPwdModal, setShowPwdModal] = useState(false)

  // Close on any click outside, and on Escape.
  //
  // This replaces a `fixed inset-0 z-40` backdrop that could never work: the
  // header is `sticky top-0 z-30`, and sticky WITH a z-index creates a stacking
  // context — so the backdrop was confined inside it and painted below the
  // sidebar and chat launcher (both z-50) as well as the scroll container.
  // Verified in the browser: elementFromPoint over the main content and over
  // the sidebar returned page elements, never the backdrop, so the click had
  // nothing to land on and the menu stayed open.
  //
  // A document listener has no stacking to lose. The ref is on the WRAPPER, so
  // the trigger button counts as inside — otherwise mousedown would close the
  // menu and the button's own onClick would immediately reopen it.
  const profileRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!profileOpen) return
    const onDown = (e: MouseEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setProfileOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setProfileOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [profileOpen])

  async function openAiCapture() {
    // Capture the user's copied WhatsApp/email text when the browser permits
    // it, but never block the universal input when clipboard access is denied.
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        window.__pendingCirqleCapture = { text }
      }
    } catch { /* manual paste remains available */ }
    router.push('/dashboard/capture')
  }

  const globalActions = (
    <>
      <button
        type="button"
        onClick={() => void openAiCapture()}
        title="AI Capture — paste any WhatsApp message, email, product list, or request"
        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-2 text-xs font-semibold text-violet-600 hover:bg-violet-500/15 dark:text-violet-700 dark:text-violet-300 transition-colors"
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">AI Capture</span>
      </button>
      <LiveClock className="mr-1" />
      <CommandPaletteTrigger className="hidden md:flex w-52 lg:w-64" />
      <CommandPaletteTrigger className="md:hidden" isCollapsed={true} />
      
      <AppLauncherTrigger />
      {/* Toggles the app-wide comms widget on its Chat tab — the same surface
          as the corner launcher, reachable from the top bar on every page. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('cirqle:toggleChat'))}
        title="Chat & discussions"
        aria-label="Toggle chat"
        className="inline-flex items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
      >
        <MessageCircle className="h-4 w-4" />
      </button>
      <NotificationBell />

      {/* Profile Dropdown */}
      <div className="relative ml-1" ref={profileRef}>
        <button 
          onClick={() => setProfileOpen(!profileOpen)}
          className="flex items-center gap-2 rounded-full hover:bg-secondary/80 p-1 pr-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary group"
          title="Account Settings"
        >
          {user.cqid ? (
            <span className="relative inline-flex shrink-0">
              <EmployeeAvatar avatarUrl={null} name={user.cqid} cqid={user.cqid} size={28} rounded="full" className="shrink-0 ring-1 ring-border/50 shadow-sm transition-transform group-hover:scale-105" />
              {/* Your own dot, on every page — the same signal everyone else
                  sees for you, so "am I showing as away?" never needs asking. */}
              <EmployeePresenceDot employeeId={user.employeeId} size="sm" className="absolute -bottom-0.5 -right-0.5" />
            </span>
          ) : (
            <UserCircle className="w-7 h-7 text-muted-foreground shrink-0 transition-transform group-hover:scale-105" />
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform hidden sm:block ${profileOpen ? 'rotate-180' : ''}`} />
        </button>

        {profileOpen && (
          <>
            <div className="absolute right-0 top-full mt-2 w-72 max-h-[80vh] overflow-y-auto bg-card border border-border shadow-xl shadow-black/5 rounded-xl p-2 z-50 animate-in fade-in zoom-in-95 duration-200">
              <div className="px-2 py-2 mb-2 border-b border-border/50">
                <div className="font-semibold text-foreground text-sm truncate tracking-tight">{user.cqid ?? 'Account'}</div>
                {/* eslint-disable-next-line no-restricted-syntax -- deliberate: the SIGNED-IN user's own name in their own account menu, and only while privacy is unlocked. Never another employee's name. */}
                {isUnlocked && user.name && <div className="text-xs text-muted-foreground truncate">{user.name}</div>}
                {(user.designationName || mine.note || mine.emoji) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {user.designationName && (
                      <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border/50 whitespace-nowrap">
                        {user.designationName}
                      </span>
                    )}
                    <PresenceNote presence={mine} />
                  </div>
                )}
              </div>
              {presenceAvailable && (
                <>
                  <StatusMenu onDone={() => setProfileOpen(false)} />
                  <div className="my-2 border-t border-border/50" />
                </>
              )}
              <ProfileActions onChangePassword={() => { setShowPwdModal(true); setProfileOpen(false) }} compact />
            </div>
          </>
        )}
      </div>
    </>
  )

  return (
    <div
      ref={ref}
      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 pr-3 md:px-5 border-b border-border/80 bg-background/95 supports-[backdrop-filter]:bg-background/60 backdrop-blur-md sticky top-0 z-30 transition-all ${isEmployee ? 'pl-3 py-2 sm:pl-16 sm:py-3.5' : 'pl-3 sm:pl-16 py-2.5 sm:py-3.5'}`}
    >
      <div className="flex items-center justify-between w-full sm:w-auto sm:flex-1 min-w-0 gap-2">
        {/* Left: Branding & Title */}
        <div className="flex flex-col min-w-0 flex-1 justify-center">
          <Breadcrumbs isEmployee={isEmployee} crumbLabel={crumbLabel} />
          <div className="flex items-center gap-2 min-w-0">
            {isEmployee && (
              <div className="w-7 h-7 rounded-lg gradient-bg flex items-center justify-center shrink-0 shadow-sm sm:hidden">
                <span className="text-white font-bold text-xs">C</span>
              </div>
            )}
            <h1 className="text-lg md:text-xl font-semibold text-foreground truncate tracking-tight">{title}</h1>
            {subtitle && (
              // flex-1 basis-0 = subtitle only ever takes LEFTOVER space, so it
              // can never squeeze the title into truncating while room remains.
              <div className="text-sm text-muted-foreground truncate hidden lg:block tracking-tight flex-1 min-w-0">{subtitle}</div>
            )}
          </div>
        </div>

        {/* Mobile Global Actions (Hidden on Desktop) */}
        <div className="flex sm:hidden items-center gap-1.5 shrink-0">
          {globalActions}
        </div>
      </div>

      {/* Local Actions (Bottom Row on Mobile, Middle on Desktop) */}
      {actions && (
        <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar w-full sm:w-auto shrink-0 [&>*]:shrink-0 pb-1 sm:pb-0">
          {actions}
        </div>
      )}

      {/* Desktop Global Actions (Hidden on Mobile) */}
      <div className="hidden sm:flex items-center gap-1.5 sm:gap-2 shrink-0 border-l border-border/60 pl-2 sm:pl-4">
        {globalActions}
      </div>

      {showPwdModal && <ChangePasswordModal onClose={() => setShowPwdModal(false)} />}
    </div>
  )
})

export default Header
