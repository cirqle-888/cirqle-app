/**
 * Shared types for the SIMPLE client intake app (mobile-first entrance).
 *
 * These mirror the row shapes getOfferPageData returns — the same data the
 * heavy staff editor consumes — so the two entrances stay interchangeable
 * without the server caring which one saved.
 */

import type { ProductInput } from '../actions'

export interface Badge { id: string; label: string; color: string }

export interface CatalogImage { id: string; url: string; is_primary: boolean; created_at: string }

export interface CatalogItem {
  id: string
  name: string
  weight?: string | null
  image_url?: string | null
  category?: string | null
  images?: CatalogImage[]
}

export interface ProductBadgeRow {
  id: string
  badge_id?: string | null
  custom_label?: string | null
  color: string
  badge?: Badge | Badge[] | null
}

export interface OfferProductRow {
  id: string
  catalog_id?: string
  group_id?: string | null
  name: string
  weight?: string
  image_url?: string
  offer_type: 'price' | 'percent' | 'bogo' | 'other'
  price?: number | null
  mrp?: number | null
  offer_text?: string
  badges?: ProductBadgeRow[]
  page?: number
  display_order: number
}

export interface CampaignRow {
  id: string
  title?: string
  date_type: 'single' | 'range'
  offer_date?: string
  offer_date_from?: string
  offer_date_to?: string
  products: OfferProductRow[]
}

/** A product row as the simple editor holds it: server input + a stable key. */
export type LocalProduct = ProductInput & {
  _key: string
  id?: string
  /** Photo chosen but not yet (successfully) uploaded — save proceeds without
   * it; the row shows "photo pending — retry". Never blocks the campaign. */
  _pendingPhoto?: boolean
}

export const BADGE_CHIP_COLOR: Record<string, string> = {
  red:    'bg-red-500/15 text-red-400 border-red-500/30',
  amber:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  orange: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  green:  'bg-green-500/15 text-green-400 border-green-500/30',
  blue:   'bg-blue-500/15 text-blue-400 border-blue-500/30',
  purple: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

export const INPUT_CLASS =
  'w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 placeholder:text-white/30 transition-colors'

export const LABEL_CLASS = 'block text-xs font-medium text-white/50 mb-1.5'

let keyCounter = 0
export function freshKey(): string {
  keyCounter += 1
  return `new-${Date.now()}-${keyCounter}`
}

export function fmtOfferDate(d?: string | null): string {
  if (!d) return ''
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
