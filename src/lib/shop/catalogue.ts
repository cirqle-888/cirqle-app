/**
 * Shop catalogue — the gifts, banner and settings the Memoura website shows.
 *
 * Pure helpers shared by the Shop screen, its server actions and the public
 * endpoint the website reads. Everything that arrives from a form or a JSON
 * column goes through a cleaner here, so the website never receives a price
 * that is not a number or a list that is not a list.
 */

export const SHOP_KEY = 'memoura'

export const WHO_OPTIONS = [
  { key: 'her', label: 'Her' },
  { key: 'him', label: 'Him' },
  { key: 'friends', label: 'A friend' },
  { key: 'abroad', label: 'Family back home' },
] as const
export const OCC_OPTIONS = [
  { key: 'birthday', label: 'Birthday' },
  { key: 'anniversary', label: 'Anniversary' },
] as const
export const EXTRA_KEYS = ['wrap', 'note', 'express'] as const
export type ExtraKey = (typeof EXTRA_KEYS)[number]
export const EXTRA_LABEL: Record<ExtraKey, string> = {
  wrap: 'Gift wrap', note: 'Handwritten note', express: 'Express delivery',
}

export interface ShopProduct {
  id: string
  slug: string
  name: string
  meta: string | null
  price: number
  pieces: number | null
  badge: string | null
  description: string | null
  needs: string[]
  who: string[]
  occ: string[]
  ready: boolean
  image_url: string | null
  active: boolean
  sort: number
}

export interface ShopBanner {
  id: string
  title: string | null
  body: string
  starts_on: string | null
  ends_on: string | null
  free_extra: ExtraKey | null
  free_with: string | null
  active: boolean
  sort: number
}

export interface ShopSize { key: string; name: string; note: string; price: number }
export interface ShopSpot { id: string; title: string; text: string }
export interface ShopSettings {
  freeShippingAbove: number
  delivery: { kerala: number; india: number }
  extras: Record<ExtraKey, number>
  sizes: ShopSize[]
  spotlight: ShopSpot[]
}

/** What the website shows when nothing has been saved yet. Mirrors the site's own built-in copy. */
export const DEFAULT_SETTINGS: ShopSettings = {
  freeShippingAbove: 999,
  delivery: { kerala: 69, india: 99 },
  extras: { wrap: 49, note: 29, express: 99 },
  sizes: [
    { key: 'mini', name: 'Mini', note: 'polaroid size', price: 15 },
    { key: 'a6', name: 'A6', note: '10.5 × 14.8 cm', price: 25 },
    { key: 'a5', name: 'A5', note: '14.8 × 21 cm', price: 39 },
    { key: 'a4', name: 'A4', note: '21 × 29.7 cm', price: 69 },
    { key: 'a3', name: 'A3', note: '29.7 × 42 cm', price: 129 },
  ],
  spotlight: [],
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const strOrNull = (v: unknown, max: number): string | null => str(v, max) || null
const money = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}
const whole = (v: unknown): number | null => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : null
}
export const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** A list of short lines from a JSON column, a textarea (one per line) or an array. */
export function cleanLines(raw: unknown, max = 12): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : []
  return list.map(x => str(x, 160)).filter(Boolean).slice(0, max)
}
const pick = (raw: unknown, allowed: readonly string[]): string[] =>
  (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === 'string' && allowed.includes(x))

/** "Retro wall polaroids" → "retro-wall-polaroids". Used as the gift's id on the website. */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export function cleanProduct(r: Record<string, unknown>): ShopProduct {
  return {
    id: String(r.id ?? ''),
    slug: str(r.slug, 40),
    name: str(r.name, 80),
    meta: strOrNull(r.meta, 60),
    price: money(r.price),
    pieces: whole(r.pieces),
    badge: strOrNull(r.badge, 24),
    description: strOrNull(r.description, 300),
    needs: cleanLines(r.needs),
    who: pick(r.who, WHO_OPTIONS.map(o => o.key)),
    occ: pick(r.occ, OCC_OPTIONS.map(o => o.key)),
    ready: r.ready === true,
    image_url: strOrNull(r.image_url, 400),
    active: r.active !== false,
    sort: Math.round(Number(r.sort)) || 0,
  }
}

export function cleanBanner(r: Record<string, unknown>): ShopBanner {
  const extra = EXTRA_KEYS.find(k => k === r.free_extra) ?? null
  return {
    id: String(r.id ?? ''),
    title: strOrNull(r.title, 60),
    body: str(r.body, 160),
    starts_on: isDay(r.starts_on) ? r.starts_on : null,
    ends_on: isDay(r.ends_on) ? r.ends_on : null,
    free_extra: extra,
    free_with: extra ? strOrNull(r.free_with, 40) : null,
    active: r.active !== false,
    sort: Math.round(Number(r.sort)) || 0,
  }
}

export function cleanSettings(raw: unknown): ShopSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = (o.delivery && typeof o.delivery === 'object' ? o.delivery : {}) as Record<string, unknown>
  const e = (o.extras && typeof o.extras === 'object' ? o.extras : {}) as Record<string, unknown>
  const sizes: ShopSize[] = (Array.isArray(o.sizes) ? o.sizes : [])
    .map(s => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}))
    .map(s => ({ key: str(s.key, 12), name: str(s.name, 20), note: str(s.note, 40), price: money(s.price) }))
    .filter(s => s.key && s.name && s.price > 0)
  const spotlight: ShopSpot[] = (Array.isArray(o.spotlight) ? o.spotlight : [])
    .map(s => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}))
    .map(s => ({ id: str(s.id, 40), title: str(s.title, 80), text: str(s.text, 200) }))
    .filter(s => s.id && s.title)
    .slice(0, 2)
  return {
    freeShippingAbove: money(o.freeShippingAbove) || DEFAULT_SETTINGS.freeShippingAbove,
    delivery: {
      kerala: 'kerala' in d ? money(d.kerala) : DEFAULT_SETTINGS.delivery.kerala,
      india: 'india' in d ? money(d.india) : DEFAULT_SETTINGS.delivery.india,
    },
    extras: {
      wrap: 'wrap' in e ? money(e.wrap) : DEFAULT_SETTINGS.extras.wrap,
      note: 'note' in e ? money(e.note) : DEFAULT_SETTINGS.extras.note,
      express: 'express' in e ? money(e.express) : DEFAULT_SETTINGS.extras.express,
    },
    // A size's key is part of saved orders on buyers' phones, so sizes are edited, never invented here.
    sizes: sizes.length ? sizes : DEFAULT_SETTINGS.sizes,
    spotlight,
  }
}

/** Is this banner the one to show on `today` (YYYY-MM-DD)? */
export function bannerIsLive(b: ShopBanner, today: string): boolean {
  if (!b.active || !b.body) return false
  if (b.starts_on && today < b.starts_on) return false
  if (b.ends_on && today > b.ends_on) return false
  return true
}

/** Where a banner stands, for the list in the app. */
export function bannerState(b: ShopBanner, today: string): 'off' | 'scheduled' | 'live' | 'ended' {
  if (!b.active) return 'off'
  if (b.ends_on && today > b.ends_on) return 'ended'
  if (b.starts_on && today < b.starts_on) return 'scheduled'
  return 'live'
}

/** Today in India, as YYYY-MM-DD. The shop's offers start and end on Indian dates. */
export function todayInIndia(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)
}

/**
 * The JSON the website reads. Only what the site shows: gifts that are switched
 * on, every banner that could still run (the site picks by the buyer's date,
 * so a cached copy still changes over at midnight), and the settings.
 */
export function publicCatalogue(products: ShopProduct[], banners: ShopBanner[], settings: ShopSettings, today: string) {
  const live = products.filter(p => p.active && p.slug && p.name).sort((a, b) => a.sort - b.sort)
  const slugs = new Set(live.map(p => p.slug))
  return {
    v: 1,
    products: live.map(p => ({
      id: p.slug, name: p.name, meta: p.meta ?? '', price: p.price,
      ...(p.pieces ? { pieces: p.pieces } : {}),
      ...(p.badge ? { badge: p.badge } : {}),
      ...(p.ready ? { ready: true } : {}),
      ...(p.image_url ? { img: p.image_url } : {}),
      desc: p.description ?? '', need: p.needs, who: p.who, occ: p.occ,
    })),
    banners: banners
      .filter(b => b.active && b.body && !(b.ends_on && today > b.ends_on))
      .sort((a, b) => a.sort - b.sort)
      .map(b => ({
        title: b.title ?? '', text: b.body, from: b.starts_on, to: b.ends_on,
        ...(b.free_extra && b.free_with && slugs.has(b.free_with) ? { free: b.free_extra, gift: b.free_with } : {}),
      })),
    sizes: settings.sizes,
    shop: { freeShippingAbove: settings.freeShippingAbove, delivery: settings.delivery },
    extras: settings.extras,
    spotlight: settings.spotlight.filter(s => slugs.has(s.id)),
  }
}
export type PublicCatalogue = ReturnType<typeof publicCatalogue>
