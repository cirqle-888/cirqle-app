'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { publishAdEvent } from '@/lib/advertising/events'
import { discoverAccountCampaigns } from '@/lib/advertising/discovery'
import { isCampaignType } from '@/lib/advertising/campaign-objective'
import type { SupabaseClient } from '@supabase/supabase-js'

type MapResult = { success: true; projectId: string } | { success: false; error: string }
type Ok = { success: true } | { success: false; error: string }

function mappingPath(accountId: string) {
  return `/dashboard/advertising/integrations/${accountId}/campaigns`
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function fetchMappingAccount(accountId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('ad_accounts')
    .select('id, name, account_id, provider, currency, is_active, client:clients ( name )')
    .eq('id', accountId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function fetchAccountCampaigns(
  accountId: string,
  filters?: { search?: string; mapping?: string; status?: string },
) {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()

  let q = admin
    .from('ad_campaigns')
    .select(`
      id, external_campaign_id, name, objective, status, mapping_status,
      client_id, project_id, campaign_type, last_seen_at, last_synced_at,
      client:clients ( name ),
      project:ad_projects ( id, campaign_name, sync_status, last_sync_at, last_sync_error )
    `)
    .eq('ad_account_id', accountId)
    .order('mapping_status', { ascending: true })
    .order('name', { ascending: true })

  if (filters?.mapping) q = q.eq('mapping_status', filters.mapping)
  if (filters?.status)  q = q.eq('status', filters.status)
  if (filters?.search)  q = q.ilike('name', `%${filters.search}%`)

  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

/** Projects for a client that can still be linked 1:1 (no campaign attached). */
export async function fetchLinkableProjects(clientId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('ad_projects')
    .select('id, campaign_name')
    .eq('client_id', clientId)
    .is('external_campaign_id', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

// ── Discovery (manual trigger) ────────────────────────────────────────────────

export async function discoverCampaigns(accountId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  const res = await discoverAccountCampaigns(admin, accountId, 'manual')
  revalidatePath(mappingPath(accountId))
  return res
}

// ── Map / unmap / ignore ──────────────────────────────────────────────────────

/**
 * Core mapping logic (no guard / no revalidate) so bulk can reuse it after a
 * single permission check. Creates or links a 1:1 ad_project for the campaign.
 */
async function mapCampaignCore(
  admin: SupabaseClient,
  employeeId: string,
  input: {
    campaignId: string
    clientId: string
    campaignType: string
    projectMode?: 'create' | 'existing'
    existingProjectId?: string
  },
): Promise<MapResult> {
  if (!input.clientId) return { success: false, error: 'Client is required' }

  const { data: camp, error: campErr } = await admin
    .from('ad_campaigns')
    .select('id, ad_account_id, provider, external_campaign_id, name, objective')
    .eq('id', input.campaignId)
    .maybeSingle()
  if (campErr || !camp) return { success: false, error: 'Campaign not found' }

  const campaignType = isCampaignType(input.campaignType) ? input.campaignType : null
  const providerMetadata = {
    campaign_id: camp.external_campaign_id,
    campaign_objective: camp.objective ?? null,
  }

  let projectId: string

  if (input.projectMode === 'existing') {
    if (!input.existingProjectId) return { success: false, error: 'Pick a project to link' }
    const { data: proj } = await admin
      .from('ad_projects')
      .select('id, external_campaign_id, provider_metadata')
      .eq('id', input.existingProjectId)
      .maybeSingle()
    if (!proj) return { success: false, error: 'Project not found' }
    // Enforce 1:1 — project must not already carry a different campaign.
    if (proj.external_campaign_id && proj.external_campaign_id !== camp.external_campaign_id) {
      return { success: false, error: 'That project is already linked to a different campaign' }
    }
    const { data: clash } = await admin
      .from('ad_campaigns')
      .select('id').eq('project_id', input.existingProjectId).neq('id', camp.id).maybeSingle()
    if (clash) return { success: false, error: 'That project is already mapped to another campaign' }

    const { error: updErr } = await admin.from('ad_projects').update({
      external_campaign_id: camp.external_campaign_id,
      ad_account_id:        camp.ad_account_id,
      client_id:            input.clientId,
      campaign_type:        campaignType,
      sync_enabled:         true,
      sync_status:          'queued',
      provider_metadata:    { ...(proj.provider_metadata ?? {}), ...providerMetadata },
    }).eq('id', input.existingProjectId)
    if (updErr) return { success: false, error: updErr.message }
    projectId = input.existingProjectId
  } else {
    const { data: created, error: insErr } = await admin.from('ad_projects').insert({
      campaign_name:        camp.name,
      client_id:            input.clientId,
      platform:             camp.provider,
      campaign_type:        campaignType,
      status:               'active',
      ad_budget_amount:     0,
      ad_account_id:        camp.ad_account_id,
      external_campaign_id: camp.external_campaign_id,
      sync_enabled:         true,
      sync_status:          'queued',
      provider_metadata:    providerMetadata,
    }).select('id').single()
    if (insErr || !created) return { success: false, error: insErr?.message || 'Failed to create project' }
    projectId = created.id

    // Automatically create a linked task for this new campaign
    const { createCampaignTask } = await import('../actions')
    await createCampaignTask(admin, {
      projectId: projectId,
      campaignName: camp.name,
      clientId: input.clientId,
      serviceId: null,
      serviceCharge: 0,
      currency: 'INR',
      employeeId,
    })
  }

  const { error: regErr } = await admin.from('ad_campaigns').update({
    mapping_status: 'mapped',
    client_id:      input.clientId,
    project_id:     projectId,
    campaign_type:  campaignType,
  }).eq('id', camp.id)
  if (regErr) return { success: false, error: regErr.message }

  const { enqueueJob } = await import('@/lib/jobs/engine')
  await enqueueJob({ job_type: 'advertising_sync_project', payload: { project_id: projectId }, priority: 'high' })
  await publishAdEvent('campaign_mapped', {
    projectId, employeeId,
    metadata: { campaign: camp.name, client_id: input.clientId, campaign_type: campaignType },
  })

  return { success: true, projectId }
}

export async function mapCampaign(input: {
  campaignId: string
  clientId: string
  campaignType: string
  projectMode?: 'create' | 'existing'
  existingProjectId?: string
}): Promise<MapResult> {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) return { success: false, error: guard.error }
  const admin = createAdminClient()
  const res = await mapCampaignCore(admin, guard.employeeId, input)
  if (res.success) {
    // accountId not in input; revalidate via the campaign's account.
    const { data } = await admin.from('ad_campaigns').select('ad_account_id').eq('id', input.campaignId).maybeSingle()
    if (data) revalidatePath(mappingPath(data.ad_account_id))
    revalidatePath('/dashboard/advertising')
  }
  return res
}

export async function bulkMapCampaigns(input: {
  campaignIds: string[]
  clientId: string
  campaignType: string
}): Promise<{ success: true; mapped: number; failed: number; errors: string[] } | { success: false; error: string }> {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) return { success: false, error: guard.error }
  if (!input.clientId) return { success: false, error: 'Client is required' }
  const admin = createAdminClient()

  let mapped = 0
  const errors: string[] = []
  let accountId: string | null = null
  for (const id of input.campaignIds) {
    const r = await mapCampaignCore(admin, guard.employeeId, {
      campaignId: id, clientId: input.clientId, campaignType: input.campaignType, projectMode: 'create',
    })
    if (r.success) mapped++
    else errors.push(r.error)
    if (!accountId) {
      const { data } = await admin.from('ad_campaigns').select('ad_account_id').eq('id', id).maybeSingle()
      accountId = data?.ad_account_id ?? null
    }
  }
  if (accountId) revalidatePath(mappingPath(accountId))
  revalidatePath('/dashboard/advertising')
  return { success: true, mapped, failed: input.campaignIds.length - mapped, errors }
}

export async function unmapCampaign(campaignId: string, opts?: { deleteProject?: boolean }): Promise<Ok> {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) return { success: false, error: guard.error }
  const admin = createAdminClient()

  const { data: camp } = await admin
    .from('ad_campaigns').select('id, ad_account_id, project_id, name').eq('id', campaignId).maybeSingle()
  if (!camp) return { success: false, error: 'Campaign not found' }

  if (camp.project_id) {
    const update = opts?.deleteProject
      ? { deleted_at: new Date().toISOString(), sync_enabled: false, sync_status: 'idle' }
      : { sync_enabled: false, sync_status: 'idle' }
    await admin.from('ad_projects').update(update).eq('id', camp.project_id)
    await publishAdEvent('campaign_unmapped', {
      projectId: camp.project_id, employeeId: guard.employeeId,
      metadata: { campaign: camp.name, deleted: !!opts?.deleteProject },
    })
  }

  await admin.from('ad_campaigns').update({
    mapping_status: 'unmapped', client_id: null, project_id: null, campaign_type: null,
  }).eq('id', camp.id)

  revalidatePath(mappingPath(camp.ad_account_id))
  revalidatePath('/dashboard/advertising')
  return { success: true }
}

export async function ignoreCampaign(campaignId: string, ignored: boolean): Promise<Ok> {
  const guard = await requirePermission(PERMS.ADVERTISING_MAP_CAMPAIGNS)
  if (!guard.ok) return { success: false, error: guard.error }
  const admin = createAdminClient()

  const { data: camp } = await admin
    .from('ad_campaigns').select('id, ad_account_id, mapping_status').eq('id', campaignId).maybeSingle()
  if (!camp) return { success: false, error: 'Campaign not found' }
  if (camp.mapping_status === 'mapped') {
    return { success: false, error: 'Unmap the campaign before ignoring it' }
  }

  await admin.from('ad_campaigns')
    .update({ mapping_status: ignored ? 'ignored' : 'unmapped' })
    .eq('id', camp.id)

  revalidatePath(mappingPath(camp.ad_account_id))
  return { success: true }
}
