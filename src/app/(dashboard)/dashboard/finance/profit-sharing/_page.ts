import 'server-only'
import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { createAdminClient } from '@/lib/supabase/server'
import { isInstalled } from '@/lib/profit-sharing/load'

/**
 * Every Profit Sharing page calls this first. The route middleware already
 * requires profit_sharing.view; this adds isAdmin (Admin only in this release)
 * so the page refuses even if the permission were granted to someone else.
 */
export async function requireProfitSharingPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me || !me.isAdmin || !hasPermission(me, PERMS.PROFIT_SHARING_VIEW)) redirect('/dashboard')
  const admin = createAdminClient()
  const installed = await isInstalled(admin)
  return { me, admin, installed }
}
