/**
 * The single data contract shared by Cirqle's offer editor, Google Sheets,
 * and the Figma Google Sheets plugin. Keep these columns stable: designers
 * can bind their Figma components once and refresh the same sheet each week.
 */

export const OFFER_SHEET_HEADERS = [
  'Page Number',
  'Display Order',
  'Product',
  'Weight',
  'Offer Type',
  'Offer Price',
  'MRP',
  'Offer Text',
  'Badges',
  'Image URL',
  'Offer Title',
  'Offer Date',
  'Client',
  // Split price for two-layer designs: ₹20.99 → Price 1 = "20" (big numeral),
  // Price 2 = "99" (small paisa layer). Appended AFTER the original 13 columns
  // so existing Figma bindings keep their positions and header names.
  'Price 1',
  'Price 2',
] as const

type SheetBadge = {
  custom_label?: string | null
  label?: string | null
  badge?: { label?: string | null } | { label?: string | null }[] | null
}

export type OfferSheetProduct = {
  name?: string | null
  weight?: string | null
  offer_type?: string | null
  price?: number | null
  mrp?: number | null
  offer_text?: string | null
  image_url?: string | null
  page?: number | null
  display_order?: number | null
  badges?: SheetBadge[] | null
}

function badgeLabel(badge: SheetBadge): string {
  if (badge.custom_label) return badge.custom_label
  if (badge.label) return badge.label
  const relation = Array.isArray(badge.badge) ? badge.badge[0] : badge.badge
  return relation?.label || ''
}

function offerText(product: OfferSheetProduct): string {
  if (product.offer_type === 'bogo') return 'Buy 1 Get 1'
  return product.offer_text || ''
}

/**
 * Split a price into [whole, paise] display parts for the Price 1 / Price 2
 * columns: 20.99 → ["20", "99"]; 20.5 → ["20", "50"]; 20 → ["20", ""] (empty
 * paise keeps the small design layer blank instead of showing "00").
 */
function splitPrice(value: number | null | undefined): [string, string] {
  if (value == null) return ['', '']
  const whole = Math.trunc(value)
  const paise = Math.round((value - whole) * 100)
  if (paise === 0) return [String(whole), '']
  return [String(whole), String(paise).padStart(2, '0')]
}

/** Returns rows in the exact order and shape expected by the designer sheet. */
export function buildOfferSheetRows({
  clientName,
  offerTitle,
  offerDate,
  products,
}: {
  clientName?: string | null
  offerTitle?: string | null
  offerDate?: string | null
  products: OfferSheetProduct[]
}): string[][] {
  return [...products]
    .sort((a, b) => (a.page || 1) - (b.page || 1) || (a.display_order || 0) - (b.display_order || 0))
    .map(product => {
      const [priceWhole, pricePaise] = splitPrice(product.price)
      return [
        String(product.page || 1),
        String((product.display_order || 0) + 1),
        product.name || '',
        product.weight || '',
        product.offer_type || 'price',
        product.price == null ? '' : String(product.price),
        product.mrp == null ? '' : String(product.mrp),
        offerText(product),
        (product.badges || []).map(badgeLabel).filter(Boolean).join(', '),
        product.image_url || '',
        offerTitle || '',
        offerDate || '',
        clientName || '',
        priceWhole,
        pricePaise,
      ]
    })
}

/** Browser-friendly TSV for direct paste into Google Sheets or Excel. */
export function offerSheetTsv(rows: string[][], includeHeaders = true): string {
  const escapeCell = (value: string) => String(value).replace(/[\t\r\n]+/g, ' ').trim()
  const table = includeHeaders ? [Array.from(OFFER_SHEET_HEADERS), ...rows] : rows
  return table.map(row => row.map(escapeCell).join('\t')).join('\n')
}

/**
 * RFC-4180 CSV for a downloadable file (Google Sheets / Excel import) when the
 * webhook sync is unavailable. Same rows and frozen columns as the TSV/sheet —
 * only the delimiter and quoting differ. Cells containing a comma, quote, or
 * newline are wrapped in double quotes with embedded quotes doubled.
 */
export function offerSheetCsv(rows: string[][], includeHeaders = true): string {
  const escapeCell = (value: string) => {
    let cell = String(value ?? '')
    // CSV-injection guard: a downloaded CSV is opened/imported into a spreadsheet,
    // so a cell that could be read as a formula (starts with = + - @, or a tab/CR)
    // gets a leading apostrophe forcing it to text. Numeric columns are produced by
    // String(number) and never start with these, so real offer data is untouched.
    if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`
    return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
  }
  const table = includeHeaders ? [Array.from(OFFER_SHEET_HEADERS), ...rows] : rows
  return table.map(row => row.map(escapeCell).join(',')).join('\r\n')
}
