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
  // Ready-to-bind date strings. Every flyer audited had its date hand-typed
  // into Figma and drifted from the data (a one-day offer advertised as three
  // days, a page called "Today" still reading last month). Two styles are
  // emitted so each designer binds whichever matches their layout instead of
  // retyping. Appended last — Price 1/Price 2 keep indices 13/14.
  'Offer Date Display',
  'Offer Date Text',
] as const

/**
 * The Figma layer name that pulls each column in.
 *
 * The Google Sheets Sync plugin fills a layer whose name is `#` + the column
 * name, lowercased with spaces removed — verified against BN MART JULY 2026,
 * whose working `PRODUCT` component contains a text layer named `#product`.
 *
 * Derived from OFFER_SHEET_HEADERS rather than written out, so the help shown
 * to staff can never drift from the columns actually being written.
 */
export function figmaLayerName(header: string): string {
  return '#' + header.toLowerCase().replace(/\s+/g, '')
}

/** Every column paired with the layer name a designer should use. */
export function figmaBindingGuide(): { column: string; layer: string }[] {
  return OFFER_SHEET_HEADERS.map(h => ({ column: h, layer: figmaLayerName(h) }))
}

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

// ── Bindable offer dates ─────────────────────────────────────────────────────

export type OfferDates = {
  date_type?: string | null
  offer_date?: string | null
  offer_date_from?: string | null
  offer_date_to?: string | null
}

type Ymd = { y: number; m: number; d: number }

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Parse a DB date ('YYYY-MM-DD') without going through Date, which would apply
 * the server's timezone and can shift the day across a boundary.
 */
function parseYmd(value?: string | null): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((value || '').trim())
  if (!match) return null
  const [, y, m, d] = match.map(Number) as unknown as [string, number, number, number]
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return { y, m, d }
}

function compareYmd(a: Ymd, b: Ymd): number {
  return a.y - b.y || a.m - b.m || a.d - b.d
}

/**
 * Reduce a campaign's date fields to a single span. A range whose end is
 * missing, equal to its start, or before it collapses to a single day rather
 * than rendering something nonsensical on a printed flyer.
 */
function resolveSpan(dates: OfferDates): { from: Ymd; to: Ymd | null } | null {
  if (dates.date_type === 'range') {
    const from = parseYmd(dates.offer_date_from)
    if (!from) return null
    const to = parseYmd(dates.offer_date_to)
    if (!to || compareYmd(to, from) <= 0) return { from, to: null }
    return { from, to }
  }
  const single = parseYmd(dates.offer_date)
  return single ? { from: single, to: null } : null
}

/**
 * Named date styles. Adding a third is a single entry here plus its column —
 * a per-group `date_format` column already exists to select one if a client
 * ever needs a style these two don't cover.
 */
export const DATE_FORMATS: Record<string, (dates: OfferDates) => string> = {
  /** Enumerated, uppercase: "18, 19, 20 JULY 2026" — the supermarket flyer style. */
  enumerated(dates) {
    const span = resolveSpan(dates)
    if (!span) return ''
    const { from, to } = span
    const month = (m: number) => MONTHS[m - 1].toUpperCase()
    const shortMonth = (m: number) => MONTHS[m - 1].slice(0, 3).toUpperCase()

    if (!to) return `${from.d} ${month(from.m)} ${from.y}`
    if (from.y !== to.y) {
      return `${from.d} ${shortMonth(from.m)} ${from.y} – ${to.d} ${shortMonth(to.m)} ${to.y}`
    }
    if (from.m !== to.m) {
      return `${from.d} ${month(from.m)} – ${to.d} ${month(to.m)} ${to.y}`
    }
    // Same month: list every day for a short offer, otherwise a plain range —
    // "18, 19, 20" reads as a promise of three days; ten enumerated days is noise.
    const days = to.d - from.d + 1
    if (days <= 5) {
      const list = Array.from({ length: days }, (_, i) => from.d + i).join(', ')
      return `${list} ${month(from.m)} ${from.y}`
    }
    return `${from.d} – ${to.d} ${month(from.m)} ${from.y}`
  },

  /** Sentence style: "Offer valid on July 19 2026" / "July 18 – July 20 2026". */
  title(dates) {
    const span = resolveSpan(dates)
    if (!span) return ''
    const { from, to } = span
    const month = (m: number) => MONTHS[m - 1]

    if (!to) return `Offer valid on ${month(from.m)} ${from.d} ${from.y}`
    if (from.y !== to.y) {
      return `${month(from.m)} ${from.d} ${from.y} – ${month(to.m)} ${to.d} ${to.y}`
    }
    return `${month(from.m)} ${from.d} – ${month(to.m)} ${to.d} ${to.y}`
  },
}

/** Returns rows in the exact order and shape expected by the designer sheet. */
export function buildOfferSheetRows({
  clientName,
  offerTitle,
  offerDate,
  dates,
  products,
}: {
  clientName?: string | null
  offerTitle?: string | null
  offerDate?: string | null
  /** Raw campaign dates for the two bindable date columns. Omitted → both blank. */
  dates?: OfferDates | null
  products: OfferSheetProduct[]
}): string[][] {
  const dateDisplay = dates ? DATE_FORMATS.enumerated(dates) : ''
  const dateText = dates ? DATE_FORMATS.title(dates) : ''
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
        dateDisplay,
        dateText,
      ]
    })
}

/**
 * Formula-injection guard. Every destination for these rows (Google Sheets via
 * paste, Sheets via CSV import, Excel) evaluates a cell beginning with = + - @
 * as a formula, so `=IMPORTXML(...)` in a client-supplied product name becomes
 * live code in the designer's sheet. A leading apostrophe forces text.
 *
 * The leading-\s* matters: several importers strip surrounding whitespace and
 * THEN decide whether the cell is a formula, so " =HYPERLINK(...)" is still
 * dangerous even though it doesn't literally start with "=".
 *
 * Numeric columns are produced by String(number) and never match, so real
 * offer data is untouched.
 */
function neutralizeFormula(cell: string): string {
  return /^\s*[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
}

/** Browser-friendly TSV for direct paste into Google Sheets or Excel. */
export function offerSheetTsv(rows: string[][], includeHeaders = true): string {
  const escapeCell = (value: string) =>
    neutralizeFormula(String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim())
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
    const cell = neutralizeFormula(String(value ?? ''))
    return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
  }
  const table = includeHeaders ? [Array.from(OFFER_SHEET_HEADERS), ...rows] : rows
  return table.map(row => row.map(escapeCell).join(',')).join('\r\n')
}
