'use client'

import { memo, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePrivacy } from '@/contexts/privacy-context'
import { usePermissions } from '@/contexts/permission-context'
import { useTheme } from '@/contexts/theme-context'
import {
  LayoutDashboard,
  CheckSquare,
  Users2,
  FileText,
  BookOpen,
  Wallet,
  BarChart3,
  Settings,
  LogOut,
  ChevronRight,
  TrendingUp,
  Lock,
  Unlock,
  Upload,
  Menu,
  X,
  ChevronLeft,
  Sun,
  Moon,
  KeyRound,
  UserCircle,
  ChevronDown,
} from 'lucide-react'
import { CommandPaletteTrigger } from '@/components/ui/command-palette'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { ModalOverlay } from '@/components/ui/modal-overlay'

// ─────────────────────────────────────────────────────
// Change Password Modal
// ─────────────────────────────────────────────────────
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
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

// ─────────────────────────────────────────────────────
// Nav definition — grouped by workflow (top = most used)
// ─────────────────────────────────────────────────────
type NavItem = { label: string; href: string; icon: typeof LayoutDashboard; requiredPerm?: string; adminOnly?: boolean }
type NavSection = { label?: string; items: NavItem[] }

const navSections: NavSection[] = [
  {
    items: [
      { label: 'Dashboard',     href: '/dashboard',               icon: LayoutDashboard, requiredPerm: 'dashboard.view' },
      { label: 'Tasks',         href: '/dashboard/tasks',         icon: CheckSquare },
      { label: 'Contributions', href: '/dashboard/contributions', icon: TrendingUp },
    ],
  },
  {
    label: 'Money',
    items: [
      { label: 'Quotations',  href: '/dashboard/quotations', icon: BookOpen, requiredPerm: 'billing.view_quotations' },
      { label: 'Invoices',    href: '/dashboard/invoices',   icon: FileText, requiredPerm: 'billing.view_invoices' },
      { label: 'Cash Book',   href: '/dashboard/cashbook',   icon: Wallet,   requiredPerm: 'cashbook.view' },
    ],
  },
  {
    label: 'Team',
    items: [
      { label: 'HR & Payroll', href: '/dashboard/payroll', icon: Users2, requiredPerm: 'payroll.view' },
    ],
  },
  {
    label: 'Insights',
    items: [
      // Reports is gated by reports.view — admins always have it; non-admins
      // see the tab only when their designation grants it in Settings → Designations.
      { label: 'Reports', href: '/dashboard/reports', icon: BarChart3, requiredPerm: 'reports.view' },
    ],
  },
  {
    label: 'System',
    items: [
      // Bulk Import is strictly admin-only — it can mass-create tasks,
      // contributions, and cashbook entries, so it shouldn't surface to
      // non-admin team members who might happen to hold `tasks.create`.
      { label: 'Bulk Import', href: '/dashboard/import',   icon: Upload,   adminOnly: true },
      { label: 'Settings',    href: '/dashboard/settings', icon: Settings, requiredPerm: 'settings.access' },
    ],
  },
]

// ─────────────────────────────────────────────────────
// Profile action menu items (shared between sidebar + employee sheet)
// ─────────────────────────────────────────────────────
function ProfileActions({
  onChangePassword,
  compact = false,
}: {
  onChangePassword: () => void
  compact?: boolean
}) {
  const router = useRouter()
  const { isUnlocked, openUnlockModal, lock } = usePrivacy()
  const { user } = usePermissions()
  const { toggleTheme } = useTheme()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const itemCls = compact
    ? 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors w-full text-left'
    : 'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors w-full text-left'

  return (
    <div className="space-y-0.5">
      {/* Dark / Light mode
          ─ Both icons + labels are rendered in the DOM; CSS picks the visible
            one via the `dark:` Tailwind variant, which reads the `.dark` class
            on <html> set by /public/theme-init.js before first paint.
          ─ This means server + client emit identical markup → zero hydration
            mismatch. The toggle button needs no `suppressHydrationWarning`. */}
      <button
        onClick={toggleTheme}
        aria-label="Toggle theme"
        className={`${itemCls} text-muted-foreground hover:bg-sidebar-accent hover:text-foreground`}
      >
        <span className="relative w-4 h-4 shrink-0" aria-hidden="true">
          <Sun  className="block dark:hidden w-4 h-4 text-amber-500" />
          <Moon className="hidden dark:block w-4 h-4 text-blue-300" />
        </span>
        <span className="truncate whitespace-nowrap">
          <span className="block dark:hidden">Light mode</span>
          <span className="hidden dark:block">Dark mode</span>
        </span>
      </button>

      {/* Privacy lock — all users */}
      <button
        onClick={isUnlocked ? lock : openUnlockModal}
        className={`${itemCls} ${
          isUnlocked
            ? 'text-green-400 hover:bg-green-500/10 hover:text-green-300'
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
  const [showPwdModal, setShowPwdModal] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const { user, can, logoUrl } = usePermissions()
  const { isUnlocked } = usePrivacy()
  // Local state so a broken/expired logo URL can fall back to the brand mark
  // without leaving a broken-image placeholder visible.
  const [logoBroken, setLogoBroken] = useState(false)

  // Pre-compute visible sections once per permission change — avoids re-filtering on
  // every route transition (pathname is the only thing changing in the common case).
  const visibleNavSections = useMemo(
    () =>
      navSections
        .map(s => ({
          ...s,
          items: s.items.filter(i =>
            (!i.requiredPerm || can(i.requiredPerm)) &&
            (!i.adminOnly || user.isAdmin)
          ),
        }))
        .filter(s => s.items.length > 0),
    [can, user.isAdmin],
  )

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Logo */}
      <div className={`py-5 border-b border-sidebar-border transition-all duration-300 ${isCollapsed ? 'flex flex-col items-center px-0' : 'px-5'}`}>
        <div className={`flex items-center transition-all duration-300 ${isCollapsed ? 'justify-center gap-0' : 'gap-2.5'}`}>
          {/* When a workspace logo is configured, show ONLY the logo — it
              already contains the brand wordmark, so the "Cirqle / Design
              Agency" text is redundant. Falls back to the gradient "C" tile
              + brand text only when no logo exists (first-run installs). */}
          {logoUrl && !logoBroken ? (
            <img
              src={logoUrl}
              alt="Workspace logo"
              onError={() => setLogoBroken(true)}
              className={`object-contain transition-all duration-300 ${
                isCollapsed ? 'w-8 h-8' : 'h-10 max-w-[160px]'
              }`}
            />
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

      {/* Search trigger */}
      <div className={`py-2 border-b border-sidebar-border transition-all duration-300 ${isCollapsed ? 'flex justify-center px-0' : 'px-3'}`}>
        <CommandPaletteTrigger className={isCollapsed ? '' : 'w-full'} isCollapsed={isCollapsed} />
      </div>

      {/* Nav */}
      <nav className={`flex-1 py-4 overflow-y-auto ${isCollapsed ? 'px-2' : 'px-3'}`}>
        {visibleNavSections.map((section, sIdx) => {
          const visibleItems = section.items
          return (
            <div key={sIdx} className={sIdx > 0 ? 'mt-4' : ''}>
              {section.label && (
                <div className="relative">
                  <div className={`overflow-hidden transition-all duration-300 ${isCollapsed ? 'h-0 opacity-0 mb-0' : 'h-4 opacity-100 mb-1.5'}`}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 px-3 whitespace-nowrap">
                      {section.label}
                    </p>
                  </div>
                  <div className={`flex justify-center overflow-hidden transition-all duration-300 ${isCollapsed ? 'h-4 opacity-100 mb-1.5' : 'h-0 opacity-0 mb-0'}`}>
                    <div className="w-4 h-px bg-sidebar-border mt-2" />
                  </div>
                </div>
              )}
              <div className="space-y-0.5">
                {visibleItems.map(({ label, href, icon: Icon }) => {
                  const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={onNavClick}
                      title={isCollapsed ? label : undefined}
                      className={`flex items-center rounded-lg text-sm font-medium transition-all duration-300 group ${
                        isCollapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5'
                      } ${
                        active
                          ? 'bg-primary/15 text-primary'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 transition-colors ${active ? 'text-primary' : 'text-muted-foreground group-hover:text-sidebar-accent-foreground'}`} />
                      <div className={`flex items-center overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'flex-1 opacity-100'}`}>
                        <span className="flex-1 truncate whitespace-nowrap">{label}</span>
                        {active && <ChevronRight className="w-3 h-3 text-primary shrink-0 ml-2" />}
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      {/* ── Profile actions — in-flow, above the border, so never clipped ── */}
      {!isCollapsed && profileOpen && (
        <div className={`transition-all duration-200 ${isCollapsed ? 'px-2' : 'px-3'} pb-1`}>
          <div className="bg-sidebar-accent/50 border border-sidebar-border rounded-xl p-1">
            <ProfileActions onChangePassword={() => setShowPwdModal(true)} />
          </div>
        </div>
      )}

      {/* ── Profile row + sign-out (collapsed) ── */}
      <div className={`border-t border-sidebar-border pb-3 transition-all duration-300 ${isCollapsed ? 'px-2 pt-2' : 'px-3 pt-2'}`}>
        {isCollapsed ? (
          <button
            onClick={handleSignOut}
            title="Sign out"
            className="flex items-center justify-center p-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-destructive transition-all duration-300 w-full"
          >
            <LogOut className="w-4 h-4 shrink-0" />
          </button>
        ) : (
          <button
            onClick={() => setProfileOpen(o => !o)}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg w-full transition-colors group ${profileOpen ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent'}`}
          >
            {user.cqid ? (
              <EmployeeAvatar
                avatarUrl={null}
                name={user.cqid}
                cqid={user.cqid}
                size={28}
                rounded="full"
                className="shrink-0"
              />
            ) : (
              <UserCircle className="w-7 h-7 text-muted-foreground shrink-0" />
            )}
            <div className="flex-1 min-w-0 text-left">
              <div className="text-sm font-medium text-sidebar-foreground truncate leading-tight">
                {user.cqid ?? 'Account'}
              </div>
              {isUnlocked && user.name && (
                <div className="text-[11px] text-muted-foreground truncate leading-tight">{user.name}</div>
              )}
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform duration-200 ${profileOpen ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {showPwdModal && <ChangePasswordModal onClose={() => setShowPwdModal(false)} />}
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
  const [isCollapsed, setIsCollapsed] = useState(false)
  const { user } = usePermissions()
  const pathname = usePathname()

  const isEmployee = !user.isAdmin

  return (
    <>
      {/* ── Desktop sidebar ── */}
      <aside className={`hidden md:flex shrink-0 h-screen flex-col bg-sidebar border-r border-sidebar-border transition-all duration-300 ease-in-out relative ${isCollapsed ? 'w-[72px]' : 'w-60'}`}>
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="absolute -right-3 top-6 z-50 flex items-center justify-center w-6 h-6 bg-sidebar border border-sidebar-border rounded-full text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors shadow-sm"
        >
          {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>
        <SidebarContent isCollapsed={isCollapsed} />
      </aside>

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

      {/* ── Mobile: backdrop (admin drawer) ── */}
      {mobileOpen && !isEmployee && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Mobile: slide-out drawer (admin) ── */}
      {!isEmployee && (
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
              <Link key={item.href} href={item.href} className="flex flex-col items-center justify-center py-2 px-1 w-1/4">
                <div className={`w-10 h-8 flex items-center justify-center rounded-full transition-all ${active ? 'bg-primary/20 text-primary' : 'text-muted-foreground'}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <span className={`text-[10px] mt-1 font-medium transition-colors ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {item.label}
                </span>
              </Link>
            )
          })}

          {/* Profile tab */}
          <button
            onClick={() => setProfileSheetOpen(o => !o)}
            className="flex flex-col items-center justify-center py-2 px-1 w-1/4"
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
