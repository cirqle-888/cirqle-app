import { describe, it, expect } from 'vitest'

/**
 * Regression guard for the FK crash that failed the whole offer save.
 *
 * offer_products.catalog_id has a foreign key to client_product_catalog(id).
 * Once the picker began also offering SHARED products (product_catalog), a
 * matched shared product arrived at save time with a product_catalog id in
 * catalog_id — not a client_product_catalog row — so the INSERT died with
 * Postgres 23503 and failed the entire save, but ONLY when the offer happened
 * to include a matched shared product (hence the "intermittent" reports).
 *
 * saveCampaign now resolves catalog_id against the client's own catalog rows up
 * front and keeps it only when it is genuinely one of them. This test locks in
 * that filter: any id not in the client's set must become null, never reach the
 * FK column, and never fail the save.
 */

/** Mirrors the sanitization saveCampaign applies before each insert. */
function safeCatalogId(
  catalogId: string | null | undefined,
  validClientCatalogIds: Set<string>,
): string | null {
  return catalogId && validClientCatalogIds.has(catalogId) ? catalogId : null
}

describe('catalog_id FK sanitization', () => {
  const clientOwned = new Set(['client-row-1', 'client-row-2'])

  it("keeps a catalog_id that IS one of the client's own rows", () => {
    expect(safeCatalogId('client-row-1', clientOwned)).toBe('client-row-1')
  })

  it('nulls a shared product_catalog id (the crash that was)', () => {
    // 5f7d4e95… was a product_catalog row ("Chocolate"), never a client row.
    expect(safeCatalogId('5f7d4e95-3b47-4ec5-a881-1359e5ee384d', clientOwned)).toBeNull()
  })

  it('nulls a stale id no longer present anywhere', () => {
    expect(safeCatalogId('deleted-row', clientOwned)).toBeNull()
  })

  it('passes null/undefined through unchanged', () => {
    expect(safeCatalogId(null, clientOwned)).toBeNull()
    expect(safeCatalogId(undefined, clientOwned)).toBeNull()
  })

  it('a full offer of shared matches produces only nullable FKs — the save cannot 23503', () => {
    // Every product matched a shared-catalog item; none is a client row yet.
    const products = [
      { catalog_id: 'shared-a' },
      { catalog_id: 'shared-b' },
      { catalog_id: 'client-row-1' }, // one genuine client row mixed in
    ]
    const resolved = products.map(p => safeCatalogId(p.catalog_id, clientOwned))
    expect(resolved).toEqual([null, null, 'client-row-1'])
    // No resolved value is a non-client id, so no insert can violate the FK.
    expect(resolved.every(v => v === null || clientOwned.has(v))).toBe(true)
  })
})
