/**
 * Shared, code-defined catalogues consumed by the Workspace Manager UI and
 * (for widgets) the admin dashboard itself. Keeping these here means both
 * sides can never drift — the Manager can only offer keys the dashboard
 * actually understands.
 */

export const WORKSPACE_ICONS = [
  'LayoutGrid', 'Users2', 'Wallet', 'Megaphone', 'Briefcase', 'Building2',
  'Headphones', 'Palette', 'Truck', 'Factory', 'ShieldCheck', 'BarChart3',
  'CheckSquare', 'FileText', 'Handshake', 'Boxes', 'Wrench', 'Home',
] as const

export const WORKSPACE_COLORS = [
  'violet', 'blue', 'emerald', 'amber', 'rose', 'cyan', 'orange', 'pink', 'slate',
] as const

/** Named sections inside the admin dashboard that can be shown/hidden per workspace. */
export const DASHBOARD_WIDGET_KEYS: { key: string; label: string }[] = [
  { key: 'smart_focus',       label: 'Smart Focus (today\'s priorities)' },
  { key: 'followups',         label: 'Invoice Follow-ups' },
  { key: 'cash_overview',     label: 'Total Expected Cash' },
  { key: 'billing_stats',     label: 'Billed / Collected / Outstanding' },
  { key: 'contribution_stats',label: 'Contribution Analysis snapshot' },
  { key: 'client_ranking',    label: 'Client Ranking snapshot' },
  { key: 'advertising_stats', label: 'Advertising performance' },
  { key: 'recruitment_stats', label: 'Recruitment pipeline' },
  { key: 'payroll_stats',     label: 'Payroll status' },
]
