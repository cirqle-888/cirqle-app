/**
 * Field Marketing — shared row types.
 *
 * Mirror the columns of the field_* tables (migration 20260821120000). Kept in
 * one place so the server page, the client component and the actions agree on
 * the shape without re-declaring it three times.
 */

export const FIELD_CATEGORIES = [
  'supermarket', 'shop', 'business_centre', 'restaurant', 'pharmacy', 'salon', 'office', 'other',
] as const
export type FieldCategory = (typeof FIELD_CATEGORIES)[number]

export const FIELD_STATUSES = [
  'not_visited', 'visited', 'interested', 'negotiating', 'converted', 'not_interested', 'revisit',
] as const
export type FieldStatus = (typeof FIELD_STATUSES)[number]

export const FIELD_LIKELIHOODS = ['hot', 'warm', 'cold'] as const
export type FieldLikelihood = (typeof FIELD_LIKELIHOODS)[number]

export interface FieldPlace {
  id: string
  name: string
  category: FieldCategory
  status: FieldStatus
  likelihood: FieldLikelihood | null
  latitude: number
  longitude: number
  address: string | null
  area: string | null
  google_place_id: string | null
  assigned_to: string | null
  territory_id: string | null
  last_visit_at: string | null
  next_followup_at: string | null
  notes: string | null
  converted_client_id: string | null
  converted_lead_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface FieldContact {
  id: string
  place_id: string
  name: string | null
  role: string | null
  phone: string | null
  email: string | null
  notes: string | null
  created_at: string
}

export interface FieldVisit {
  id: string
  place_id: string
  visited_by: string | null
  visited_at: string
  outcome: string | null
  notes: string | null
  latitude: number | null
  longitude: number | null
  next_followup_at: string | null
  created_at: string
}

export interface FieldTerritory {
  id: string
  name: string
  color: string
  assigned_to: string | null
  geojson: unknown | null
  created_at: string
}

// ── Display metadata (labels + tints), shared by the map pins and the list ────

export const STATUS_LABEL: Record<FieldStatus, string> = {
  not_visited: 'Not visited',
  visited: 'Visited',
  interested: 'Interested',
  negotiating: 'Negotiating',
  converted: 'Converted',
  not_interested: 'Not interested',
  revisit: 'Revisit',
}

/** Hex colour per status — used for map pins (needs a raw colour, not a class). */
export const STATUS_COLOR: Record<FieldStatus, string> = {
  not_visited: '#94a3b8', // slate  — untouched
  visited: '#3b82f6',     // blue   — contact made
  interested: '#eab308',  // yellow — warm
  negotiating: '#a855f7', // purple — in talks
  converted: '#22c55e',   // green  — won
  not_interested: '#6b7280', // gray — dead
  revisit: '#f97316',     // orange — come back
}

/** Tailwind chip classes per status (matches the leads module's chip style). */
export const STATUS_CHIP: Record<FieldStatus, string> = {
  not_visited: 'bg-slate-500/15 text-slate-400',
  visited: 'bg-blue-500/15 text-blue-400',
  interested: 'bg-yellow-500/15 text-yellow-400',
  negotiating: 'bg-purple-500/15 text-purple-400',
  converted: 'bg-green-500/15 text-green-400',
  not_interested: 'bg-gray-500/15 text-gray-400',
  revisit: 'bg-orange-500/15 text-orange-400',
}

export const CATEGORY_LABEL: Record<FieldCategory, string> = {
  supermarket: 'Supermarket',
  shop: 'Shop',
  business_centre: 'Business centre',
  restaurant: 'Restaurant',
  pharmacy: 'Pharmacy',
  salon: 'Salon',
  office: 'Office',
  other: 'Other',
}

export const LIKELIHOOD_LABEL: Record<FieldLikelihood, string> = {
  hot: 'Hot', warm: 'Warm', cold: 'Cold',
}
export const LIKELIHOOD_CHIP: Record<FieldLikelihood, string> = {
  hot: 'bg-red-500/15 text-red-400',
  warm: 'bg-amber-500/15 text-amber-400',
  cold: 'bg-sky-500/15 text-sky-400',
}
