/**
 * Read-only import from a client-maintained Google Sheet.
 *
 * Some clients keep their own master sheet (e.g. tabs "Groceries" with
 * Product|MRP|SALE and "Vegetables" with Item|Sale) which feeds their designer
 * sheets through IMPORTRANGE plus a photo automation. Pushing Cirqle's column
 * layout into that sheet would destroy the whole chain, so for those clients we
 * only ever READ: the rows become a campaign snapshot so Cirqle has history,
 * reporting and trends, while the sheet itself is never touched.
 *
 * The fetch goes through the public CSV export, so it needs no Google
 * credentials — only that the sheet is link-shared, which these already are.
 */

import { parse } from 'csv-parse/sync'
import { safePublicFetch, BlockedHostError } from '@/lib/safe-fetch'

export interface PulledRow {
  name: string
  price: number | null
  mrp: number | null
  weight: string | null
}

/**
 * Header aliases, matched case-insensitively in any column order. Clients name
 * these columns however they like ("Item"/"Product", "Sale"/"Offer"), and they
 * rename them between weeks, so matching on position would be brittle.
 */
const COLUMN_ALIASES: Record<keyof PulledRow, string[]> = {
  name: ['product', 'item', 'name', 'description', 'product name', 'item name', 'particulars'],
  price: ['sale', 'price', 'offer', 'offer price', 'sale price', 'rate', 'our price'],
  mrp: ['mrp', 'm.r.p', 'm.r.p.', 'market price', 'list price', 'old price'],
  weight: ['weight', 'size', 'qty', 'quantity', 'pack', 'pack size', 'unit'],
}

/** Guards against a runaway sheet becoming a giant campaign. */
const MAX_ROWS = 500

function normalizeHeader(header: string): keyof PulledRow | null {
  const cleaned = header.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!cleaned) return null
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [keyof PulledRow, string[]][]) {
    if (aliases.includes(cleaned)) return field
  }
  return null
}

/**
 * Money as typed by a shop owner: "₹1,299.50", "1299", "1,299/-", "" or "-".
 * Anything that isn't a positive number becomes null rather than 0, so a blank
 * price stays visibly blank on the flyer instead of advertising "₹0".
 */
function parseMoney(raw: string | undefined): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return null
  const value = Number(cleaned)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Turn a sheet tab's CSV into product rows.
 *
 * Exported separately from the fetch so it can be tested against the real
 * column shapes without touching the network.
 */
export function parseSheetCsv(csv: string): PulledRow[] {
  let table: string[][]
  try {
    table = parse(csv, { relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][]
  } catch {
    return []
  }
  if (!table.length) return []

  // The header is not always row 1 — clients leave a title or a blank row on
  // top. Take the first row that maps to a usable name column.
  let headerIndex = -1
  let headerMap: (keyof PulledRow | null)[] = []
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    const mapped = table[i].map(normalizeHeader)
    if (mapped.includes('name')) {
      headerIndex = i
      headerMap = mapped
      break
    }
  }
  if (headerIndex === -1) return []

  const rows: PulledRow[] = []
  for (const cells of table.slice(headerIndex + 1)) {
    const get = (field: keyof PulledRow) => {
      const col = headerMap.indexOf(field)
      return col === -1 ? undefined : (cells[col] ?? '').trim()
    }

    const name = (get('name') || '').trim()
    if (!name) continue // trailing blank rows, spacers, section breaks

    rows.push({
      name,
      price: parseMoney(get('price')),
      mrp: parseMoney(get('mrp')),
      weight: get('weight') || null,
    })
    if (rows.length >= MAX_ROWS) break
  }
  return rows
}

/**
 * Fetch one tab of a spreadsheet as CSV via the public gviz export.
 * Requires only that the sheet is shared by link.
 */
export async function fetchSheetTabCsv(sheetId: string, tabName: string | null): Promise<string> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq`)
  url.searchParams.set('tqx', 'out:csv')
  if (tabName) url.searchParams.set('sheet', tabName)

  const res = await safePublicFetch(url, { timeoutMs: 20_000 })
  if (!res.ok) {
    if (res.status === 404) throw new Error('Sheet or tab not found. Check the tab name and that the sheet is shared with "Anyone with the link".')
    throw new Error(`Could not read the sheet (HTTP ${res.status}). Make sure it is shared with "Anyone with the link".`)
  }

  const body = await res.text()
  // A sheet that isn't link-shared answers 200 with a Google sign-in page.
  if (/^\s*<!doctype|^\s*<html/i.test(body)) {
    throw new Error('Google returned a sign-in page instead of the sheet. Share the sheet with "Anyone with the link" (Viewer is enough).')
  }
  return body
}

export { BlockedHostError }
