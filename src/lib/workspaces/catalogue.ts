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

/**
 * Named sections inside the ADMIN dashboard (dashboard-client.tsx) that can be
 * shown/hidden per workspace. Kept to the dashboard's real, already-isolated
 * top-level blocks — "analytics" covers the whole streamed KPIs/Production/
 * Pulse/bottom-grid area (dashboard-analytics.tsx) as one unit; it isn't
 * decomposed further to avoid deep surgery on that file in this pass.
 */
export const DASHBOARD_WIDGET_KEYS: { key: string; label: string }[] = [
  { key: 'smart_focus', label: 'Smart Focus (today\'s priorities)' },
  { key: 'followups',   label: 'Invoice Follow-ups widget' },
  { key: 'cash_overview', label: 'Total Expected Cash hero' },
  { key: 'analytics',   label: 'Analytics (KPIs, Production, Pulse, breakdowns)' },
]
