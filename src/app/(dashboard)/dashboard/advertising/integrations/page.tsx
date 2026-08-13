import { redirect } from 'next/navigation'

/**
 * Integrations moved out of Advertising: the Meta connection feeds Social Hub,
 * Leads and Agency just as much as ads, so it lives at /dashboard/connections
 * now. This stub keeps every old link and bookmark working.
 */
export default function LegacyIntegrationsRedirect() {
  redirect('/dashboard/connections')
}
