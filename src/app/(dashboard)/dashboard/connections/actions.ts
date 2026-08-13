'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { publishAdEvent } from '@/lib/advertising/events'
import { getProvider } from '@/lib/advertising/providers'
import { decryptToken } from '@/lib/integrations/tokens'

export async function fetchProviderConnections(clientId?: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  let query = admin
    .from('provider_connections')
    .select(`
      id,
      provider,
      client_id,
      status,
      last_auth_at,
      token_expires_at,
      client:clients(name),
      ad_accounts(
        id,
        account_id,
        name,
        currency,
        timezone,
        is_active,
        business_id,
        ad_businesses(name)
      )
    `)
    .order('last_auth_at', { ascending: false })

  if (clientId) query = query.eq('client_id', clientId)

  const { data, error } = await query
  if (error) throw error
  return data
}

export async function fetchActiveClients() {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  
  const { data, error } = await admin
    .from('clients')
    .select('id, name')
    .eq('is_active', true)
    .order('name')
    
  if (error) throw error
  return data || []
}

export async function disconnectProvider(connectionId: string) {
  const me = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!me.ok) throw new Error(me.error)
  const admin = createAdminClient()
  
  const { data: conn } = await admin.from('provider_connections').select('client_id, provider').eq('id', connectionId).single()
  const { error } = await admin.from('provider_connections').delete().eq('id', connectionId)
  if (error) throw error

  if (conn) {
    await publishAdEvent('provider_disconnected', {
      employeeId: me.employeeId,
      metadata: { provider: conn.provider, client_id: conn.client_id }
    })
  }

  return { success: true }
}

export async function refreshAdAccounts(connectionId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  
  const { data: conn, error: connErr } = await admin.from('provider_connections').select('id,client_id,provider,access_token').eq('id', connectionId).single()
  if (connErr || !conn) throw new Error('Connection not found')
  const accessToken = decryptToken(conn.access_token)
  if (!accessToken) throw new Error('Missing access token')

  try {
    const provider = getProvider(conn.provider)
    const accounts = await provider.getAccounts(connectionId, accessToken)

    for (const acc of accounts) {
      if (acc.business_id) {
        await admin.from('ad_businesses').upsert({
          connection_id: connectionId,
          client_id: conn.client_id,
          business_id: acc.business_id,
          name: `Business ${acc.business_id}`,
        }, { onConflict: 'connection_id,business_id' })
      }

      // unique constraint is on (provider, account_id) — not connection_id
      await admin.from('ad_accounts').upsert({
        connection_id: connectionId,
        client_id: conn.client_id,
        provider: conn.provider,
        account_id: acc.account_id,
        name: acc.name,
        currency: acc.currency,
        timezone: acc.timezone,
        is_active: true,
      }, { onConflict: 'provider,account_id' })
    }
    return { success: true, count: accounts.length }
  } catch (err: any) {
    throw new Error(err.message || 'Failed to refresh')
  }
}

export async function createAdProject(payload: {
  campaign_name: string;
  client_id: string;
  ad_account_id: string;
  currency: string;
  timezone: string;
  sync_enabled: boolean;
  sync_frequency: string;
  ai_enabled: boolean;
  forecast_enabled: boolean;
}) {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()

  // 1. Verify ad_account exists and is linked to the client
  const { data: account, error: accErr } = await admin
    .from('ad_accounts')
    .select('connection_id, provider, client_id')
    .eq('id', payload.ad_account_id)
    .single()

  if (accErr || !account) throw new Error('Invalid Ad Account')
  
  // Check for an existing sync project for this ad account
  const { data: existing } = await admin
    .from('ad_projects')
    .select('id')
    .eq('ad_account_id', payload.ad_account_id)
    .maybeSingle()

  if (existing) {
    // Project already created (e.g. prior attempt failed mid-way) —
    // just enqueue a fresh sync job and return the existing project.
    if (payload.sync_enabled) {
      const { enqueueJob } = await import('@/lib/jobs/engine')
      await enqueueJob({
        job_type: 'advertising_sync_project',
        payload: { project_id: existing.id },
        priority: 'high'
      })
      await admin
        .from('ad_projects')
        .update({ sync_status: 'queued' })
        .eq('id', existing.id)
    }
    return { success: true, project_id: existing.id }
  }

  // 2. Create the ad_project
  const { data: project, error: projErr } = await admin
    .from('ad_projects')
    .insert({
      campaign_name: payload.campaign_name,
      client_id: payload.client_id,
      platform: account.provider,
      status: 'active',
      ad_budget_amount: 0,
      ad_budget_currency: payload.currency,
      ad_account_id: payload.ad_account_id,
      sync_enabled: payload.sync_enabled,
      sync_status: payload.sync_enabled ? 'queued' : 'idle',
      provider_metadata: {
        timezone: payload.timezone,
        sync_frequency: payload.sync_frequency,
        ai_enabled: payload.ai_enabled,
        forecast_enabled: payload.forecast_enabled
      }
    })
    .select('id')
    .single()

  if (projErr || !project) throw new Error(projErr?.message || 'Failed to create project')

  // 3. Enqueue the first synchronization job if enabled
  if (payload.sync_enabled) {
    const { enqueueJob } = await import('@/lib/jobs/engine')
    await enqueueJob({
      job_type: 'advertising_sync_project',
      payload: { project_id: project.id },
      priority: 'high'
    })
  }

  return { success: true, project_id: project.id }
}

export async function fetchSyncStatus(clientId?: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  
  let query = admin
    .from('ad_projects')
    .select(`
      id,
      campaign_name,
      sync_enabled,
      sync_status,
      last_sync_at,
      last_sync_error,
      ad_account:ad_accounts(name, provider)
    `)
    .not('ad_account_id', 'is', null)
    
  if (clientId) query = query.eq('client_id', clientId)
  
  const { data, error } = await query
  if (error) throw error
  return data
}

export async function triggerManualSync(projectId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  
  await admin.from('ad_projects').update({ sync_status: 'queued' }).eq('id', projectId)

  const { enqueueJob } = await import('@/lib/jobs/engine')
  await enqueueJob({
    job_type: 'advertising_sync_project',
    payload: { project_id: projectId },
    priority: 'high'
  })

  // Run inline so the sync completes now rather than waiting for the daily cron.
  try {
    const { processJobs } = await import('@/lib/jobs/worker')
    await processJobs(crypto.randomUUID(), 25000)
  } catch (err) {
    console.error('[triggerManualSync] inline processing failed; job stays queued for cron', err)
  }
  return { success: true }
}

export async function toggleSyncStatus(projectId: string, enabled: boolean) {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_PROVIDERS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  
  await admin.from('ad_projects').update({ 
    sync_enabled: enabled,
    sync_status: enabled ? 'idle' : 'paused'
  }).eq('id', projectId)
  return { success: true }
}
