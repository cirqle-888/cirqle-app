'use client'

import { memo, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePrivacy } from '@/contexts/privacy-context'
import { usePermissions } from '@/contexts/permission-context'
import { useTheme } from '@/contexts/theme-context'
import {
  LayoutDashboard,
  CheckSquare,
  LogOut,
  ChevronRight,
  TrendingUp,
  Lock,
  Unlock,
  Menu,
  X,
  ChevronLeft,
  Pin,
  PinOff,
  Sun,
  Moon,
  Monitor,
  KeyRound,
  UserCircle,
  ChevronDown,
  Tag,
  Package,
} from 'lucide-react'
import { navSections, isNavItemVisible, resolveActiveHref } from '@/lib/nav-sections'
import { useWorkspace } from '@/contexts/workspace-context'
import { useRequestsBadge } from '@/contexts/requests-badge-context'
import { WorkspaceSwitcher } from '@/components/layout/workspace-switcher'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { FavoritesSection } from '@/components/layout/favorites-section'
import { FavoriteToggle } from '@/components/ui/favorite-toggle'
import { ModalOverlay } from '@/components/ui/modal-overlay'

// ─────────────────────────────────────────────────────
// Change Password Modal
// ─────────────────────────────────────────────────────
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 8) return setError('Password must be at least 8 characters')
    if (password !== confirm) return setError('Passwords do not match')
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setSuccess(true)
      setTimeout(onClose, 2000)
    }
  }

  return (
    <ModalOverlay onClose={onClose} zIndex="z-[100]">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-6 shadow-xl relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
        <h2 className="text-lg font-semibold mb-1">Change Password</h2>
        <p className="text-sm text-muted-foreground mb-5">Update your account password</p>

        {success ? (
          <div className="text-center py-6">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-3">
              <span className="text-2xl">✓</span>
            </div>
            <p className="font-medium text-emerald-500">Password updated successfully!</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">New password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoFocus className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground" placeholder="At least 8 characters" />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Confirm password</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground" placeholder="Re-enter password" />
            </div>
            {error && <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">{error}</div>}
            <button type="submit" disabled={loading} className="w-full gradient-bg text-white font-medium py-2 rounded-lg text-sm hover:opacity-90 disabled:opacity-50">
              {loading ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </ModalOverlay>
  )
}

// Nav definition (grouped by workflow, top = most used) lives in
// src/lib/nav-sections.ts — shared with the icon-grid app launcher so both
// surfaces render the exact same destinations/permissions from one place.

// ─────────────────────────────────────────────────────
// Profile action menu items (shared between sidebar + employee sheet)
// ─────────────────────────────────────────────────────
export function ProfileActions({
  onChangePassword,
  compact = false,
}: {
  onChangePassword: () => void
  compact?: boolean
}) {
  const router = useRouter()
  const { isUnlocked, openUnlockModal, lock } = usePrivacy()
  const { user } = usePermissions()
  const { theme, cycleTheme, mounted: themeMounted } = useTheme()

  async function handleSignOut() {
    const supabase = createClient()
    // scope 'local' ends only this browser's session — the default ('global')
    // revokes every session for the user, including the desktop app.
    await supabase.auth.signOut({ scope: 'local' })
    router.push('/login')
  }

  const itemCls = compact
    ? 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors w-full text-left'
    : 'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors w-full text-left'

  return (
    <div className="space-y-0.5">
      {/* Theme cycle button — Light → Dark → System → Light.
          ─ Until `themeMounted` flips, we render the SSR-safe "System" label
            with a Monitor icon so the server + first client render match.
            After mount, the actual user choice + icon take over. */}
      <button
        onClick={cycleTheme}
        aria-label="Cycle theme (light / dark / system)"
        title={
          !themeMounted ? 'Theme' :
          theme === 'light' ? 'Light mode — click for Dark' :
          theme === 'dark'  ? 'Dark mode — click for System' :
                              'System mode — click for Light'
        }
        className={`${itemCls} text-muted-foreground hover:bg-sidebar-accent hover:text-foreground`}
      >
        <span className="w-4 h-4 shrink-0" aria-hidden="true">
          {!themeMounted ? (
            <Monitor className="w-4 h-4 text-muted-foreground" />
          ) : theme === 'light' ? (
            <Sun className="w-4 h-4 text-amber-500" />
          ) : theme === 'dark' ? (
            <Moon className="w-4 h-4 text-blue-700 dark:text-blue-300" />
          ) : (
            <Monitor className="w-4 h-4 text-violet-700 dark:text-violet-300" />
          )}
        </span>
        <span className="truncate whitespace-nowrap">
          {!themeMounted ? 'Theme' :
            theme === 'light' ? 'Light mode' :
            theme === 'dark'  ? 'Dark mode'  :
                                'System mode'}
        </span>
      </button>

      {/* Privacy lock — all users */}
      <button
        onClick={isUnlocked ? lock : openUnlockModal}
        className={`${itemCls} ${
          isUnlocked
            ? 'text-green-400 hover:bg-green-500/10 hover:text-green-700 dark:text-green-300'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-amber-400'
        }`}
      >
        {isUnlocked
          ? <Unlock className="w-4 h-4 shrink-0" />
          : <Lock className="w-4 h-4 shrink-0" />}
        <span className="truncate whitespace-nowrap">
          {isUnlocked ? 'Privacy unlocked' : 'Privacy locked'}
        </span>
      </button>

      {/* Change password */}
      <button
        onClick={onChangePassword}
        className={`${itemCls} text-muted-foreground hover:bg-sidebar-accent hover:text-foreground`}
      >
        <KeyRound className="w-4 h-4 shrink-0" />
        <span className="truncate whitespace-nowrap">Change password</span>
      </button>

      {/* Sign out */}
      <button
        onClick={handleSignOut}
        className={`${itemCls} text-muted-foreground hover:bg-sidebar-accent hover:text-destructive`}
      >
        <LogOut className="w-4 h-4 shrink-0" />
        <span className="whitespace-nowrap">Sign out</span>
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Sidebar content (shared between desktop and mobile)
// ─────────────────────────────────────────────────────
function SidebarContent({ onNavClick, isCollapsed = false }: { onNavClick?: () => void; isCollapsed?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, can, logoUrl, logoUrlDark, faviconUrl } = usePermissions()
  const { isUnlocked } = usePrivacy()
  const { current: activeWorkspace } = useWorkspace()
  // Local state so a broken/expired logo URL can fall back to the brand mark
  // without leaving a broken-image placeholder visible.
  const [logoBroken, setLogoBroken] = useState(false)
  const [faviconBroken, setFaviconBroken] = useState(false)

  // Requests badge — shared with the App Launcher via RequestsBadgeProvider
  // (single subscription/fetch, see src/contexts/requests-badge-context.tsx).
  const requestsBadge = useRequestsBadge()

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof window !== 'undefined' && (window as any).__CIRQLE_DESKTOP__) {
      // Absolute URL only — the desktop toolbar is a file:// page, so a
      // relative /path would resolve against the app bundle and 404.
      let abs = ''
      try { abs = logoUrl ? new URL(logoUrl, window.location.origin).href : '' } catch { abs = '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__CIRQLE_DESKTOP__.updateLogo(abs)
    }
  }, [logoUrl])

  // Pre-compute visible sections once per permission change — avoids re-filtering on
  // every route transition (pathname is the only thing changing in the common case).
  // Workspace scoping is a pure UI filter LAYERED ON TOP of the permission
  // filter below — it can only hide items the workspace didn't select, never
  // reveal anything the viewer's permissions don't already allow. A workspace
  // with sidebarModuleHrefs=null (e.g. "All Workspace") applies no restriction.
  const workspaceHrefs = activeWorkspace.sidebarModuleHrefs
  const visibleNavSections = useMemo(
    () =>
      navSections
        .map(s => ({
          ...s,
          items: s.items.filter(i =>
            isNavItemVisible(i, can, user.isAdmin) &&
            (!workspaceHrefs || workspaceHrefs.includes(i.href))
          ),
        }))
        .filter(s => s.items.length > 0),
    [can, user.isAdmin, workspaceHrefs],
  )

  const activeHref = useMemo(() => resolveActiveHref(visibleNavSections, pathname), [visibleNavSections, pathname])

  // ── Accordion state ─────────────────────────────────
  // Labeled sections collapse to keep the sidebar short. First paint uses each
  // section's defaultOpen (SSR-safe); the user's own toggles then hydrate from
  // localStorage and persist on every change.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  useEffect(() => {
    try { setOpenSections(JSON.parse(localStorage.getItem('sidebar-open-sections') || '{}')) } catch { /* first run */ }
  }, [])

  const isSectionOpen = (label: string | undefined, defaultOpen?: boolean) =>
    !label || (openSections[label] ?? defaultOpen ?? true)

  function toggleSection(label: string, currentOpen: boolean) {
    setOpenSections(prev => {
      const next = { ...prev, [label]: !currentOpen }
      try { localStorage.setItem('sidebar-open-sections', JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }

  // Never let the active route hide inside a closed group: opening happens in
  // state only (not persisted), so the user's saved preference is untouched.
  const activeSectionLabel = useMemo(
    () => visibleNavSections.find(s => s.items.some(i => i.href === activeHref))?.label ?? null,
    [visibleNavSections, activeHref],
  )
  useEffect(() => {
    if (!activeSectionLabel) return
    setOpenSections(prev => prev[activeSectionLabel] === true ? prev : { ...prev, [activeSectionLabel]: true })
  }, [activeSectionLabel])

  async function handleSignOut() {
    const supabase = createClient()
    // scope 'local' ends only this browser's session — the default ('global')
    // revokes every session for the user, including the desktop app.
    await supabase.auth.signOut({ scope: 'local' })
    router.push('/login')
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-h-0">
      {/* Logo */}
      <div className={`py-5 border-b border-sidebar-border transition-all duration-300 ${isCollapsed ? 'flex flex-col items-center px-0' : 'px-5'}`}>
        <div className={`flex items-center transition-all duration-300 ${isCollapsed ? 'justify-center gap-0' : 'gap-2.5'}`}>
          {/* When a workspace logo is configured, show ONLY the logo — it
              already contains the brand wordmark, so the "Cirqle / Design
              Agency" text is redundant. Falls back to the gradient "C" tile
              + brand text only when no logo exists (first-run installs).
              Two <img> elements allow pure-CSS dark/light switching without
              any JS flicker or theme-context read. The dark logo is shown by
              default and hidden in light mode; the light logo is hidden by
              default and shown in light mode. If only one logo is configured,
              logoUrlLight falls back to logoUrl so both imgs use the same src
              and the correct one is always visible. */}
          {logoUrl && !logoBroken ? (
            isCollapsed && faviconUrl && !faviconBroken ? (
              /* Collapsed rail: show the favicon / icon mark from Settings — the
                 full wordmark logo doesn't fit. Falls back to the shrunk logo
                 below if no favicon is configured (or it fails to load). */
              <img
                src={faviconUrl}
                alt="Workspace icon"
                onError={() => setFaviconBroken(true)}
                className="w-8 h-8 object-contain transition-all duration-300"
              />
            ) : (
              <>
                {/* Light-mode logo (logo_url) — shown in light mode, hidden in dark */}
                <img
                  src={logoUrl}
                  alt="Workspace logo"
                  onError={() => setLogoBroken(true)}
                  className={`object-contain transition-all duration-300 block dark:hidden ${
                    isCollapsed ? 'w-8 h-8' : 'h-10 max-w-[160px]'
                  }`}
                />
                {/* Dark-mode logo (logo_url_dark) — shown in dark mode, hidden in light.
                    Falls back to logoUrl when no separate dark logo has been uploaded. */}
                <img
                  src={logoUrlDark || logoUrl}
                  alt="Workspace logo"
                  onError={() => setLogoBroken(true)}
                  className={`object-contain transition-all duration-300 hidden dark:block ${
                    isCollapsed ? 'w-8 h-8' : 'h-10 max-w-[160px]'
                  }`}
                />
              </>
            )
          ) : (
            <>
              <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center shrink-0">
                <span className="text-white font-bold text-sm">C</span>
              </div>
              <div className={`overflow-hidden transition-all duration-300 flex flex-col justify-center ${isCollapsed ? 'w-0 opacity-0' : 'w-[120px] opacity-100'}`}>
                <div className="font-bold text-sidebar-foreground text-sm leading-tight gradient-text whitespace-nowrap">Cirqle</div>
                <div className="text-[10px] text-muted-foreground leading-tight whitespace-nowrap">Design Agency</div>
              </div>
            </>
          )}
        </div>

        {/* Designation badge */}
        {(user.isAdmin || user.designationName) && (
          <div className={`overflow-hidden transition-all duration-300 ${isCollapsed ? 'max-h-0 opacity-0 mt-0' : 'max-h-10 opacity-100 mt-3'}`}>
            <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
              user.isAdmin
                ? 'bg-purple-500/15 text-purple-400 border-purple-500/25'
                : 'bg-secondary text-muted-foreground border-border'
            }`}>
              {user.designationName || (user.isAdmin ? 'Admin' : 'Member')}
              {isUnlocked && user.name ? ` · ${user.name.split(' ')[0]}` : ''}
            </span>
          </div>
        )}
      </div>

      <WorkspaceSwitcher isCollapsed={isCollapsed} />

      {/* Nav */}
      <nav className={`flex-1 py-4 overflow-y-auto ${isCollapsed ? 'px-2' : 'px-3'}`}>
        <FavoritesSection isCollapsed={isCollapsed} activeHref={activeHref} onNavClick={onNavClick} />
        {visibleNavSections.map((section, sIdx) => {
          const visibleItems = section.items
          const open = isSectionOpen(section.label, section.defaultOpen)
          const sectionHasActive = visibleItems.some(i => i.href === activeHref)
          const sectionHasBadge = visibleItems.some(i => i.href === '/dashboard/requests') && requestsBadge > 0
          const itemsBlock = (
            <div className="space-y-px">
              {visibleItems.map(({ label, href, icon: Icon }) => {
                const active = href === activeHref
                const iconKey = Icon.displayName || 'Star'
                return (
                  <div key={href} className="relative group">
                    <Link
                      href={href}
                      onClick={onNavClick}
                      title={isCollapsed ? label : undefined}
                      aria-current={active ? 'page' : undefined}
                      className={`relative flex items-center rounded-lg text-sm transition-all duration-200 ${
                        isCollapsed ? 'justify-center p-2.5' : 'gap-2.5 px-3 py-2'
                      } ${
                        active
                          ? 'bg-sidebar-accent/70 text-foreground font-semibold'
                          : 'font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground'
                      }`}
                    >
                      {/* Active indicator — slim brand-gradient bar */}
                      {active && !isCollapsed && (
                        <span aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-full gradient-bg" />
                      )}
                      <span className="relative shrink-0">
                        <Icon className={`w-4 h-4 shrink-0 transition-colors ${active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`} />
                        {href === '/dashboard/requests' && requestsBadge > 0 && isCollapsed && (
                          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400" />
                        )}
                      </span>
                      <div className={`flex items-center overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'flex-1 opacity-100'}`}>
                        <span className="flex-1 truncate whitespace-nowrap">{label}</span>
                        {href === '/dashboard/requests' && requestsBadge > 0 && (
                          <span className="ml-2 shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[10px] font-bold flex items-center justify-center">
                            {requestsBadge > 99 ? '99+' : requestsBadge}
                          </span>
                        )}
                      </div>
                    </Link>
                    {!isCollapsed && (
                      <FavoriteToggle
                        entityType="nav_page"
                        // href doubles as the entity id — each nav page must be
                        // individually identifiable or pinning one replaces another
                        entityId={href}
                        href={href}
                        label={label}
                        iconKey={iconKey}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )

          // Collapsed rail: every icon stays reachable — accordion only applies
          // to the expanded sidebar. Sections separate with a short divider.
          if (isCollapsed) {
            return (
              <div key={sIdx} className={sIdx > 0 ? 'mt-2' : ''}>
                {section.label && (
                  <div className="flex justify-center mb-2">
                    <div className="w-4 h-px bg-sidebar-border" />
                  </div>
                )}
                {itemsBlock}
              </div>
            )
          }

          // Unlabeled section (Dashboard) — always visible, no header.
          if (!section.label) return <div key={sIdx} className={sIdx > 0 ? 'mt-3' : ''}>{itemsBlock}</div>

          return (
            <div key={sIdx} className="mt-3">
              <button
                type="button"
                onClick={() => toggleSection(section.label!, open)}
                aria-expanded={open}
                className="w-full flex items-center justify-between px-3 py-1 rounded-md group/hdr select-none"
              >
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/50 group-hover/hdr:text-muted-foreground transition-colors whitespace-nowrap">
                  {section.label}
                  {/* Closed-state hints: a dot when the group holds the active page
                      (can only flash briefly — it auto-opens), amber when it holds
                      the Requests badge so pending work is never invisible. */}
                  {!open && sectionHasActive && <span className="w-1 h-1 rounded-full gradient-bg" />}
                  {!open && sectionHasBadge && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
                </span>
                <ChevronDown className={`w-3 h-3 text-muted-foreground/40 group-hover/hdr:text-muted-foreground transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
              </button>
              <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                {/* inert removes the hidden links from tab order + screen readers
                    while collapsed — overflow-hidden alone only hides them visually. */}
                <div className="overflow-hidden min-h-0" inert={!open}>
                  {itemsBlock}
                </div>
              </div>
            </div>
          )
        })}
      </nav>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Employee Profile Sheet (slide-up from bottom nav)
// ─────────────────────────────────────────────────────
function EmployeeProfileSheet({ onClose, onChangePassword }: { onClose: () => void; onChangePassword: () => void }) {
  const { user } = usePermissions()
  const { isUnlocked } = usePrivacy()

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Sheet */}
      <div className="fixed bottom-[57px] left-0 right-0 z-50 bg-sidebar border-t border-sidebar-border rounded-t-2xl shadow-2xl px-4 pt-4 pb-3 animate-in slide-in-from-bottom-4 duration-200">
        {/* Handle */}
        <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />

        {/* Profile row */}
        <div className="flex items-center gap-3 px-1 mb-3">
          {user.cqid ? (
            <EmployeeAvatar
              avatarUrl={null}
              name={user.cqid}
              cqid={user.cqid}
              size={36}
              rounded="full"
              className="shrink-0"
            />
          ) : (
            <UserCircle className="w-9 h-9 text-muted-foreground shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">{user.cqid ?? 'Account'}</div>
            {/* eslint-disable-next-line no-restricted-syntax -- deliberate: the SIGNED-IN user's own name in their own account panel, and only while privacy is unlocked. Never another employee's name. */}
            {isUnlocked && user.name && <div className="text-xs text-muted-foreground truncate">{user.name}</div>}
            {user.designationName && (
              <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border whitespace-nowrap mt-0.5">
                {user.designationName}
              </span>
            )}
          </div>
        </div>

        <div className="h-px bg-border mb-2" />

        <ProfileActions onChangePassword={() => { onClose(); onChangePassword() }} compact />
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────
export default function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showPwdModal, setShowPwdModal] = useState(false)
  const [profileSheetOpen, setProfileSheetOpen] = useState(false)
  const [isPinned, setIsPinned] = useState(true)
  const [isHovered, setIsHovered] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const stored = localStorage.getItem('sidebar-pinned')
    if (stored !== null) {
      setIsPinned(stored === 'true')
    }
    
    // Auto-collapse on tablet
    const checkWidth = () => {
      if (window.innerWidth >= 768 && window.innerWidth < 1024) {
        setIsPinned(false)
      }
    }
    window.addEventListener('resize', checkWidth)
    checkWidth()
    return () => window.removeEventListener('resize', checkWidth)
  }, [])

  const togglePin = () => {
    const next = !isPinned
    setIsPinned(next)
    localStorage.setItem('sidebar-pinned', String(next))
  }
  const { user } = usePermissions()
  const pathname = usePathname()

  const isEmployee = !user.isAdmin
  const isCollapsed = !isPinned && !isHovered

  // Default to pinned state when rendering on server to avoid layout shift,
  // client will adjust immediately on mount.
  const effectivePinned = mounted ? isPinned : true
  const effectiveCollapsed = !effectivePinned && !isHovered

  return (
    <>
      {/* Spacer for desktop layout so main content doesn't shift on hover when unpinned */}
      <div className={`hidden md:block shrink-0 relative transition-[width] duration-300 ease-in-out ${effectivePinned ? 'w-60' : 'w-[72px]'}`}>
        {/* ── Desktop sidebar ── */}
        <aside 
          onMouseEnter={() => !effectivePinned && setIsHovered(true)}
          onMouseLeave={() => !effectivePinned && setIsHovered(false)}
          className={`absolute left-0 top-0 h-dvh flex-col bg-sidebar border-r border-sidebar-border transition-all duration-300 ease-in-out z-40 flex overflow-hidden ${effectiveCollapsed ? 'w-[72px]' : 'w-60'}`}
        >
          <SidebarContent isCollapsed={effectiveCollapsed} />
          
          <div className="p-3 border-t border-sidebar-border mt-auto">
            <button
              onClick={togglePin}
              title={effectivePinned ? 'Collapse sidebar' : 'Pin sidebar'}
              className="flex w-full items-center gap-3 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-sidebar-accent rounded-lg transition-colors"
            >
              {effectivePinned ? <ChevronLeft className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
              <span className={`truncate whitespace-nowrap transition-all duration-300 ${effectiveCollapsed ? 'opacity-0 w-0' : 'opacity-100'}`}>
                {effectivePinned ? 'Collapse' : 'Pin sidebar'}
              </span>
            </button>
          </div>
        </aside>
      </div>

      {/* ── Mobile: hamburger (admin only) ── */}
      {!mobileOpen && !isEmployee && (
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="md:hidden fixed top-4 left-4 z-50 w-9 h-9 flex items-center justify-center rounded-lg bg-sidebar border border-sidebar-border shadow-md text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* ── Mobile: backdrop (drawer) ── */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Mobile: slide-out drawer ──
          Was admin-only, alongside a three-item bottom bar for everyone else.
          That assumed an employee only ever needs Home, Tasks and Activity —
          true when employees were designers, and false now: a Task Manager
          holds Invoices, Cash Book, Statements, Follow-ups, Clients, Requests
          and Approvals on desktop and could reach none of them on a phone.

          The drawer already renders exactly what the person is allowed to see
          (SidebarContent filters through isNavItemVisible), so it needed no
          new nav logic — only for the gate to come off. Admins open it from
          the hamburger; employees open it from the More tab below, since the
          employee header reserves no room at top-left for one. */}
      {(
        <aside
          className={`md:hidden fixed top-0 left-0 z-50 h-full w-72 bg-sidebar border-r border-sidebar-border shadow-2xl flex flex-col
            transition-transform duration-300 ease-in-out
            ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
          <SidebarContent onNavClick={() => setMobileOpen(false)} isCollapsed={false} />
        </aside>
      )}

      {/* ── Mobile: Employee Bottom Nav Bar ── */}
      {isEmployee && (
        <div className="md:hidden fixed bottom-0 left-0 w-full z-50 bg-sidebar border-t border-sidebar-border pb-safe pt-1 px-2 flex items-center justify-around shadow-[0_-4px_20px_rgba(0,0,0,0.2)]">
          {[
            { href: '/dashboard',              label: 'Home',     icon: LayoutDashboard },
            { href: '/dashboard/tasks',        label: 'Tasks',    icon: CheckSquare },
            { href: '/dashboard/contributions',label: 'Activity', icon: TrendingUp },
          ].map(item => {
            // Dashboard root: exact match only so Tasks/Contributions don't highlight it
            const active = item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href)
            const Icon = item.icon
            return (
              <Link key={item.href} href={item.href} className="flex flex-col items-center justify-center py-2 px-1 w-1/5">
                <div className={`w-10 h-8 flex items-center justify-center rounded-full transition-all ${active ? 'bg-primary/20 text-primary' : 'text-muted-foreground'}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <span className={`text-[10px] mt-1 font-medium transition-colors ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {item.label}
                </span>
              </Link>
            )
          })}

          {/* Everything else they can reach. The three tabs above are the
              daily destinations; this is the rest of what their permissions
              allow, which used to be unreachable on a phone entirely. */}
          <button
            onClick={() => { setProfileSheetOpen(false); setMobileOpen(true) }}
            aria-label="More sections"
            className="flex flex-col items-center justify-center py-2 px-1 w-1/5"
          >
            <div className="w-10 h-8 flex items-center justify-center rounded-full transition-all text-muted-foreground">
              <Menu className="w-5 h-5" />
            </div>
            <span className="text-[10px] mt-1 font-medium text-muted-foreground">More</span>
          </button>

          {/* Profile tab */}
          <button
            onClick={() => setProfileSheetOpen(o => !o)}
            className="flex flex-col items-center justify-center py-2 px-1 w-1/5"
          >
            <div className={`w-10 h-8 flex items-center justify-center rounded-full transition-all ${profileSheetOpen ? 'bg-primary/20 text-primary' : 'text-muted-foreground'}`}>
              <UserCircle className="w-5 h-5" />
            </div>
            <span className={`text-[10px] mt-1 font-medium transition-colors ${profileSheetOpen ? 'text-foreground' : 'text-muted-foreground'}`}>
              Me
            </span>
          </button>
        </div>
      )}

      {/* ── Employee profile sheet ── */}
      {isEmployee && profileSheetOpen && (
        <EmployeeProfileSheet
          onClose={() => setProfileSheetOpen(false)}
          onChangePassword={() => setShowPwdModal(true)}
        />
      )}

      {/* Change password modal (employee path) */}
      {showPwdModal && <ChangePasswordModal onClose={() => setShowPwdModal(false)} />}
    </>
  )
}
