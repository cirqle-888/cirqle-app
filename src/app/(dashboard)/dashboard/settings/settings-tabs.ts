/**
 * The Settings page's tabs: one list, read by both halves of the page.
 *
 * page.tsx (server) turns `?tab=` into the tab the page opens on, and
 * settings-client.tsx draws the tabs and writes `?tab=` back on every switch.
 * They used to keep a list each, and the server's lacked Message Templates,
 * WhatsApp Listener and Matching, so a link to one of those (or a refresh
 * while on one) opened Company instead.
 *
 * The ids key the render branches and the `?tab=` links people bookmark, so
 * they never change; what the rail shows is settings-client's TAB_LABEL.
 */
export const SETTINGS_TABS = [
  'Company', 'Employees', 'Services', 'Departments',
  'Groups & Params', 'Tools', 'Bank Accounts', 'Cash Categories', 'Exchange Rates',
  'Privacy & Security', 'Message Templates', 'WhatsApp Listener', 'Matching',
] as const

export type SettingsTab = typeof SETTINGS_TABS[number]

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'Company'

/** A tab's `?tab=` value: "WhatsApp Listener" → "whatsapp-listener". */
export function settingsTabParam(tab: string): string {
  return tab.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * The tab a `?tab=` value opens. Takes the value the page writes
 * ("bank-accounts") or a raw id in any case ("Bank Accounts"); anything
 * missing or unknown opens Company, so a stale link still lands on a page.
 */
export function resolveSettingsTab(param: string | string[] | null | undefined): SettingsTab {
  // Next hands a repeated `?tab=` over as an array.
  const raw = Array.isArray(param) ? param[0] : param
  if (!raw) return DEFAULT_SETTINGS_TAB
  const wanted = settingsTabParam(raw)
  return SETTINGS_TABS.find(t => settingsTabParam(t) === wanted) ?? DEFAULT_SETTINGS_TAB
}
