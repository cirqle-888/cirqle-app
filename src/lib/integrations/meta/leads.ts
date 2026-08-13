/**
 * Meta Lead Ads — retrieval, normalization into the Cirqle CRM, dedup and
 * configurable automation (spec §9–§11).
 *
 * Two ingestion paths, both idempotent on leads_external_uniq:
 *   1. Webhook (real-time): page `leadgen` field → processLeadgenEvent()
 *   2. Backfill polling:    syncLeadForms() + backfillFormLeads() — Meta only
 *      retains leads for 90 days, so the daily sync keeps history in Cirqle.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { metaGraph, metaGraphAll, redactTokens } from './client'
import { decryptToken } from '@/lib/integrations/tokens'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import { logActivity } from '@/lib/activity/log'

// ── Field normalization ──────────────────────────────────────────────────────

export interface NormalizedLeadFields {
  fullName: string | null
  email: string | null
  phone: string | null
  raw: Record<string, string>
}

const NAME_KEYS = ['full_name', 'name', 'first_name']
const EMAIL_KEYS = ['email', 'work_email', 'e-mail']
const PHONE_KEYS = ['phone_number', 'phone', 'mobile_number', 'whatsapp_number', 'contact_number']

/**
 * Meta returns lead answers as field_data: [{ name, values: [..] }].
 * Pure function (unit-tested): extracts the common identity fields and keeps
 * everything verbatim in `raw`.
 */
export function normalizeLeadFields(
  fieldData: Array<{ name?: string; values?: string[] }> | null | undefined,
): NormalizedLeadFields {
  const raw: Record<string, string> = {}
  let fullName: string | null = null
  let firstName: string | null = null
  let lastName: string | null = null
  let email: string | null = null
  let phone: string | null = null

  for (const field of fieldData ?? []) {
    const key = (field.name ?? '').toLowerCase().trim()
    const value = (field.values ?? []).filter(Boolean).join(', ').trim()
    if (!key || !value) continue
    raw[key] = value

    if (!fullName && NAME_KEYS.includes(key) && key !== 'first_name') fullName = value
    if (key === 'first_name') firstName = value
    if (key === 'last_name') lastName = value
    if (!email && EMAIL_KEYS.includes(key)) email = value
    if (!phone && PHONE_KEYS.includes(key)) phone = value
  }

  if (!fullName && (firstName || lastName)) {
    fullName = [firstName, lastName].filter(Boolean).join(' ')
  }
  return { fullName, email, phone, raw }
}

// ── Token resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the best token for a Page: the stored (non-expiring) Page token,
 * falling back to the connection's user token. Returns null when neither
 * exists — caller marks the account needs_reauth.
 */
async function resolvePageToken(
  admin: SupabaseClient,
  pageExternalId: string,
): Promise<{ token: string; account: any } | null> {
  const { data: account } = await admin
    .from('social_accounts')
    .select('id, client_id, external_id, access_token, connection_id, status')
    .eq('platform', 'facebook_page')
    .eq('external_id', pageExternalId)
    .maybeSingle()
  if (!account) return null

  const pageToken = decryptToken(account.access_token)
  if (pageToken) return { token: pageToken, account }

  if (account.connection_id) {
    const { data: conn } = await admin
      .from('provider_connections')
      .select('access_token, status')
      .eq('id', account.connection_id)
      .maybeSingle()
    const userToken = decryptToken(conn?.access_token)
    if (userToken && conn?.status === 'active') return { token: userToken, account }
  }
  return null
}

// ── Lead retrieval + storage ─────────────────────────────────────────────────

export interface StoreLeadResult {
  ok: boolean
  created: boolean
  duplicate: boolean
  leadId?: string
  error?: string
}

/**
 * Fetch one lead by leadgen id and store it. Idempotent: a second call with
 * the same leadgen id is a no-op (unique index on (source, external_lead_id)).
 */
export async function retrieveAndStoreLead(
  admin: SupabaseClient,
  leadgenId: string,
  pageExternalId: string,
  opts: { formId?: string; adId?: string } = {},
): Promise<StoreLeadResult> {
  const resolved = await resolvePageToken(admin, pageExternalId)
  if (!resolved) {
    return { ok: false, created: false, duplicate: false, error: `No token for page ${pageExternalId}` }
  }
  const { token, account } = resolved

  let leadData: any
  try {
    leadData = await metaGraph(`${leadgenId}`, {
      token,
      params: {
        fields:
          'id,created_time,field_data,form_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,is_organic',
      },
    })
  } catch (err: any) {
    return { ok: false, created: false, duplicate: false, error: redactTokens(err?.message) }
  }

  return storeMetaLead(admin, leadData, { account, pageExternalId, formIdFallback: opts.formId })
}

/**
 * Persist a raw Meta lead object as a Cirqle CRM lead + run automations.
 * Shared by the webhook path and the backfill path.
 */
export async function storeMetaLead(
  admin: SupabaseClient,
  leadData: any,
  ctx: { account: any; pageExternalId: string; formIdFallback?: string; formName?: string },
): Promise<StoreLeadResult> {
  const normalized = normalizeLeadFields(leadData?.field_data)
  const formId = leadData?.form_id ?? ctx.formIdFallback ?? null

  // Look up a friendlier form name if we synced the form registry.
  let formName: string | null = ctx.formName ?? null
  if (!formName && formId) {
    const { data: form } = await admin
      .from('lead_forms')
      .select('name')
      .eq('external_form_id', formId)
      .maybeSingle()
    formName = form?.name ?? null
  }

  const row = {
    client_id: ctx.account.client_id,
    source: 'meta_lead_ad',
    external_lead_id: leadData?.id,
    status: 'new',
    full_name: normalized.fullName,
    email: normalized.email,
    phone: normalized.phone,
    raw_fields: normalized.raw,
    form_external_id: formId,
    form_name: formName,
    page_external_id: ctx.pageExternalId,
    campaign_external_id: leadData?.campaign_id ?? null,
    campaign_name: leadData?.campaign_name ?? null,
    adset_external_id: leadData?.adset_id ?? null,
    adset_name: leadData?.adset_name ?? null,
    ad_external_id: leadData?.ad_id ?? null,
    ad_name: leadData?.ad_name ?? null,
    social_account_id: ctx.account.id,
    submitted_at: leadData?.created_time ?? null,
  }

  const { data: inserted, error } = await admin.from('leads').insert(row).select('id').single()

  if (error) {
    // 23505 = unique violation → the lead already exists. Treat as success.
    if ((error as { code?: string }).code === '23505') {
      return { ok: true, created: false, duplicate: true }
    }
    return { ok: false, created: false, duplicate: false, error: error.message }
  }

  void logActivity({
    entityType: 'client',
    entityId: ctx.account.client_id,
    action: 'created',
    category: 'crm',
    clientId: ctx.account.client_id,
    detail: [{ field: 'meta_lead', from: null, to: leadData?.id }],
  })

  // Automations + notifications are best-effort — a failure must never lose the lead.
  try {
    await runLeadAutomations(admin, { ...row, id: inserted.id }, 'lead_created')
  } catch (err) {
    console.warn('[storeMetaLead] automation failed:', err)
  }

  return { ok: true, created: true, duplicate: false, leadId: inserted.id }
}

// ── Form registry + 90-day backfill ─────────────────────────────────────────

export async function syncLeadForms(admin: SupabaseClient, accountRowId: string): Promise<number> {
  const { data: account } = await admin
    .from('social_accounts')
    .select('id, client_id, external_id, access_token, connection_id')
    .eq('id', accountRowId)
    .maybeSingle()
  if (!account) return 0
  const resolved = await resolvePageToken(admin, account.external_id)
  if (!resolved) return 0

  const forms = await metaGraphAll<any>(`${account.external_id}/leadgen_forms`, {
    token: resolved.token,
    params: { fields: 'id,name,status,questions,leads_count', limit: 50 },
  })

  let count = 0
  for (const form of forms) {
    const { error } = await admin.from('lead_forms').upsert(
      {
        social_account_id: account.id,
        client_id: account.client_id,
        external_form_id: form.id,
        name: form.name ?? null,
        status: form.status ?? null,
        questions: form.questions ?? null,
        leads_count: form.leads_count ?? null,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: 'external_form_id' },
    )
    if (!error) count++
  }
  return count
}

/**
 * Poll all leads for one form since `sinceIso` (defaults to 3 days back; Meta
 * retains a max of 90 days). Dedup makes overlapping windows safe.
 */
export async function backfillFormLeads(
  admin: SupabaseClient,
  accountRowId: string,
  externalFormId: string,
  sinceIso?: string,
): Promise<{ fetched: number; created: number }> {
  const { data: account } = await admin
    .from('social_accounts')
    .select('id, client_id, external_id, access_token, connection_id')
    .eq('id', accountRowId)
    .maybeSingle()
  if (!account) return { fetched: 0, created: 0 }
  const resolved = await resolvePageToken(admin, account.external_id)
  if (!resolved) return { fetched: 0, created: 0 }

  const since = Math.floor(
    (sinceIso ? new Date(sinceIso).getTime() : Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000,
  )

  const rows = await metaGraphAll<any>(`${externalFormId}/leads`, {
    token: resolved.token,
    params: {
      fields: 'id,created_time,field_data,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name',
      filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: since }],
      limit: 100,
    },
    maxPages: 20,
  })

  let created = 0
  for (const lead of rows) {
    const result = await storeMetaLead(admin, { ...lead, form_id: externalFormId }, {
      account,
      pageExternalId: account.external_id,
      formIdFallback: externalFormId,
    })
    if (result.created) created++
  }
  return { fetched: rows.length, created }
}

// ── Automation rules (configurable — spec §11) ───────────────────────────────

type LeadTrigger = 'lead_created' | 'lead_status_changed' | 'lead_uncontacted'

export async function runLeadAutomations(
  admin: SupabaseClient,
  lead: any,
  trigger: LeadTrigger,
  context: { newStatus?: string } = {},
): Promise<void> {
  const { data: rules } = await admin
    .from('lead_automation_rules')
    .select('*')
    .eq('trigger', trigger)
    .eq('is_active', true)
    .order('display_order')

  const applicable = (rules ?? []).filter(
    (r) => !r.client_id || r.client_id === lead.client_id,
  )

  // Built-in default: no rules at all → still notify admins about new Meta leads.
  if (trigger === 'lead_created' && applicable.length === 0) {
    await notifyAdmins({
      type: 'meta_lead_received',
      title: 'New Meta lead',
      message: `${lead.full_name || 'A new lead'}${lead.campaign_name ? ` · ${lead.campaign_name}` : ''}`,
      link: '/dashboard/leads',
      sourceKey: `meta_lead:${lead.external_lead_id ?? lead.id}`,
    }).catch(() => {})
    return
  }

  for (const rule of applicable) {
    // Condition check
    if (trigger === 'lead_status_changed') {
      const wanted = rule.condition?.status
      if (wanted && wanted !== context.newStatus) continue
    }

    try {
      switch (rule.action) {
        case 'assign_employee': {
          const employeeId = rule.action_config?.employee_id
          if (employeeId && !lead.assigned_to) {
            await admin.from('leads').update({ assigned_to: employeeId }).eq('id', lead.id)
            lead.assigned_to = employeeId
            await createNotification({
              employeeId,
              type: 'meta_lead_received',
              title: 'Lead assigned to you',
              message: `${lead.full_name || 'New lead'}${lead.campaign_name ? ` · ${lead.campaign_name}` : ''}`,
              link: '/dashboard/leads',
              sourceKey: `lead_assign:${lead.id}`,
            })
          }
          break
        }
        case 'create_task_request': {
          await admin.from('task_requests').insert({
            source: 'manual',
            client_id: lead.client_id,
            title: rule.action_config?.title || `Follow up lead: ${lead.full_name || lead.email || lead.phone || 'Meta lead'}`,
            description: `Auto-created by lead automation.\nLead: ${lead.full_name ?? '—'} · ${lead.email ?? '—'} · ${lead.phone ?? '—'}${lead.campaign_name ? `\nCampaign: ${lead.campaign_name}` : ''}`,
            priority: rule.action_config?.priority || 'high',
            assigned_employee_id: rule.action_config?.employee_id ?? lead.assigned_to ?? null,
            status: 'submitted',
          })
          break
        }
        case 'notify_employees': {
          const ids: string[] = rule.action_config?.employee_ids ?? []
          for (const employeeId of ids) {
            await createNotification({
              employeeId,
              type: 'meta_lead_received',
              title: 'New Meta lead',
              message: `${lead.full_name || 'A new lead'}${lead.campaign_name ? ` · ${lead.campaign_name}` : ''}`,
              link: '/dashboard/leads',
              sourceKey: `meta_lead:${lead.external_lead_id ?? lead.id}`,
            })
          }
          break
        }
        case 'notify_admins': {
          await notifyAdmins({
            type: 'meta_lead_received',
            title: 'New Meta lead',
            message: `${lead.full_name || 'A new lead'}${lead.campaign_name ? ` · ${lead.campaign_name}` : ''}`,
            link: '/dashboard/leads',
            sourceKey: `meta_lead:${lead.external_lead_id ?? lead.id}`,
          })
          break
        }
      }
    } catch (err) {
      console.warn(`[runLeadAutomations] rule ${rule.id} (${rule.action}) failed:`, err)
    }
  }
}
