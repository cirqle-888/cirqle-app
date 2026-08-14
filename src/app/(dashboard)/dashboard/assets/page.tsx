import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadAllAssets } from '@/lib/assets/registry'
import AssetsClient from './assets-client'

export const dynamic = 'force-dynamic'

/**
 * Asset Assignment — every discovered Page, Instagram account, ad account and
 * lead form in one place, with the one question that matters: whose is it?
 *
 * Ships the raw rows and lets the client group them, so the same ownership
 * rule (@/lib/assets/ownership) decides what is shown here and what is shown
 * to a client. One rule, not two.
 */
export default async function AssetsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || hasPermission(me, PERMS.ASSETS_ASSIGN))) redirect('/dashboard')

  const admin = createAdminClient()
  const { assets, clients } = await loadAllAssets(admin)

  return (
    <AssetsClient
      assets={assets}
      clients={clients.filter(c => c.name)}
      canAssign={isAdmin || hasPermission(me, PERMS.ASSETS_ASSIGN)}
    />
  )
}
