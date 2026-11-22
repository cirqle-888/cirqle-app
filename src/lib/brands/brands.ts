/**
 * Cirqle's own brands (Cirqle Works, Cirqle Flyers, Memoura, …) — pure helpers.
 *
 * A brand is a dimension INSIDE the company scope. It never makes anything
 * billable or client-visible: client_id NULL / scope 'company' / owner_type
 * 'cirqle' still decide that. The brand only says which of Cirqle's brands a
 * row is for. NULL brand_id means the default brand (Cirqle itself), so every
 * row written before brands existed reads as the default brand.
 *
 * No database access here, so the rules are testable on their own.
 */

export interface Brand {
  id: string
  name: string
  slug: string
  tagline: string | null
  color: string | null
  logo_url: string | null
  whatsapp_number: string | null
  website: string | null
  is_default: boolean
  is_active: boolean
  show_on_invoices: boolean
  display_order: number
  /** What the brand calls a task ("Order" for Memoura). NULL = "Task". */
  task_label?: string | null
}

/** "Task" / "Order" — singular and plural, for headings and buttons. */
export function taskNoun(brand: Pick<Brand, 'task_label'> | null | undefined): { one: string; many: string } {
  const one = (brand?.task_label || 'Task').trim() || 'Task'
  return { one, many: /s$/i.test(one) ? one : `${one}s` }
}

/** The brand unbranded rows belong to. Falls back to the first brand. */
export function defaultBrand(brands: Brand[]): Brand | null {
  return brands.find(b => b.is_default) ?? brands[0] ?? null
}

/** Resolve a row's brand_id (NULL = default) to a brand. */
export function brandOf(brandId: string | null | undefined, brands: Brand[]): Brand | null {
  if (brandId) {
    const hit = brands.find(b => b.id === brandId)
    if (hit) return hit
  }
  return defaultBrand(brands)
}

/** The id to bucket a row under: its own brand, or the default brand's. */
export function brandKey(brandId: string | null | undefined, brands: Brand[]): string | null {
  return brandOf(brandId, brands)?.id ?? null
}

/** "Cirqle Flyers" → "cirqle-flyers". Never empty. */
export function slugify(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'brand'
}

/** #abc / #aabbcc, or null for anything else (never stored half-valid). */
export function normalizeHex(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s.slice(1).split('').map(c => c + c).join('')}`.toLowerCase()
  return null
}

/** Brands in display order, default first among equals. */
export function sortBrands<T extends Pick<Brand, 'display_order' | 'is_default' | 'name'>>(brands: T[]): T[] {
  return [...brands].sort((a, b) =>
    (a.display_order - b.display_order) || (Number(b.is_default) - Number(a.is_default)) || a.name.localeCompare(b.name))
}

// ─── Invoice identity ────────────────────────────────────────────────────────

/**
 * What an invoice prints for a brand. Cached in company_settings under
 * BRAND_INVOICE_KEY by the brand actions, so every invoice renderer — which
 * already receives company settings — picks it up without new queries.
 */
export interface BrandInvoiceIdentity {
  name: string
  tagline: string | null
  logoUrl: string | null
  whatsapp: string | null
  /** Services this brand sells, by id and by (lower-cased) name. */
  serviceIds: string[]
  serviceNames: string[]
}

export const BRAND_INVOICE_KEY = 'brand_invoice_identity'

export function parseBrandIdentities(raw: string | null | undefined): BrandInvoiceIdentity[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(x => x && typeof x.name === 'string') : []
  } catch { return [] }
}

interface InvoiceLine {
  service_id?: string | null
  service?: { id?: string | null; name?: string | null } | null
  task?: { service_id?: string | null; service?: { id?: string | null; name?: string | null } | null } | null
}

/**
 * The brand an invoice should carry: only when EVERY line is a service of one
 * brand that prints on invoices. A mixed invoice (flyers + a logo design)
 * stays plain Cirqle — a brand must never claim work it didn't sell. Lines
 * with no service at all (expenses, ad spend) don't vote either way.
 */
export function brandForInvoice(items: InvoiceLine[], identities: BrandInvoiceIdentity[]): BrandInvoiceIdentity | null {
  if (!identities.length || !items.length) return null
  let found: BrandInvoiceIdentity | null = null
  let voted = 0
  for (const it of items) {
    const id = it.service?.id || it.task?.service?.id || it.service_id || it.task?.service_id || null
    const name = (it.service?.name || it.task?.service?.name || '').trim().toLowerCase()
    if (!id && !name) continue
    const match = identities.find(b =>
      (id && b.serviceIds.includes(id)) || (name && b.serviceNames.includes(name))) ?? null
    if (!match) return null            // a line from no printing brand → plain invoice
    if (found && found !== match) return null
    found = match
    voted++
  }
  return voted > 0 ? found : null
}
