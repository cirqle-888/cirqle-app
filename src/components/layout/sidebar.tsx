'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePrivacy } from '@/contexts/privacy-context'
import { useRole, Role, roleRoutes } from '@/contexts/role-context'
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
type NavItem = { label: string; href: string; icon: typeof LayoutDashboard }
type NavSection = { label?: string; items: NavItem[] }

const navSections: NavSection[] = [
  {
    // Daily ops — no label needed (always on top)
    items: [
      { label: 'Dashboard',     href: '/dashboard',              icon: LayoutDashboard },
      { label: 'Tasks',         href: '/dashboard/tasks',        icon: CheckSquare },
      { label: 'Contributions', href: '/dashboard/contributions',icon: TrendingUp },
    ],
  },
  {
    label: 'Money',
    items: [
      { label: 'Quotations',    href: '/dashboard/quotations',   icon: BookOpen },
      { label: 'Invoices',      href: '/dashboard/invoices',     icon: FileText },
      { label: 'Cash Book',     href: '/dashboard/cashbook',     icon: Wallet },
    ],
  },
  {
    label: 'Team',
    items: [
      { label: 'HR & Payroll',  href: '/dashboard/payroll',      icon: Users2 },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Reports',       href: '/dashboard/reports',      icon: BarChart3 },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Bulk Import',   href: '/dashboard/import',       icon: Upload },
      { label: 'Settings',      href: '/dashboard/settings',     icon: Settings },
    ],
  },
]

// Flat list for role-filtering and other code that needs a list
const allNav: NavItem[] = navSections.flatMap(s => s.items)

// ─────────────────────────────────────────────────────
// Role badge colours
// ─────────────────────────────────────────────────────
const roleBadgeClass: Record<Role, string> = {
  super_admin: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  accounts:    'bg-blue-500/15   text-blue-400   border-blue-500/25',
  team_lead:   'bg-green-500/15  text-green-400  border-green-500/25',
  employee:    'bg-gray-500/15   text-gray-400   border-gray-500/25',
  view_only:   'bg-orange-500/15 text-orange-400 border-orange-500/25',
}

const roleLabel: Record<Role, string> = {
  super_admin: 'Super Admin',
  accounts:    'Accounts',
  team_lead:   'Team Lead',
  employee:    'Employee',
  view_only:   'View Only',
}

// ─────────────────────────────────────────────────────
// Sidebar content (shared between desktop and mobile)
// ─────────────────────────────────────────────────────
function SidebarContent({ onNavClick, isCollapsed = false }: { onNavClick?: () => void; isCollapsed?: boolean }) {
  const [showPwdModal, setShowPwdModal] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const { isUnlocked, openUnlockModal, lock } = usePrivacy()
  const { role, employee } = useRole()
  const { theme, toggleTheme } = useTheme()

  const allowedRoutes = roleRoutes[role]
  const nav = allNav.filter(item => allowedRoutes.includes(item.href))

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
          <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm">C</span>
          </div>
          <div className={`overflow-hidden transition-all duration-300 flex flex-col justify-center ${isCollapsed ? 'w-0 opacity-0' : 'w-[120px] opacity-100'}`}>
            <div className="font-bold text-sidebar-foreground text-sm leading-tight gradient-text whitespace-nowrap">Cirqle</div>
            <div className="text-[10px] text-muted-foreground leading-tight whitespace-nowrap">Design Agency</div>
          </div>
        </div>

        {/* Role badge */}
        {role !== 'employee' && (
          <div className={`overflow-hidden transition-all duration-300 ${isCollapsed ? 'max-h-0 opacity-0 mt-0' : 'max-h-10 opacity-100 mt-3'}`}>
            <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${roleBadgeClass[role]}`}>
              {roleLabel[role]}
              {employee?.name ? ` · ${employee.name.split(' ')[0]}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Search trigger */}
      <div className={`py-2 border-b border-sidebar-border transition-all duration-300 ${isCollapsed ? 'flex justify-center px-0' : 'px-3'}`}>
        <CommandPaletteTrigger className={isCollapsed ? '' : 'w-full'} isCollapsed={isCollapsed} />
      </div>

      {/* Nav — grouped by workflow */}
      <nav className={`flex-1 py-4 overflow-y-auto ${isCollapsed ? 'px-2' : 'px-3'}`}>
        {navSections.map((section, sIdx) => {
          // Filter section items by role
          const visibleItems = section.items.filter(it => nav.some(n => n.href === it.href))
          if (visibleItems.length === 0) return null
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

      {/* Theme toggle.
          suppressHydrationWarning: the SSR-rendered theme is the default ('dark') because
          the server can't read localStorage. The themeInitScript synchronously sets the
          real theme on <html> before React hydrates, so by the time this button renders
          client-side, the theme state may differ from the server output. The mismatch is
          intentional and local — silence the warning on the elements that swap. */}
      <div className={`pt-2 border-t border-sidebar-border transition-all duration-300 ${isCollapsed ? 'px-2' : 'px-3'}`}>
        <button
          onClick={toggleTheme}
          suppressHydrationWarning
          title={theme === 'dark' ? 'Dark mode — click for light' : 'Light mode — click for dark'}
          className={`flex items-center rounded-lg text-sm font-medium transition-all duration-300 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground ${
            isCollapsed ? 'justify-center p-2.5' : 'gap-3 w-full px-3 py-2.5'
          }`}
        >
          <span suppressHydrationWarning>
            {theme === 'dark'
              ? <Moon className="w-4 h-4 shrink-0 text-blue-300 transition-colors" />
              : <Sun className="w-4 h-4 shrink-0 text-amber-500 transition-colors" />}
          </span>
          <div className={`text-left overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'flex-1 opacity-100'}`}>
            <span suppressHydrationWarning className="block leading-tight truncate whitespace-nowrap">{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
            <span className="block text-[10px] opacity-60 leading-tight truncate whitespace-nowrap">
              Tap to switch theme
            </span>
          </div>
        </button>
      </div>

      {/* Privacy lock */}
      {role !== 'employee' && (
        <div className={`pt-1 transition-all duration-300 ${isCollapsed ? 'px-2 pb-2' : 'px-3'}`}>
          <button
            onClick={isUnlocked ? lock : openUnlockModal}
            title={isUnlocked ? 'Employee names visible — click to lock' : 'Employee names hidden — click to unlock'}
            className={`flex items-center rounded-lg text-sm font-medium transition-all duration-300 ${
              isCollapsed ? 'justify-center p-2.5' : 'gap-3 w-full px-3 py-2.5'
            } ${
              isUnlocked
                ? 'text-green-400 hover:bg-green-500/10 hover:text-green-300'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-amber-400'
            }`}
          >
            {isUnlocked
              ? <Unlock className="w-4 h-4 shrink-0 transition-colors" />
              : <Lock className="w-4 h-4 shrink-0 transition-colors" />}
            <div className={`text-left overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'flex-1 opacity-100'}`}>
              <span className="block leading-tight truncate whitespace-nowrap">{isUnlocked ? 'Privacy unlocked' : 'Privacy locked'}</span>
              <span className="block text-[10px] opacity-60 leading-tight truncate whitespace-nowrap">
                {isUnlocked ? 'Names visible — tap to hide' : 'Names hidden — tap to reveal'}
              </span>
            </div>
          </button>
        </div>
      )}

      {/* User profile card + sign out */}
      <div className={`border-t border-sidebar-border pb-3 transition-all duration-300 ${isCollapsed ? 'px-2 pt-2' : 'px-3 pt-3'}`}>
        {/* Collapsed: just sign-out icon */}
        {isCollapsed ? (
          <button
            onClick={handleSignOut}
            title="Sign out"
            className="flex items-center justify-center p-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-destructive transition-all duration-300 w-full"
          >
            <LogOut className="w-4 h-4 shrink-0" />
          </button>
        ) : (
          <div className="space-y-1">
            {/* User row */}
            {employee && (
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg">
                <EmployeeAvatar
                  avatarUrl={(employee as any).avatar_url}
                  name={employee.cqid} // Fallback to CQID for initials
                  cqid={employee.cqid}
                  size={30}
                  rounded="full"
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <div className="text-sm font-medium text-sidebar-foreground truncate">
                    {employee.cqid || 'Employee'}
                  </div>
                  {role !== 'employee' && employee.name && (
                    <div className="text-[11px] text-muted-foreground truncate">{employee.name}</div>
                  )}
                </div>
              </div>
            )}

            {/* Change password */}
            <button
              onClick={() => setShowPwdModal(true)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-all duration-300 w-full text-left"
            >
              <KeyRound className="w-4 h-4 shrink-0" />
              <span className="truncate whitespace-nowrap">Change password</span>
            </button>

            {/* Sign out */}
            <button
              onClick={handleSignOut}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-destructive transition-all duration-300 w-full"
            >
              <LogOut className="w-4 h-4 shrink-0 transition-colors" />
              <span className="whitespace-nowrap">Sign out</span>
            </button>
          </div>
        )}
      </div>
      {showPwdModal && <ChangePasswordModal onClose={() => setShowPwdModal(false)} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────
export default function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const { role } = useRole()
  const pathname = usePathname()

  const isEmployee = role === 'employee'

  return (
    <>
      {/* ── Desktop sidebar (always visible ≥ 768px) ── */}
      <aside className={`hidden md:flex shrink-0 h-screen flex-col bg-sidebar border-r border-sidebar-border transition-all duration-300 ease-in-out relative ${isCollapsed ? 'w-[72px]' : 'w-60'}`}>
        {/* Toggle Button */}
        <button 
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="absolute -right-3 top-6 z-50 flex items-center justify-center w-6 h-6 bg-sidebar border border-sidebar-border rounded-full text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors shadow-sm"
        >
          {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>
        <SidebarContent isCollapsed={isCollapsed} />
      </aside>

      {/* ── Mobile: hamburger button (shown when sidebar is closed) ── */}
      {!mobileOpen && !isEmployee && (
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="md:hidden fixed top-4 left-4 z-50 w-9 h-9 flex items-center justify-center rounded-lg bg-sidebar border border-sidebar-border shadow-md text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* ── Mobile: backdrop ── */}
      {mobileOpen && !isEmployee && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Mobile: slide-out drawer ── */}
      {!isEmployee && (
        <aside
          className={`md:hidden fixed top-0 left-0 z-50 h-full w-72 bg-sidebar border-r border-sidebar-border shadow-2xl flex flex-col
            transition-transform duration-300 ease-in-out
            ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          {/* Close button inside drawer */}
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
            { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
            { href: '/dashboard/tasks', label: 'Tasks', icon: CheckSquare },
            { href: '/dashboard/contributions', label: 'Activity', icon: TrendingUp },
            { href: '/dashboard/settings', label: 'Settings', icon: Settings },
          ].map(item => {
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
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
        </div>
      )}
    </>
  )
}
