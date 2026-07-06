/**
 * Sidebar nav definition — shared source of truth so the sidebar itself and
 * the icon-grid app launcher (src/components/layout/app-launcher.tsx) render
 * the exact same destinations/permissions from one place.
 */
import {
  LayoutDashboard, CheckSquare, Users2, FileText, BookOpen, Wallet, BarChart3, Sheet,
  Settings, TrendingUp, Upload, Inbox, PhoneCall, Award, Activity, Blocks, Megaphone, Handshake,
  SlidersHorizontal, MessageSquare, ClipboardCheck,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = { label: string; href: string; icon: LucideIcon; requiredPerm?: string; adminOnly?: boolean }
export type NavSection = { label?: string; items: NavItem[] }

export const navSections: NavSection[] = [
  {
    items: [
      { label: 'Dashboard',     href: '/dashboard',               icon: LayoutDashboard, requiredPerm: 'dashboard.view' },
      { label: 'Requests',      href: '/dashboard/requests',      icon: Inbox, requiredPerm: 'requests.view' },
      { label: 'Tasks',         href: '/dashboard/tasks',         icon: CheckSquare },
      { label: 'Chat',          href: '/dashboard/chat',          icon: MessageSquare, requiredPerm: 'chat.access' },
      { label: 'Approvals',     href: '/dashboard/approvals',     icon: ClipboardCheck },
      { label: 'Contributions', href: '/dashboard/contributions', icon: TrendingUp },
    ],
  },
  {
    label: 'Money',
    items: [
      { label: 'Quotations',  href: '/dashboard/quotations', icon: BookOpen, requiredPerm: 'billing.view_quotations' },
      { label: 'Invoices',    href: '/dashboard/invoices',   icon: FileText, requiredPerm: 'billing.view_invoices' },
      { label: 'Follow-ups',  href: '/dashboard/invoices/follow-ups', icon: PhoneCall, requiredPerm: 'billing.view_invoices' },
      { label: 'Cash Book',   href: '/dashboard/cashbook',   icon: Wallet,   requiredPerm: 'cashbook.view' },
      { label: 'Business Partners', href: '/dashboard/partners', icon: Handshake, requiredPerm: 'finance.partner.view' },
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
      // Contribution Analysis: spreadsheet-style per-task profitability / earnings
      // BI report. Same reports.view gate. Lives under Insights, NOT Settings.
      { label: 'Contribution Analysis', href: '/dashboard/reports/contribution-analysis', icon: Sheet, requiredPerm: 'reports.view' },
      // Client Ranking: payment reliability + business value scoring per client.
      { label: 'Client Ranking', href: '/dashboard/clients/ranking', icon: Award, requiredPerm: 'reports.view' },
      // Business Health Center: cash/collections, overdue aging, client risk
      // (reuses Client Ranking's scoring), and whether the scheduled crons
      // are actually running. Same reports.view gate.
      { label: 'Business Health', href: '/dashboard/health', icon: Activity, requiredPerm: 'reports.view' },
      // What-If Planner: simulate increments / commission / pricing / draft
      // agreements over a completed period, then apply via review + snapshot.
      { label: 'What-If Planner', href: '/dashboard/reports/what-if', icon: SlidersHorizontal, requiredPerm: 'reports.view' },
      // Universal activity timeline — everything happening across the workspace.
      // Gated by timeline.view_all (seeded in migration 014).
      { label: 'Activity', href: '/dashboard/activity', icon: Activity, requiredPerm: 'timeline.view_all' },
    ],
  },
  {
    label: 'Apps',
    items: [
      { label: 'Advertising',    href: '/dashboard/advertising', icon: Megaphone, requiredPerm: 'advertising.view' },
      { label: 'Apps Directory', href: '/dashboard/apps',        icon: Blocks },
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
