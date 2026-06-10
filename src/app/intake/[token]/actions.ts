'use server'

/**
 * PUBLIC intake actions — no auth. Every action takes the share-link token and
 * resolves/scopes it server-side. These actions can ONLY:
 *   (a) insert a task_requests row for the token's client/agency,
 *   (b) update external fields of the token's OWN requests,
 *   (c) read external-safe fields + external-visible timeline of own requests.
 * No internal data (notes, assignments, pricing, other tenants) is ever selected.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logRequestActivity, bumpExternalActivity, type Visibility } from '@/lib/requests/core'
import { notifyNewRequest } from '@/lib/requests/notify'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

/** External-safe columns — the ONLY request fields the public side ever reads. */
const EXTERNAL_COLS =
  'id, ref_no, track_token, title, description, remarks, design_plan, priority, due_date, is_planned, ' +
  'client_status, content_link, reference_link, deliverables_link, drive_folder_link, extra_links, created_at'

// ─── Token resolution ─────────────────────────────────────────────────────────

interface ResolvedLink {
  linkId: string
  type: 'client' | 'agency' | 'generic'
  clientId: string | null
  agencyId: string | null
  requesterLabel: string
  visibility: Visibility
}

async function resolveToken(token: string): Promise<ResolvedLink | null> {
  if (!token || token.length < 16) return null
  try {
    const admin = createAdminClient()
    const { data: link } = await admin
      .from('intake_links')
      .select('id, type, client_id, agency_id, is_active, expires_at, client:clients(name), agency:agencies(name)')
      .eq('token', token)
      .maybeSingle()
    if (!link || !link.is_active) return null
    if (link.expires_at && new Date(link.expires_at) < new Date()) return null

    void admin.from('intake_links').update({ last_used_at: new Date().toISOString() }).eq('id', link.id).then(undefined, () => {})

    const clientName = (link as any).client?.name as string | undefined
    const agencyName = (link as any).agency?.name as string | undefined
    return {
      linkId: link.id,
      type: link.type,
      clientId: link.client_id,
      agencyId: link.agency_id,
      requesterLabel: clientName || agencyName || 'Guest',
      visibility: link.type === 'agency' ? 'agency' : 'client',
    }
  } catch { return null }
}

/** A request belongs to this token when tenant ids match (or generic: same link). */
function ownershipFilter(q: any, link: ResolvedLink) {
  if (link.type === 'client') return q.eq('client_id', link.clientId)
  if (link.type === 'agency') return q.eq('agency_id', link.agencyId)
  return q.eq('link_id', link.linkId)
}

// ─── Submit ───────────────────────────────────────────────────────────────────

export interface IntakeSubmitInput {
  title: string
  description?: string
  remarks?: string
  design_plan?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  due_date?: string | null
  is_planned?: boolean
  content_link?: string
  reference_link?: string
  extra_links?: { label: string; url: string }[]
  service_id?: string | null
  submitter_name?: string
  submitter_email?: string
  submitter_phone?: string
  /** Honeypot — must stay empty. Bots fill it; humans never see it. */
  website?: string
}

export async function submitIntakeRequest(
  token: string,
  input: IntakeSubmitInput,
): Promise<ActionResult<{ ref: string; trackToken: string }>> {
  if (input.website) return { ok: true, data: { ref: 'REQ-0000', trackToken: '' } } // silently drop bots
  const link = await resolveToken(token)
  if (!link) return { ok: false, error: 'This link is no longer valid.' }

  const title = (input.title || '').trim()
  if (!title) return { ok: false, error: 'Title is required.' }
  if (title.length > 300) return { ok: false, error: 'Title is too long.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('task_requests').insert({
    link_id: link.linkId,
    source: link.type,
    client_id: link.clientId,
    agency_id: link.agencyId,
    submitter_name: input.submitter_name?.trim() || null,
    submitter_email: input.submitter_email?.trim() || null,
    submitter_phone: input.submitter_phone?.trim() || null,
    title,
    description: input.description?.trim() || null,
    remarks: input.remarks?.trim() || null,
    design_plan: input.design_plan?.trim() || null,
    priority: input.priority || 'normal',
    due_date: input.due_date || null,
    is_planned: !!input.is_planned,
    content_link: input.content_link?.trim() || null,
    reference_link: input.reference_link?.trim() || null,
    extra_links: (input.extra_links || []).filter(l => l.url?.trim()).slice(0, 10),
    service_id: input.service_id || null,
  }).select('id, ref_no, track_token, title, source').single()
  if (error) return { ok: false, error: 'Could not submit the request. Please try again.' }

  const actorLabel = input.submitter_name?.trim() || link.requesterLabel
  await logRequestActivity(admin, {
    requestId: data.id,
    actorType: link.type === 'agency' ? 'agency' : 'client',
    actorLabel,
    action: 'submitted',
    visibility: link.visibility,
    detail: { title },
  })

  void notifyNewRequest(data as any, actorLabel)

  return { ok: true, data: { ref: `REQ-${String(data.ref_no).padStart(4, '0')}`, trackToken: data.track_token } }
}

// ─── Track list + timeline ────────────────────────────────────────────────────

export async function getMyRequests(token: string): Promise<ActionResult<{ rows: any[] }>> {
  const link = await resolveToken(token)
  if (!link) return { ok: false, error: 'This link is no longer valid.' }
  const admin = createAdminClient()
  const { data, error } = await ownershipFilter(
    admin.from('task_requests').select(EXTERNAL_COLS), link,
  ).order('created_at', { ascending: false }).limit(100)
  if (error) return { ok: false, error: 'Could not load requests.' }
  return { ok: true, data: { rows: data || [] } }
}

export async function getExternalTimeline(token: string, requestId: string): Promise<ActionResult<{ rows: any[] }>> {
  const link = await resolveToken(token)
  if (!link) return { ok: false, error: 'This link is no longer valid.' }
  const admin = createAdminClient()

  // Ownership check first — never leak another tenant's timeline.
  const { data: own } = await ownershipFilter(
    admin.from('task_requests').select('id'), link,
  ).eq('id', requestId).maybeSingle()
  if (!own) return { ok: false, error: 'Not found.' }

  const { data, error } = await admin
    .from('request_activity')
    .select('id, actor_type, actor_label, action, detail, created_at')
    .eq('request_id', requestId)
    .eq('visibility', link.visibility)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return { ok: false, error: 'Could not load activity.' }
  return { ok: true, data: { rows: data || [] } }
}

// ─── External edits (each one logs activity + bumps the indicator) ────────────

async function ownRequest(link: ResolvedLink, requestId: string) {
  const admin = createAdminClient()
  const { data } = await ownershipFilter(
    admin.from('task_requests').select('id, status'), link,
  ).eq('id', requestId).maybeSingle()
  return data ? { admin, request: data } : null
}

export async function addRequestLink(
  token: string, requestId: string, label: string, url: string,
): Promise<ActionResult> {
  const link = await resolveToken(token)
  if (!link) return { ok: false, error: 'This link is no longer valid.' }
  const u = (url || '').trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Enter a valid link (https://…).' }
  const own = await ownRequest(link, requestId)
  if (!own) return { ok: false, error: 'Not found.' }

  const { data: cur } = await own.admin.from('task_requests').select('extra_links').eq('id', requestId).single()
  const links = Array.isArray(cur?.extra_links) ? cur!.extra_links : []
  if (links.length >= 20) return { ok: false, error: 'Link limit reached.' }
  const { error } = await own.admin.from('task_requests')
    .update({ extra_links: [...links, { label: (label || 'Link').trim().slice(0, 80), url: u }] })
    .eq('id', requestId)
  if (error) return { ok: false, error: 'Could not add the link.' }

  await logRequestActivity(own.admin, {
    requestId, actorType: link.type === 'agency' ? 'agency' : 'client',
    actorLabel: link.requesterLabel, action: 'link_added',
    visibility: link.visibility, detail: { label: label || 'Link', url: u },
  })
  await bumpExternalActivity(own.admin, requestId)
  return { ok: true }
}

export async function updateRequestRemarks(
  token: string, requestId: string, remarks: string,
): Promise<ActionResult> {
  const link = await resolveToken(token)
  if (!link) return { ok: false, error: 'This link is no longer valid.' }
  const own = await ownRequest(link, requestId)
  if (!own) return { ok: false, error: 'Not found.' }

  const { data: cur } = await own.admin.from('task_requests').select('remarks').eq('id', requestId).single()
  const next = (remarks || '').trim().slice(0, 2000)
  const { error } = await own.admin.from('task_requests').update({ remarks: next || null }).eq('id', requestId)
  if (error) return { ok: false, error: 'Could not update remarks.' }

  await logRequestActivity(own.admin, {
    requestId, actorType: link.type === 'agency' ? 'agency' : 'client',
    actorLabel: link.requesterLabel, action: 'field_changed',
    visibility: link.visibility, detail: { field: 'remarks', from: cur?.remarks ?? null, to: next || null },
  })
  await bumpExternalActivity(own.admin, requestId)
  return { ok: true }
}

export async function submitRevisionRequest(
  token: string, requestId: string, note: string, link_url?: string,
): Promise<ActionResult> {
  const link = await resolveToken(token)
  if (!link) return { ok: false, error: 'This link is no longer valid.' }
  const n = (note || '').trim()
  if (!n) return { ok: false, error: 'Describe the revision you need.' }
  const own = await ownRequest(link, requestId)
  if (!own) return { ok: false, error: 'Not found.' }

  await own.admin.from('request_revisions').insert({
    request_id: requestId,
    requested_by_type: link.type === 'agency' ? 'agency' : 'client',
    note: n.slice(0, 2000),
    link: link_url?.trim() || null,
  })
  // Revision flips the request into revision_requested (external-facing state).
  await own.admin.from('task_requests').update({
    status: 'revision_requested', client_status: 'revision_requested',
    status_updated_at: new Date().toISOString(),
  }).eq('id', requestId)

  await logRequestActivity(own.admin, {
    requestId, actorType: link.type === 'agency' ? 'agency' : 'client',
    actorLabel: link.requesterLabel, action: 'revision_requested',
    visibility: link.visibility, detail: { message: n.slice(0, 300) },
  })
  await bumpExternalActivity(own.admin, requestId)
  return { ok: true }
}
