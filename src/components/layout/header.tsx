'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ChevronRight, Home, ChevronDown, UserCircle, Sparkles, MessageCircle, LifeBuoy } from 'lucide-react'
import { forwardRef, useState, useRef, useEffect, useCallback } from 'react'
import { usePermissions } from '@/contexts/permission-context'
import { CommandPaletteTrigger } from '@/components/ui/command-palette'
import { NotificationBell } from '@/components/layout/notification-bell'
import { FiguresToggle } from '@/contexts/privacy-context'
import { AppLauncherTrigger } from '@/components/layout/app-launcher'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { EmployeePresenceDot, PresenceNote } from '@/components/ui/presence-dot'
import { StatusMenu } from '@/components/layout/status-menu'
import { usePresence } from '@/contexts/presence-context'
import { LiveClock } from '@/components/layout/live-clock'
import { useLiquidGlass } from '@/components/ui/use-liquid-glass'
import { ProfileActions, ChangePasswordModal } from '@/components/layout/sidebar'
import { ModuleTabs, useModuleTabs } from '@/components/layout/module-tabs'
import { crumbsFor } from '@/lib/breadcrumbs'

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

function Breadcrumbs({ isEmployee, crumbLabel }: { isEmployee: boolean; crumbLabel?: string }) {
  const pathname = usePathname()
  const crumbs = crumbsFor(pathname, crumbLabel)

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
  const { user, can } = usePermissions()
  const { mine, available: presenceAvailable } = usePresence()
  const router = useRouter()
  const isEmployee = !user.isAdmin
  // The module's tab bar (Cash Book › Recurring, Invoices › Statements…), on
  // every page of a group declared in lib/nav-sections. It already says where
  // you are and leads back to the module, so the breadcrumb steps aside.
  const moduleTabs = useModuleTabs()

  const [profileOpen, setProfileOpen] = useState(false)

  // ── Page actions: beside the title when they fit, their own row when not ──
  // They used to be squeezed into whatever was left between the title and the
  // global buttons, scrolling sideways with the scrollbar hidden — so on a
  // laptop or tablet "Add Entry" was a sliver and the rest were simply gone.
  // Now the bar is measured: if the actions' natural width does not fit, they
  // drop to a second row and wrap, so every button is always on screen.
  const barRef = useRef<HTMLDivElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const globalsRef = useRef<HTMLDivElement | null>(null)
  const [stackActions, setStackActions] = useState(false)
  const setBarRef = useCallback((el: HTMLDivElement | null) => {
    barRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }, [ref])
  // Liquid glass: content scrolling up under the bar bends along its bottom edge.
  useLiquidGlass(barRef, { bezel: 10, strength: 12 })
  // Publish this bar's height as --page-header-h, so whatever sticks BELOW it
  // (a timeline's day headings, a full-height split view) can sit under it
  // instead of sliding beneath it or guessing a pixel figure that is wrong
  // as soon as a breadcrumb or a tab row comes or goes.
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const root = document.documentElement
    const publish = () => root.style.setProperty('--page-header-h', `${bar.offsetHeight}px`)
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(bar)
    return () => { ro.disconnect(); root.style.removeProperty('--page-header-h') }
  }, [])
  const hasActions = !!actions
  useEffect(() => {
    const bar = barRef.current
    if (!bar || !hasActions) return
    const measure = () => {
      const a = actionsRef.current
      if (!a) return
      // Natural width of the buttons (they never shrink), independent of
      // which layout is showing — so the answer cannot flip-flop.
      let need = 0
      const kids = Array.from(a.children) as HTMLElement[]
      kids.forEach(k => { need += k.offsetWidth })
      need += Math.max(0, kids.length - 1) * 8
      const cs = getComputedStyle(bar)
      const inner = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const globals = globalsRef.current?.offsetWidth ?? 0
      const TITLE_MIN = 176, GAPS = 32
      setStackActions(need + globals + TITLE_MIN + GAPS > inner)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    if (actionsRef.current) ro.observe(actionsRef.current)
    if (globalsRef.current) ro.observe(globalsRef.current)
    return () => ro.disconnect()
  }, [hasActions])
  const [showPwdModal, setShowPwdModal] = useState(false)
  // Buttons that don't fit beside the title go on the module's tab row (tabs
  // left, buttons right) instead of adding a third row to the bar.
  const shareTabRow = stackActions && hasActions && !!moduleTabs

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
      // By attribute, not by ref: the top-bar buttons are rendered twice (a
      // phone copy and a desktop copy) and one ref can only point at the
      // last of them. On a phone that made every tap INSIDE the menu count
      // as outside — the menu closed on mousedown and the tapped item was
      // gone before its click arrived.
      if (!(e.target as Element | null)?.closest?.('[data-profile-menu]')) setProfileOpen(false)
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

  const pathname = usePathname() ?? ''
  const globalActions = (
    <>
      {/* Not on AI Capture itself: there it would only reopen the page you
          are on, which reads the clipboard once, when it first loads. */}
      {can('capture.use') && pathname !== '/dashboard/capture' && (
      <button
        type="button"
        onClick={() => void openAiCapture()}
        title="AI Capture — paste any WhatsApp message, email, product list, or request"
        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-2 text-xs font-semibold text-violet-600 hover:bg-violet-500/15 dark:text-violet-700 dark:text-violet-300 transition-colors"
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">AI Capture</span>
      </button>
      )}
      <LiveClock className="mr-1" />
      {/* Full search bar only at xl: below that the sidebar leaves too little
          room for it beside a page's own actions, and the icon does the same job. */}
      <CommandPaletteTrigger className="hidden xl:flex w-40 2xl:w-64" />
      <CommandPaletteTrigger className="xl:hidden" isCollapsed={true} />
      
      {/* Phones have the bottom bar's More, which opens the same full menu —
          a second way in, at the top, only crowded the title. */}
      <div className="hidden sm:flex">
        <AppLauncherTrigger />
      </div>
      {/* Toggles the app-wide comms widget on its Chat tab — the same surface
          as the corner launcher, reachable from the top bar on every page. */}
      {/* Screen-share control: one click (or Cmd/Ctrl+Shift+H) blurs every
          amount on screen, so the app can be demoed without the figures. */}
      <div className="hidden sm:block mr-1">
        <FiguresToggle />
      </div>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('cirqle:toggleChat'))}
        title="Chat & discussions"
        aria-label="Toggle chat"
        className="inline-flex items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
      >
        <MessageCircle className="h-4 w-4" />
      </button>
      {/* "How do I…?" guides. Icon from sm up; phones reach it from the
          account menu below, where the top bar has no room left. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('cirqle:openHelp'))}
        title="Help — how do I…?"
        aria-label="Help"
        className="hidden sm:inline-flex items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
      >
        <LifeBuoy className="h-4 w-4" />
      </button>
      <NotificationBell />

      {/* Profile Dropdown */}
      <div className="relative ml-1" ref={profileRef} data-profile-menu>
        <button 
          onClick={() => setProfileOpen(!profileOpen)}
          className="flex items-center gap-2 rounded-full hover:bg-secondary/80 p-1 pr-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary group"
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
            <div className="absolute right-0 top-full mt-2 w-72 max-h-[80vh] overflow-y-auto bg-card border border-border shadow-xl shadow-black/5 rounded-xl p-2 z-50 origin-top-right animate-in fade-in zoom-in-95 duration-200">
              <div className="px-2 py-2 mb-2 border-b border-border/50">
                <div className="font-semibold text-foreground text-sm truncate tracking-tight">{user.cqid ?? 'Account'}</div>
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
              <button
                type="button"
                onClick={() => { setProfileOpen(false); window.dispatchEvent(new CustomEvent('cirqle:openHelp')) }}
                className="mb-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-foreground hover:bg-secondary"
              >
                <LifeBuoy className="h-4 w-4 text-primary" />Help — how do I…?
              </button>
              <ProfileActions onChangePassword={() => { setShowPwdModal(true); setProfileOpen(false) }} compact />
            </div>
          </>
        )}
      </div>
    </>
  )

  return (
    <div
      ref={setBarRef}
      // Left padding matches the page body below it (px-4 / sm:px-6). It was
      // sm:pl-16 — room for a top-left menu button that no longer exists — so
      // every title sat 40px to the right of the content it belongs to.
      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-x-3 gap-y-2 sm:gap-x-4 ${stackActions || moduleTabs ? 'sm:flex-wrap' : ''} px-4 sm:px-6 liquid-glass liquid-glass-bar-top sticky top-0 z-30 ${moduleTabs ? 'pt-2.5 sm:pt-3.5 pb-0' : isEmployee ? 'py-2 sm:py-3.5' : 'py-2.5 sm:py-3.5'}`}
    >
      <div className="flex items-center justify-between w-full sm:w-auto sm:flex-1 min-w-0 sm:min-w-[10rem] gap-2">
        {/* Left: Branding & Title */}
        <div className="flex flex-col min-w-0 flex-1 justify-center">
          {!moduleTabs && <Breadcrumbs isEmployee={isEmployee} crumbLabel={crumbLabel} />}
          <div className="flex items-center gap-2 min-w-0">
            {isEmployee && (
              <div className="w-7 h-7 rounded-lg gradient-bg flex items-center justify-center shrink-0 shadow-sm sm:hidden">
                <span className="text-white font-bold text-xs">C</span>
              </div>
            )}
            {title
              ? <h1 className="text-lg md:text-xl font-semibold text-foreground truncate tracking-tight">{title}</h1>
              // A loading screen draws the real bar (so nothing jumps when the
              // page arrives) before it knows the title: a placeholder instead.
              : <span aria-hidden className="h-5 w-32 rounded bg-secondary/60 animate-pulse" />}
            {subtitle && (
              // flex-1 basis-0 = subtitle only ever takes LEFTOVER space, so it
              // can never squeeze the title into truncating while room remains.
              // And it shows only when that space is worth reading: cut to
              // "Match…" or "Tas…" it was noise (container query, 14rem).
              <div className="@container hidden lg:block flex-1 min-w-0">
                <div className="text-sm text-muted-foreground truncate tracking-tight hidden @min-[14rem]:block">{subtitle}</div>
              </div>
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
        // Phones, and any width where they don't fit beside the title: a row
        // of their own that wraps, so no button is ever off-screen.
        // Pages often pass their buttons as one wrapper, which then could not
        // wrap on a phone (Departments & Brands ran 150px off the screen);
        // there it may wrap its own buttons.
        <div ref={actionsRef} className={`flex flex-wrap items-center gap-2 w-full min-w-0 [&>*]:shrink-0 max-sm:[&>*]:max-w-full max-sm:[&>*]:flex-wrap ${shareTabRow
          ? 'sm:order-3 sm:ml-auto sm:w-auto sm:max-w-full sm:justify-end sm:self-end sm:pb-1.5'
          : stackActions ? 'sm:order-last sm:basis-full sm:justify-end' : 'sm:w-auto sm:flex-nowrap sm:shrink-0'}`}>
          {actions}
        </div>
      )}

      {/* Desktop Global Actions (Hidden on Mobile) */}
      <div ref={globalsRef} className="hidden sm:flex items-center gap-1.5 sm:gap-2 shrink-0 border-l border-border/60 pl-2 sm:pl-4">
        {globalActions}
      </div>

      {/* Forces the shared tab row onto a new line under title + globals. */}
      {shareTabRow && <div aria-hidden className="hidden sm:block sm:order-1 sm:basis-full sm:h-0 sm:-mt-2" />}

      {/* Last row, its underline on the bar's bottom edge: full width, or
          beside the page buttons (min width so buttons wrap before the tabs
          are squeezed away). */}
      {moduleTabs && (
        <div className={`order-last w-full min-w-0 ${shareTabRow ? 'sm:order-2 sm:w-auto sm:flex-1 sm:basis-0 sm:min-w-[16rem] sm:self-end' : 'sm:basis-full'}`}>
          <ModuleTabs set={moduleTabs} />
        </div>
      )}

      {showPwdModal && <ChangePasswordModal onClose={() => setShowPwdModal(false)} />}
    </div>
  )
})

export default Header
