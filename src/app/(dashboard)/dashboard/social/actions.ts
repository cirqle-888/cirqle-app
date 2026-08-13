'use server'

/**
 * Social Hub landing — server actions.
 *
 * Same shape as every other action file in the codebase:
 *   requirePermission → guard.ok check → createAdminClient() mutation →
 *   void logActivity(...) → revalidatePath → { ok, error?, data? }.
 *
 * SECURITY: social_accounts.access_token is NEVER selected into anything
 * returned to the browser.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import { syncSocialAccount } from '@/lib/integrations/meta/insights'
import { discoverSocialAccounts } from '@/lib/integrations/meta/accounts'
import { decryptToken } from '@/lib/integrations/tokens'

const REVALIDATE = '/dashboard/social'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** Columns safe to read for logging/scoping — never the token. */
const ACCOUNT_META = 'id, client_id, platform, name, status'

// ── Sync now ─────────────────────────────────────────────────────────────────

export async function syncAccountNow(
  accountId: string,
): Promise<ActionResult<{ dailyRows: number; mediaItems: number; errors: string[] }>> {
  const guard = await requirePermission(PERMS.SOCIAL_VIEW_INSIGHTS)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from('social_accounts').select(ACCOUNT_META).eq('id', accountId).maybeSingle()
  if (!account) return { ok: false, error: 'Account not found.' }

  const result = await syncSocialAccount(admin, accountId)

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: account.client_id,
    clientId: account.client_id,
    category: 'crm',
    action: 'social_account_synced',
    detail: {
      account: account.name, platform: account.platform,
      dailyRows: result.dailyRows, mediaItems: result.mediaItems,
      errors: result.errors.slice(0, 3),
    },
  })

  revalidatePath(REVALIDATE)
  revalidatePath(`/dashboard/social/accounts/${accountId}`)

  if (!result.ok && result.errors.length > 0) {
    return {
      ok: false,
      error: result.errors[0],
      data: { dailyRows: result.dailyRows, mediaItems: result.mediaItems, errors: result.errors },
    }
  }
  return {
    ok: true,
    data: { dailyRows: result.dailyRows, mediaItems: result.mediaItems, errors: result.errors },
  }
}

// ── Toggle publishing / insights flags ───────────────────────────────────────

export async function toggleAccountFlag(
  accountId: string,
  field: 'publishing_enabled' | 'insights_enabled',
  value: boolean,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_CONNECT)
  if (!guard.ok) return { ok: false, error: guard.error }

  // Whitelist — never let arbitrary column names through to the update.
  if (field !== 'publishing_enabled' && field !== 'insights_enabled') {
    return { ok: false, error: 'Invalid field.' }
  }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from('social_accounts').select(ACCOUNT_META).eq('id', accountId).maybeSingle()
  if (!account) return { ok: false, error: 'Account not found.' }

  const { error } = await admin
    .from('social_accounts')
    .update({ [field]: value })
    .eq('id', accountId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: account.client_id,
    clientId: account.client_id,
    category: 'crm',
    action: 'social_account_updated',
    detail: [{ field, from: !value, to: value, account: account.name }],
  })

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Disconnect ───────────────────────────────────────────────────────────────

export async function disconnectSocialAccount(accountId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_CONNECT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from('social_accounts').select(ACCOUNT_META).eq('id', accountId).maybeSingle()
  if (!account) return { ok: false, error: 'Account not found.' }

  const { error } = await admin
    .from('social_accounts')
    .update({ status: 'disconnected' })
    .eq('id', accountId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: account.client_id,
    clientId: account.client_id,
    category: 'crm',
    action: 'social_account_disconnected',
    detail: { account: account.name, platform: account.platform },
  })

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Refresh accounts from Meta (re-discovery) ────────────────────────────────

export async function refreshSocialAccountsForConnection(
  connectionId: string,
): Promise<ActionResult<{ pages: number; instagramAccounts: number; errors: string[] }>> {
  const guard = await requirePermission(PERMS.SOCIAL_CONNECT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: conn } = await admin
    .from('provider_connections')
    .select('id, client_id, provider, access_token')
    .eq('id', connectionId)
    .maybeSingle()
  if (!conn) return { ok: false, error: 'Connection not found.' }

  let userToken: string | null = null
  try {
    userToken = decryptToken(conn.access_token)
  } catch {
    return { ok: false, error: 'Stored token could not be decrypted — reconnect Meta.' }
  }
  if (!userToken) return { ok: false, error: 'Connection has no access token — reconnect Meta.' }

  const result = await discoverSocialAccounts(admin, conn.id, conn.client_id, userToken)

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: conn.client_id,
    clientId: conn.client_id,
    category: 'crm',
    action: 'social_accounts_refreshed',
    detail: {
      pages: result.pages,
      instagramAccounts: result.instagramAccounts,
      errors: result.errors.slice(0, 3),
    },
  })

  revalidatePath(REVALIDATE)

  if (result.errors.length > 0 && result.pages === 0 && result.instagramAccounts === 0) {
    return { ok: false, error: result.errors[0], data: result }
  }
  return { ok: true, data: result }
}
