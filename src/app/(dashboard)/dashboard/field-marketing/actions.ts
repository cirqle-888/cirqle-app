'use server'

/**
 * Field Marketing server actions — the write path for /dashboard/field-marketing.
 *
 * House pattern (see dashboard/leads/actions.ts):
 *   requirePermission → guard.ok check → createAdminClient → mutation →
 *   void logActivity(...) → revalidatePath → { ok, error?, data? }
 *
 * Reads stay in the server page; the only reads here are the on-demand
 * place-detail fetch (contacts + visits) and the small lookups a mutation
 * needs. All writes go through the service-role admin client.
 *
 * NOTE (project constraint): a 'use server' module may export ONLY async
 * functions. `interface`/`type` exports are erased at compile time so they are
 * fine; there are deliberately no `export const` / re-exported types here.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { createNotification } from '@/lib/notifications/create'
import { revalidatePath } from 'next/cache'
import {
  FIELD_CATEGORIES, FIELD_STATUSES, FIELD_LIKELIHOODS,
  type FieldCategory, type FieldStatus, type FieldLikelihood,
  type FieldContact, type FieldVisit,
} from '@/lib/field/types'
import { distanceMeters } from '@/lib/field/geo'

const REVALIDATE = '/dashboard/field-marketing'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** Log a field-place write onto the CRM timeline (house shape). */
function logPlace(
  actorId: string | null | undefined,
  placeId: string | null,
  action: string,
  from: unknown,
  to: unknown,
): void {
  void logActivity({
    actorId: actorId ?? null,
    entityType: 'field_place',
    entityId: placeId,
    action,
    category: 'crm',
    detail: [{ field: 'field_place', from, to }],
  })
}

const isCategory = (v: unknown): v is FieldCategory =>
  typeof v === 'string' && (FIELD_CATEGORIES as readonly string[]).includes(v)
const isStatus = (v: unknown): v is FieldStatus =>
  typeof v === 'string' && (FIELD_STATUSES as readonly string[]).includes(v)
const isLikelihood = (v: unknown): v is FieldLikelihood =>
  typeof v === 'string' && (FIELD_LIKELIHOODS as readonly string[]).includes(v)

const inRange = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)

// ── Create place ──────────────────────────────────────────────────────────────

export interface CreatePlaceInput {
  name: string
  category?: FieldCategory
  latitude: number
  longitude: number
  address?: string | null
  area?: string | null
  likelihood?: FieldLikelihood | null
  notes?: string | null
  assignedTo?: string | null
  territoryId?: string | null
  /** Optional first contact captured on the same screen. */
  contactName?: string | null
  contactPhone?: string | null
}

export async function createPlace(
  input: CreatePlaceInput,
): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = input.name?.trim()
  if (!name) return { ok: false, error: 'Give the place a name.' }
  const lat = Number(input.latitude)
  const lng = Number(input.longitude)
  if (!inRange(lat, lng)) return { ok: false, error: 'Pick the place on the map (invalid coordinates).' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('field_places')
    .insert({
      name,
      category: isCategory(input.category) ? input.category : 'shop',
      status: 'not_visited',
      likelihood: isLikelihood(input.likelihood) ? input.likelihood : null,
      latitude: lat,
      longitude: lng,
      address: input.address?.trim() || null,
      area: input.area?.trim() || null,
      notes: input.notes?.trim() || null,
      assigned_to: input.assignedTo || null,
      territory_id: input.territoryId || null,
      created_by: guard.employeeId ?? null,
    })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }
  const id = (data as { id: string }).id

  // Optional first contact captured alongside the place.
  if (input.contactName?.trim() || input.contactPhone?.trim()) {
    await admin.from('field_place_contacts').insert({
      place_id: id,
      name: input.contactName?.trim() || null,
      phone: input.contactPhone?.trim() || null,
      created_by: guard.employeeId ?? null,
    })
  }

  logPlace(guard.employeeId, id, 'created', null, { name, category: input.category })

  // If it lands with an owner, tell them (same courtesy as a lead assignment).
  if (input.assignedTo && input.assignedTo !== guard.employeeId) {
    void createNotification({
      employeeId: input.assignedTo,
      type: 'field_place_assigned',
      title: 'Field place assigned to you',
      message: name,
      link: REVALIDATE,
      sourceKey: `field_assign:${id}:${input.assignedTo}`,
    })
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { id } }
}

// ── Edit basic fields ─────────────────────────────────────────────────────────

export interface UpdatePlacePatch {
  name?: string
  category?: FieldCategory
  likelihood?: FieldLikelihood | null
  priority?: 'A' | 'B' | 'C' | null
  address?: string | null
  area?: string | null
  notes?: string | null
  latitude?: number
  longitude?: number
}

export async function updatePlace(id: string, patch: UpdatePlacePatch): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const n = patch.name.trim()
    if (!n) return { ok: false, error: 'Name cannot be empty.' }
    updates.name = n
  }
  if (patch.category !== undefined && isCategory(patch.category)) updates.category = patch.category
  if (patch.likelihood !== undefined) updates.likelihood = isLikelihood(patch.likelihood) ? patch.likelihood : null
  if (patch.priority !== undefined) updates.priority = (['A', 'B', 'C'] as const).includes(patch.priority as 'A') ? patch.priority : null
  if (patch.address !== undefined) updates.address = patch.address?.trim() || null
  if (patch.area !== undefined) updates.area = patch.area?.trim() || null
  if (patch.notes !== undefined) updates.notes = patch.notes?.trim() || null
  if (patch.latitude !== undefined && patch.longitude !== undefined) {
    const lat = Number(patch.latitude), lng = Number(patch.longitude)
    if (!inRange(lat, lng)) return { ok: false, error: 'Invalid coordinates.' }
    updates.latitude = lat
    updates.longitude = lng
  }
  if (Object.keys(updates).length === 0) return { ok: true }

  const admin = createAdminClient()
  const { error } = await admin.from('field_places').update(updates).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logPlace(guard.employeeId, id, 'edited', null, { fields: Object.keys(updates) })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Status ────────────────────────────────────────────────────────────────────

export async function updatePlaceStatus(id: string, status: FieldStatus): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!isStatus(status)) return { ok: false, error: 'Unknown status.' }

  const admin = createAdminClient()
  const { data: before } = await admin.from('field_places').select('status').eq('id', id).maybeSingle()
  const { error } = await admin.from('field_places').update({ status }).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logPlace(guard.employeeId, id, 'status_changed', (before as { status?: string } | null)?.status ?? null, status)
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Assignment ─────────────────────────────────────────────────────────────────

export async function assignPlace(id: string, employeeId: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: place } = await admin.from('field_places').select('name, assigned_to').eq('id', id).maybeSingle()
  if (!place) return { ok: false, error: 'Place not found.' }

  const { error } = await admin.from('field_places').update({ assigned_to: employeeId }).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logPlace(guard.employeeId, id, 'assigned', (place as { assigned_to?: string }).assigned_to ?? null, employeeId)

  if (employeeId && employeeId !== (place as { assigned_to?: string }).assigned_to) {
    void createNotification({
      employeeId,
      type: 'field_place_assigned',
      title: 'Field place assigned to you',
      message: (place as { name?: string }).name || 'A place',
      link: REVALIDATE,
      sourceKey: `field_assign:${id}:${employeeId}`,
    })
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Follow-up scheduling ────────────────────────────────────────────────────────

export async function setFollowup(id: string, nextFollowupAt: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  let iso: string | null = null
  if (nextFollowupAt) {
    const d = new Date(nextFollowupAt)
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'Invalid follow-up date.' }
    iso = d.toISOString()
  }

  const admin = createAdminClient()
  const { error } = await admin.from('field_places').update({ next_followup_at: iso }).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logPlace(guard.employeeId, id, 'edited', null, { next_followup_at: iso })
  revalidatePath(REVALIDATE)
  return { ok: true, data: undefined }
}

// ── Contacts ────────────────────────────────────────────────────────────────────

export interface AddContactInput {
  name?: string | null
  role?: string | null
  phone?: string | null
  email?: string | null
  notes?: string | null
}

export async function addContact(placeId: string, input: AddContactInput): Promise<ActionResult<FieldContact>> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.name?.trim() && !input.phone?.trim() && !input.email?.trim()) {
    return { ok: false, error: 'Give the contact at least a name, phone or email.' }
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('field_place_contacts')
    .insert({
      place_id: placeId,
      name: input.name?.trim() || null,
      role: input.role?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      notes: input.notes?.trim() || null,
      created_by: guard.employeeId ?? null,
    })
    .select('*')
    .single()
  if (error) return { ok: false, error: error.message }

  logPlace(guard.employeeId, placeId, 'edited', null, { added_contact: input.name || input.phone })
  revalidatePath(REVALIDATE)
  return { ok: true, data: data as FieldContact }
}

export async function deleteContact(contactId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('field_place_contacts').delete().eq('id', contactId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Log a visit (the coverage record) ────────────────────────────────────────────

export interface LogVisitInput {
  outcome?: FieldStatus | null   // status recorded at the visit → also updates the place
  notes?: string | null
  latitude?: number | null       // where the rep actually stood
  longitude?: number | null
  nextFollowupAt?: string | null
}

export async function logVisit(
  placeId: string,
  input: LogVisitInput,
): Promise<ActionResult<{ visit: FieldVisit; last_visit_at: string; status: FieldStatus | null; next_followup_at: string | null }>> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const now = new Date().toISOString()
  const outcome = isStatus(input.outcome) ? input.outcome : null

  let followIso: string | null = null
  if (input.nextFollowupAt) {
    const d = new Date(input.nextFollowupAt)
    if (!Number.isNaN(d.getTime())) followIso = d.toISOString()
  }

  const { data: visit, error } = await admin
    .from('field_visits')
    .insert({
      place_id: placeId,
      visited_by: guard.employeeId ?? null,
      visited_at: now,
      outcome,
      notes: input.notes?.trim() || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      next_followup_at: followIso,
    })
    .select('*')
    .single()
  if (error) return { ok: false, error: error.message }

  // Roll the visit up onto the place: last_visit_at always, status/follow-up
  // when the rep set them. This is what powers "already covered".
  const placePatch: Record<string, unknown> = { last_visit_at: now }
  if (outcome) placePatch.status = outcome
  if (followIso !== null || input.nextFollowupAt === null) placePatch.next_followup_at = followIso
  await admin.from('field_places').update(placePatch).eq('id', placeId)

  logPlace(guard.employeeId, placeId, 'note_added', null, { visit: true, outcome })
  revalidatePath(REVALIDATE)
  return {
    ok: true,
    data: {
      visit: visit as FieldVisit,
      last_visit_at: now,
      status: outcome,
      next_followup_at: placePatch.next_followup_at !== undefined ? followIso : null,
    },
  }
}

// ── Quick Visit — one-tap field logging (§3) ─────────────────────────────────────
// Logs a visit + rolls status/likelihood/follow-up onto the place + optional
// contact, in a single call. Complements (does not replace) the detailed logVisit.

export interface QuickVisitInput {
  outcome: string                    // FIELD_OUTCOMES value or a free label
  status?: FieldStatus | null        // final (possibly user-adjusted) status
  likelihood?: FieldLikelihood | null
  notes?: string | null
  latitude?: number | null
  longitude?: number | null
  nextFollowupAt?: string | null
  contactName?: string | null
  contactPhone?: string | null
}

export async function quickVisit(
  placeId: string,
  input: QuickVisitInput,
): Promise<ActionResult<{ visit: FieldVisit; last_visit_at: string; status: FieldStatus | null; likelihood: FieldLikelihood | null; next_followup_at: string | null; contact: FieldContact | null }>> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const now = new Date().toISOString()
  const status = isStatus(input.status) ? input.status : null
  const likelihood = isLikelihood(input.likelihood) ? input.likelihood : null

  let followIso: string | null = null
  if (input.nextFollowupAt) {
    const d = new Date(input.nextFollowupAt)
    if (!Number.isNaN(d.getTime())) followIso = d.toISOString()
  }

  const { data: visit, error } = await admin
    .from('field_visits')
    .insert({
      place_id: placeId,
      visited_by: guard.employeeId ?? null,
      visited_at: now,
      outcome: input.outcome?.trim() || null,
      notes: input.notes?.trim() || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      next_followup_at: followIso,
    })
    .select('*').single()
  if (error) return { ok: false, error: error.message }

  const placePatch: Record<string, unknown> = { last_visit_at: now }
  if (status) placePatch.status = status
  if (likelihood) placePatch.likelihood = likelihood
  if (input.nextFollowupAt !== undefined) placePatch.next_followup_at = followIso
  await admin.from('field_places').update(placePatch).eq('id', placeId)

  let contact: FieldContact | null = null
  if (input.contactPhone?.trim() || input.contactName?.trim()) {
    const { data: c } = await admin.from('field_place_contacts').insert({
      place_id: placeId,
      name: input.contactName?.trim() || null,
      phone: input.contactPhone?.trim() || null,
      created_by: guard.employeeId ?? null,
    }).select('*').single()
    contact = (c as FieldContact) ?? null
  }

  logPlace(guard.employeeId, placeId, 'note_added', null, { quick_visit: true, outcome: input.outcome })
  revalidatePath(REVALIDATE)
  return {
    ok: true,
    data: {
      visit: visit as FieldVisit,
      last_visit_at: now,
      status,
      likelihood,
      next_followup_at: input.nextFollowupAt !== undefined ? followIso : null,
      contact,
    },
  }
}

// ── On-demand detail (contacts + visit history) ──────────────────────────────────

export async function getPlaceDetail(
  placeId: string,
): Promise<ActionResult<{ contacts: FieldContact[]; visits: FieldVisit[] }>> {
  const guard = await requirePermission(PERMS.FIELD_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const [contactsRes, visitsRes] = await Promise.all([
    admin.from('field_place_contacts').select('*').eq('place_id', placeId).order('created_at'),
    admin.from('field_visits').select('*').eq('place_id', placeId).order('visited_at', { ascending: false }).limit(50),
  ])
  return {
    ok: true,
    data: {
      contacts: (contactsRes.data || []) as FieldContact[],
      visits: (visitsRes.data || []) as FieldVisit[],
    },
  }
}

// ── Daily field report (§14) — computed from field_visits, no schema change ──────

export interface DailyReportVisit {
  placeId: string; name: string; area: string | null
  outcome: string | null; status: string; likelihood: string | null; at: string
}
export async function getDailyReport(dayIso?: string): Promise<ActionResult<{
  date: string
  visits: DailyReportVisit[]
  newProspects: number
  contactsCollected: number
  followupsCreated: number
  distanceM: number
}>> {
  const guard = await requirePermission(PERMS.FIELD_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  const me = guard.employeeId
  const admin = createAdminClient()
  const base = dayIso ? new Date(dayIso) : new Date()
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  const end = new Date(start.getTime() + 86_400_000)
  const startIso = start.toISOString(), endIso = end.toISOString()

  const [visitsRes, contactsRes, newRes] = await Promise.all([
    admin.from('field_visits').select('place_id, outcome, visited_at, latitude, longitude, next_followup_at')
      .eq('visited_by', me).gte('visited_at', startIso).lt('visited_at', endIso).order('visited_at'),
    admin.from('field_place_contacts').select('id', { count: 'exact', head: true })
      .eq('created_by', me).gte('created_at', startIso).lt('created_at', endIso),
    admin.from('field_places').select('id', { count: 'exact', head: true })
      .eq('created_by', me).gte('created_at', startIso).lt('created_at', endIso),
  ])
  const visits = (visitsRes.data || []) as { place_id: string; outcome: string | null; visited_at: string; latitude: number | null; longitude: number | null; next_followup_at: string | null }[]

  const placeIds = [...new Set(visits.map(v => v.place_id))]
  const placeMap = new Map<string, { name: string; area: string | null; status: string; likelihood: string | null }>()
  if (placeIds.length) {
    const { data: pls } = await admin.from('field_places').select('id, name, area, status, likelihood').in('id', placeIds)
    for (const p of (pls || []) as { id: string; name: string; area: string | null; status: string; likelihood: string | null }[]) {
      placeMap.set(p.id, { name: p.name, area: p.area, status: p.status, likelihood: p.likelihood })
    }
  }

  let distanceM = 0
  let prev: { latitude: number; longitude: number } | null = null
  for (const v of visits) {
    if (v.latitude != null && v.longitude != null) {
      const cur = { latitude: v.latitude, longitude: v.longitude }
      if (prev) distanceM += distanceMeters(prev, cur)
      prev = cur
    }
  }

  const out: DailyReportVisit[] = visits.map(v => {
    const p = placeMap.get(v.place_id)
    return { placeId: v.place_id, name: p?.name ?? 'Place', area: p?.area ?? null, outcome: v.outcome, status: p?.status ?? '', likelihood: p?.likelihood ?? null, at: v.visited_at }
  })

  return {
    ok: true,
    data: {
      date: startIso,
      visits: out,
      newProspects: newRes.count ?? 0,
      contactsCollected: contactsRes.count ?? 0,
      followupsCreated: visits.filter(v => v.next_followup_at).length,
      distanceM,
    },
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deletePlace(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: place } = await admin.from('field_places').select('name').eq('id', id).maybeSingle()
  const { error } = await admin.from('field_places').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  logPlace(guard.employeeId, id, 'deleted', (place as { name?: string } | null)?.name ?? null, null)
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Convert a place into a real client ───────────────────────────────────────────

export async function convertPlaceToClient(id: string): Promise<ActionResult<{ clientId: string }>> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: place } = await admin
    .from('field_places')
    .select('id, name, converted_client_id')
    .eq('id', id)
    .maybeSingle()
  if (!place) return { ok: false, error: 'Place not found.' }
  const existing = (place as { converted_client_id?: string | null }).converted_client_id
  if (existing) return { ok: true, data: { clientId: existing } } // idempotent

  // Pull one contact for the client's name/phone/email, if any.
  const { data: contact } = await admin
    .from('field_place_contacts')
    .select('name, phone, email')
    .eq('place_id', id)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  // Next client code — same numeric-padded scheme the Clients form uses.
  const { data: latest } = await admin
    .from('clients')
    .select('code')
    .order('code', { ascending: false })
    .limit(1)
  const nextCode = String((parseInt((latest?.[0] as { code?: string } | undefined)?.code || '0') || 0) + 1).padStart(3, '0')

  const c = (contact as { name?: string; phone?: string; email?: string } | null) ?? null
  const { data: client, error } = await admin
    .from('clients')
    .insert({
      name: (place as { name: string }).name,
      code: nextCode,
      contact_name: c?.name || null,
      phone: c?.phone || null,
      email: c?.email || null,
      country: 'India',
      default_currency: 'INR',
      is_active: true,
    })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }
  const clientId = (client as { id: string }).id

  await admin.from('field_places').update({ converted_client_id: clientId, status: 'converted' }).eq('id', id)

  logPlace(guard.employeeId, id, 'status_changed', null, { converted_client_id: clientId })
  void logActivity({
    actorId: guard.employeeId ?? null,
    entityType: 'client',
    entityId: clientId,
    clientId,
    action: 'created',
    category: 'crm',
    detail: { from_field_place: id, name: (place as { name: string }).name },
  })
  revalidatePath(REVALIDATE)
  return { ok: true, data: { clientId } }
}

// ── Territories ─────────────────────────────────────────────────────────────────

export interface SaveTerritoryInput {
  id?: string | null
  name: string
  color?: string
  assignedTo?: string | null
}

export async function saveTerritory(input: SaveTerritoryInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const name = input.name?.trim()
  if (!name) return { ok: false, error: 'Give the territory a name.' }

  const admin = createAdminClient()
  const row = {
    name,
    color: input.color?.trim() || '#6366f1',
    assigned_to: input.assignedTo || null,
  }
  if (input.id) {
    const { error } = await admin.from('field_territories').update(row).eq('id', input.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath(REVALIDATE)
    return { ok: true, data: { id: input.id } }
  }
  const { data, error } = await admin
    .from('field_territories')
    .insert({ ...row, created_by: guard.employeeId ?? null })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: (data as { id: string }).id } }
}

export async function deleteTerritory(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.FIELD_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('field_territories').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}
