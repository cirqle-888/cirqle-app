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
  priority: 'A' | 'B' | 'C' | null
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
  parent_id: string | null
  kind: TerritoryKind
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

// ── Priority (A/B/C column on field_places) ──────────────────────────────────
export const PRIORITY_LABEL: Record<string, string> = { A: 'High', B: 'Medium', C: 'Low' }
export const PRIORITY_CHIP: Record<string, string> = {
  A: 'bg-red-500/15 text-red-400',
  B: 'bg-amber-500/15 text-amber-400',
  C: 'bg-slate-500/15 text-slate-400',
}
/** Numeric weight for scoring (higher = more important). */
export const PRIORITY_WEIGHT: Record<string, number> = { A: 3, B: 2, C: 1 }

// ── Smart visit outcomes (§4) ────────────────────────────────────────────────
// Stored verbatim in field_visits.outcome (free text). Each carries a SUGGESTED
// status/likelihood/follow-up that pre-fills Quick Visit — the rep can override,
// and an explicit override is never silently replaced.
export interface FieldOutcome {
  value: string
  label: string
  /** Suggested pipeline status to roll the place up to. */
  status: FieldStatus
  /** Suggested conversion likelihood (omit = leave unchanged). */
  likelihood?: FieldLikelihood
  /** Suggests scheduling a follow-up (Quick Visit pre-selects "Tomorrow"). */
  followup?: boolean
  tone: 'positive' | 'neutral' | 'negative'
}

export const FIELD_OUTCOMES: FieldOutcome[] = [
  { value: 'interested',        label: 'Interested',              status: 'interested',     likelihood: 'warm', followup: true,  tone: 'positive' },
  { value: 'very_interested',   label: 'Very Interested',         status: 'interested',     likelihood: 'hot',  followup: true,  tone: 'positive' },
  { value: 'asked_quotation',   label: 'Asked for Quotation',     status: 'negotiating',    likelihood: 'hot',  followup: true,  tone: 'positive' },
  { value: 'catalogue_shared',  label: 'Catalogue Shared',        status: 'interested',     likelihood: 'warm', followup: true,  tone: 'positive' },
  { value: 'price_concern',     label: 'Price Concern',           status: 'negotiating',    likelihood: 'warm', followup: true,  tone: 'neutral'  },
  { value: 'owner_available',   label: 'Owner Available',         status: 'visited',        followup: false,                    tone: 'neutral'  },
  { value: 'owner_unavailable', label: 'Owner Unavailable',       status: 'revisit',        followup: true,  tone: 'neutral'  },
  { value: 'dm_unavailable',    label: 'Decision Maker Unavailable', status: 'revisit',     followup: true,  tone: 'neutral'  },
  { value: 'call_later',        label: 'Call Later',              status: 'revisit',        followup: true,  tone: 'neutral'  },
  { value: 'revisit_required',  label: 'Revisit Required',        status: 'revisit',        followup: true,  tone: 'neutral'  },
  { value: 'contact_collected', label: 'Contact Collected',       status: 'visited',        followup: false,                    tone: 'neutral'  },
  { value: 'competitor',        label: 'Already Using Competitor', status: 'not_interested', likelihood: 'cold', followup: false, tone: 'negative' },
  { value: 'not_interested',    label: 'Not Interested',          status: 'not_interested', likelihood: 'cold', followup: false, tone: 'negative' },
  { value: 'converted',         label: 'Converted',               status: 'converted',      likelihood: 'hot',  followup: false, tone: 'positive' },
]

export const OUTCOME_BY_VALUE: Record<string, FieldOutcome> = Object.fromEntries(FIELD_OUTCOMES.map(o => [o.value, o]))

// ── Territory hierarchy (field_territories.parent_id + kind) ─────────────────
export type TerritoryKind = 'region' | 'area' | 'locality' | 'route'
export interface TerritoryNode {
  id: string
  name: string
  kind: TerritoryKind
  parent_id: string | null
  color: string
}
