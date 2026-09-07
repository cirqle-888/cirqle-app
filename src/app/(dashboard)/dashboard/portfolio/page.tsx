import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { websiteSupabaseConfigured } from '@/lib/supabase/website-admin'
import { listPortfolio } from './actions'
import PortfolioClient from './portfolio-client'

export const dynamic = 'force-dynamic'

/**
 * Website Portfolio — manages the work published on cirqle.work.
 *
 * The content lives in the website's own Supabase project, not this app's, so
 * everything here goes through server actions holding that project's key.
 */
export default async function PortfolioPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (me && !(isAdmin || hasPermission(me, PERMS.PORTFOLIO_VIEW))) redirect('/dashboard')

  const configured = websiteSupabaseConfigured()
  const res = configured ? await listPortfolio() : null

  return (
    <PortfolioClient
      configured={configured}
      collections={res?.ok ? (res.data ?? []) : []}
      loadError={res && !res.ok ? (res.error ?? 'Could not load the portfolio.') : null}
      canManage={isAdmin || hasPermission(me, PERMS.PORTFOLIO_MANAGE)}
      siteUrl={process.env.NEXT_PUBLIC_WEBSITE_URL ?? 'https://cirqle.work'}
    />
  )
}
