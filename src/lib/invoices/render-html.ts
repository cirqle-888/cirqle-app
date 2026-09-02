/**
 * Invoice → printable/standalone HTML renderer.
 *
 * Single source of truth for the professional invoice layout. Used by:
 *   - the Invoices page (print + live preview), via a thin delegate
 *   - the public hosted invoice page (/i/[token]) clients open to view/download
 *   - the Download PDF pipeline (lib/invoices/download-pdf.ts), which measures
 *     and re-composes these blocks into discrete A4 pages so table rows never
 *     split across page boundaries
 *
 * Pure: takes the invoice row + company_settings map and returns HTML strings.
 * No React, no browser-only globals (qrcode is isomorphic), so it runs in a
 * Server Component too.
 */
import QRCode from 'qrcode'
import { getCurrencySymbol } from '@/lib/calculations/currency'
import { formatBillingPeriod, compareInvoiceItems } from '@/lib/utils/invoice'
import { resolveBrandingUrl } from '@/lib/utils/branding'
import type { AgreementBreakdown } from '@/lib/packages/invoice-breakdown'
import type { Currency } from '@/types'
import { unitPriceOf } from './line-math'
import { showServiceColumn } from './service-column'

function escapeHtml(unsafe: string | null | undefined, keepNewlines = false): string {
  if (!unsafe) return ''
  const escaped = String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
  return keepNewlines ? escaped.replace(/\n/g, '<br/>') : escaped
}

/** Darken (f<1) a hex color by multiplying channels. */
export function shadeHex(hex: string, f: number): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return hex
  return '#' + [0, 2, 4].map(i => {
    const v = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * f)))
    return v.toString(16).padStart(2, '0')
  }).join('')
}
/** Tint a hex color toward white by fraction f (0..1). */
export function tintHex(hex: string, f: number): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return hex
  return '#' + [0, 2, 4].map(i => {
    const c = parseInt(h.slice(i, i + 2), 16)
    const v = Math.max(0, Math.min(255, Math.round(c + (255 - c) * f)))
    return v.toString(16).padStart(2, '0')
  }).join('')
}
/** Decorative layers can be viewport-fixed (print) or page-div-absolute (PDF pages). */
export type DecorLayerPos = 'fixed' | 'absolute'

export interface PageDecor {
  /** dots/diagonal pattern css for the page background ('' otherwise) */
  bgCss: string
  /** shade/custom-image styles bleed to the paper edge (zero @page margin) */
  fullBleed: boolean
  bgTop: (pos: DecorLayerPos) => string
  bgBottom: (pos: DecorLayerPos) => string
  cornerSvg: (pos: DecorLayerPos) => string
}

/**
 * The branded page decoration (silk-shade waves / corner accent / dot patterns
 * / custom top+bottom images) driven by the invoice design settings. Shared by
 * every A4 export that must look like an invoice — invoices themselves and the
 * Social Media Plan PDF — so the "top and bottom design" can never drift
 * between document types.
 */
export function buildPageDecor(companySettings: Record<string, string>): PageDecor {
  const NAVY       = companySettings.invoice_primary_color || '#1a2744'
  const NAVY_LIGHT = companySettings.invoice_accent_color  || '#243459'
  const bgStyle    = companySettings.invoice_bg_style || 'none'

  const bgCss = bgStyle === 'dots'
    ? `background-image:radial-gradient(circle,${NAVY}1a 1.5px,transparent 1.5px);background-size:18px 18px;`
    : bgStyle === 'diagonal'
    ? `background-image:repeating-linear-gradient(45deg,${NAVY}12 0px,${NAVY}12 1px,transparent 1px,transparent 16px);`
    : ''

  const cornerSvg = (pos: DecorLayerPos) => bgStyle === 'corner'
    ? `<svg style="position:${pos};top:0;right:0;width:180px;height:180px;pointer-events:none;z-index:0" viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg">
         <path d="M180 0 L180 180 L0 0 Z" fill="${NAVY}" opacity="0.07"/>
         <path d="M180 0 L180 120 L60 0 Z" fill="${NAVY}" opacity="0.07"/>
       </svg>`
    : ''

  // Silk Shade — layered flowing silk-wave ribbons hugging the top & bottom
  // page edges (multiple translucent layers + white highlight streaks, blurred)
  const ACC = NAVY_LIGHT
  const shadeTopSvg = (pos: DecorLayerPos) =>
    `<svg style="position:${pos};top:0;left:0;width:100%;height:190px;pointer-events:none;z-index:0" viewBox="0 0 800 190" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
         <defs>
           <linearGradient id="wgT" x1="0" y1="0" x2="1" y2="0.25">
             <stop offset="0" stop-color="${ACC}" stop-opacity="0.20"/>
             <stop offset="0.45" stop-color="${ACC}" stop-opacity="0.08"/>
             <stop offset="0.8" stop-color="${ACC}" stop-opacity="0.18"/>
             <stop offset="1" stop-color="${ACC}" stop-opacity="0.07"/>
           </linearGradient>
           <filter id="wbT1" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>
           <filter id="wbT2" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="2.6"/></filter>
         </defs>
         <g filter="url(#wbT1)">
           <path d="M0 0 H800 V112 C696 158 588 104 470 118 C338 134 222 84 124 120 C72 140 28 132 0 150 Z" fill="url(#wgT)"/>
           <path d="M0 0 H800 V72 C688 124 556 56 424 80 C292 104 168 50 0 104 Z" fill="${ACC}" opacity="0.09"/>
           <path d="M0 0 H800 V34 C648 70 472 26 326 48 C204 66 86 30 0 58 Z" fill="${ACC}" opacity="0.12"/>
           <path d="M800 0 V92 C744 66 668 36 596 6 C664 2 744 0 800 0 Z" fill="${ACC}" opacity="0.16"/>
           <path d="M0 0 H132 C88 28 38 42 0 38 Z" fill="${ACC}" opacity="0.13"/>
         </g>
         <g filter="url(#wbT2)">
           <path d="M0 112 C156 150 348 88 540 110 C664 124 752 102 800 114 L800 121 C752 109 664 131 540 117 C348 95 156 158 0 119 Z" fill="#ffffff" opacity="0.85"/>
           <path d="M0 66 C196 112 416 36 624 70 C700 82 764 68 800 76 L800 83 C764 75 700 89 624 77 C416 43 196 119 0 73 Z" fill="#ffffff" opacity="0.65"/>
           <path d="M30 88 C220 124 430 60 640 88 L640 92 C430 64 220 129 30 92 Z" fill="${ACC}" opacity="0.18"/>
         </g>
       </svg>`
  const shadeBottomSvg = (pos: DecorLayerPos) =>
    `<svg style="position:${pos};bottom:0;left:0;width:100%;height:200px;pointer-events:none;z-index:0" viewBox="0 0 800 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
         <defs>
           <linearGradient id="wgB" x1="0" y1="1" x2="1" y2="0.7">
             <stop offset="0" stop-color="${ACC}" stop-opacity="0.18"/>
             <stop offset="0.5" stop-color="${ACC}" stop-opacity="0.07"/>
             <stop offset="1" stop-color="${ACC}" stop-opacity="0.22"/>
           </linearGradient>
           <filter id="wbB1" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>
           <filter id="wbB2" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="2.6"/></filter>
         </defs>
         <g filter="url(#wbB1)">
           <path d="M0 200 H800 V96 C676 56 556 116 432 96 C296 74 178 124 84 92 C48 80 18 88 0 72 Z" fill="url(#wgB)"/>
           <path d="M0 200 H800 V136 C672 96 540 152 408 130 C276 108 150 156 0 116 Z" fill="${ACC}" opacity="0.08"/>
           <path d="M0 200 H800 V170 C640 138 460 178 318 158 C198 142 84 172 0 150 Z" fill="${ACC}" opacity="0.12"/>
           <path d="M800 200 V104 C740 134 656 166 576 196 C648 200 740 200 800 200 Z" fill="${ACC}" opacity="0.18"/>
           <path d="M0 200 H148 C96 168 40 152 0 158 Z" fill="${ACC}" opacity="0.14"/>
         </g>
         <g filter="url(#wbB2)">
           <path d="M0 130 C168 92 372 152 568 126 C684 110 756 130 800 118 L800 125 C756 137 684 117 568 133 C372 159 168 99 0 137 Z" fill="#ffffff" opacity="0.85"/>
           <path d="M40 158 C240 122 450 182 660 150 L660 154 C450 187 240 127 40 162 Z" fill="${ACC}" opacity="0.18"/>
           <path d="M0 178 C200 146 420 196 636 168 C700 160 760 172 800 162 L800 169 C760 179 700 167 636 175 C420 203 200 153 0 185 Z" fill="#ffffff" opacity="0.6"/>
         </g>
       </svg>`

  // Branding assets are stored as `storage:bucket/path` refs, which no browser
  // can load — they must be expanded to a public URL first. The bucket is
  // public and returns `access-control-allow-origin: *`, so a plain remote URL
  // is safe for the html2canvas rasterisation too.
  const bgTopUrl = resolveBrandingUrl(companySettings.invoice_bg_image_top_url)
  const bgBottomUrl = resolveBrandingUrl(companySettings.invoice_bg_image_bottom_url)
  const customTopImg = (pos: DecorLayerPos) => bgTopUrl
    ? `<img src="${bgTopUrl}" style="position:${pos === 'fixed' ? 'absolute' : pos};top:0;left:0;width:100%;height:auto;pointer-events:none;z-index:0;display:block;" />`
    : ''
  const customBottomImg = (pos: DecorLayerPos) => bgBottomUrl
    ? `<img src="${bgBottomUrl}" style="position:${pos === 'fixed' ? 'absolute' : pos};bottom:0;left:0;width:100%;height:auto;pointer-events:none;z-index:0;display:block;" />`
    : ''

  const bgTop = (pos: DecorLayerPos) =>
    bgStyle === 'shade' ? shadeTopSvg(pos)
    : bgStyle === 'custom_images' ? customTopImg(pos)
    : ''
  const bgBottom = (pos: DecorLayerPos) =>
    bgStyle === 'shade' ? shadeBottomSvg(pos)
    : bgStyle === 'custom_images' ? customBottomImg(pos)
    : ''

  const fullBleed = bgStyle === 'shade' || bgStyle === 'custom_images'

  return { bgCss, fullBleed, bgTop, bgBottom, cornerSvg }
}

/** Sync QR SVG (errorCorrection H so the centre badge can overlay). */
function qrSvgBlock(text: string, accent: string, size = 104): string {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'H' })
    const n = qr.modules.size
    const cell = size / n
    let rects = ''
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.modules.get(r, c)) {
          rects += `<rect x="${(c * cell).toFixed(2)}" y="${(r * cell).toFixed(2)}" width="${(cell + 0.05).toFixed(2)}" height="${(cell + 0.05).toFixed(2)}"/>`
        }
      }
    }
    const b = size / 2
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="#ffffff"/>
      <g fill="#161616">${rects}</g>
      <rect x="${b - 13}" y="${b - 13}" width="26" height="26" rx="7" fill="${accent}" stroke="#ffffff" stroke-width="2.5"/>
      <text x="${b}" y="${b + 5.5}" text-anchor="middle" font-size="15" font-weight="bold" fill="#ffffff" font-family="Arial, sans-serif">&#8377;</text>
    </svg>`
  } catch {
    return ''
  }
}

const balanceDue = (inv: any): number => Math.max(0, (inv.total_amount ?? 0) - (inv.paid_amount ?? 0))

export interface InvoiceRenderOpts {
  autoprint?: boolean
  // otherOutstanding: live-computed sum of the client's OTHER sent/partial/overdue
  // invoices, for a "share one PDF that shows everything they owe" use case.
  // Deliberately NOT persisted anywhere — purely a render-time addition, kept as
  // its own clearly-labeled line rather than folded into this invoice's own
  // "Total Payable", so the printed amount for THIS invoice never gets confused
  // with the client's total outstanding across all invoices.
  otherOutstanding?: number
  // forRaster: the caller will rasterize this HTML with html2canvas (the Download
  // PDF pipeline), which does NOT support -webkit-background-clip:text. When set,
  // the gradient-filled thank-you text is flattened to a solid brand colour so it
  // renders as text, not solid boxes. Preview / Print (real browser rendering)
  // leave it off and keep the gradient.
  forRaster?: boolean
  // agreements: what each package fee actually covered, for an "Included in your
  // agreement" block. Display only — these tasks are deliberately UNPRICED here.
  // They carry internal work values (often in a different currency to the
  // invoice), and printing those as amounts would both misstate the currency and
  // bill the client twice over for work the fee already paid for.
  agreements?: AgreementBreakdown[]
}

/** Decorative layers can be viewport-fixed (print) or page-div-absolute (PDF pages). */
type LayerPos = 'fixed' | 'absolute'

/**
 * Route a remote logo through our own origin (see src/app/api/invoice-logo).
 * The logo is the one asset that needs this: it lives on cirqle.work, which
 * sends no CORS header, so a crossorigin="anonymous" request there fails and
 * the canvas rasterisation loses it. Other branding assets sit in the public
 * `company-branding` bucket (allow-origin: *) and load directly once
 * resolveBrandingUrl has expanded their `storage:` ref. data: URIs are already
 * inline and are returned untouched.
 */
function resolveLogoUrl(url: string): string {
  if (!url) return ''
  return /^https?:\/\//.test(url) ? '/api/invoice-logo' : url
}

export interface InvoiceRenderParts {
  inv: any
  co: { name: string; phone: string; website: string; tagline: string; holder: string; account: string; ifsc: string; upi: string; logoUrl: string; footerText: string }
  NAVY: string
  NAVY_LIGHT: string
  CELL_BORD: string
  FONT: string
  bgStyle: string
  /** dots/diagonal pattern css for the page background ('' otherwise) */
  bgCss: string
  fullBleed: boolean
  pageMargin: string
  bodyPad: string
  fontLinks: string
  /** page-1 header: logo/name/tagline + contact + invoice meta + INVOICE title + bill-to */
  headerBlock: string
  /** compact continuation header for pages 2+ (logo, name, invoice/client/date, Page X of Y, accent rule) */
  contHeader: (page: number, totalPages: number) => string
  /** continuation footer for every page except the last (brand line + Page X of Y + Continued →) */
  contFooter: (page: number, totalPages: number) => string
  /** wraps row html in the items table (with the repeated gradient thead) */
  itemsTable: (rowsHtml: string) => string
  /** one html string per item row, in display order (sorted by task date) */
  itemRows: string[]
  emptyRow: string
  expensesBlock: string
  /** "Included in your agreement" — covered work, listed without prices. */
  agreementBlock: string
  totalsBlock: string
  notesBlock: string
  /** payment info | QR | thank-you footer (margin-top:auto, pinned to page bottom) */
  footerBlock: string
  /** bottom brand strip; optional right-side extra (e.g. "Page N of N") */
  brandStrip: (rightExtra?: string) => string
  cornerSvg: (pos: LayerPos) => string
  /** top decorative layer (silk shade svg / custom top image), '' when none */
  bgTop: (pos: LayerPos) => string
  /** bottom decorative layer, '' when none */
  bgBottom: (pos: LayerPos) => string
  autoprintScript: string
}

export function buildInvoiceParts(
  inv: any,
  companySettings: Record<string, string>,
  opts?: InvoiceRenderOpts,
): InvoiceRenderParts {
  // Company info + design from settings
  const co = {
    name:    companySettings.company_name    || 'cirqle',
    phone:   companySettings.company_phone   || '',
    website: companySettings.company_website || '',
    tagline: companySettings.company_tagline || 'Creative & Marketing Solutions',
    holder:  companySettings.bank_holder     || '',
    account: companySettings.bank_account    || '',
    ifsc:    companySettings.bank_ifsc       || '',
    upi:     companySettings.bank_upi        || '',
    // A remote logo is served through our own origin — the <img> below carries
    // crossorigin="anonymous" for the PDF canvas, and a CORS request to the
    // asset host fails, which is what left the preview and the downloaded PDF
    // with no logo. A data: URI needs no request and is used as-is.
    logoUrl: resolveLogoUrl(companySettings.logo_url_light || companySettings.logo_url || ''),
    footerText: companySettings.invoice_footer_text || 'Thank you for your Business!',
  }
  const showLogo       = companySettings.invoice_show_logo        !== 'false'
  const showName       = companySettings.invoice_show_company_name !== 'false'
  const showTagline    = companySettings.invoice_show_tagline     !== 'false'
  const showPayInfo    = companySettings.invoice_show_payment_info !== 'false'
  const showContact    = companySettings.invoice_show_phone       !== 'false'
  const showQr         = companySettings.invoice_show_qr          !== 'false'
  const bgStyle        = companySettings.invoice_bg_style || 'none'

  const NAVY       = companySettings.invoice_primary_color || '#1a2744'
  const NAVY_LIGHT = companySettings.invoice_accent_color  || '#243459'
  const FONT       = companySettings.invoice_font          || "'Airbnb Cereal App', Arial, Helvetica, sans-serif"
  const sortedItems = [...(inv.items || [])].sort(compareInvoiceItems)
  const subtotal = inv.subtotal || ((inv.total_amount || 0) + (inv.discount_amount || 0) - (inv.tax_amount || 0) - (inv.previous_balance || 0))
  const prevBal  = inv.previous_balance || 0
  const discount = inv.discount_amount || 0
  const taxAmt   = inv.tax_amount || 0
  const totalPayable = inv.total_amount || 0
  const otherOutstanding = opts?.otherOutstanding || 0
  const forRaster = !!opts?.forRaster

  // Format date as DD/MM/YYYY (header meta)
  function dd(d?: string) {
    if (!d) return ''
    const dt = new Date(d + 'T00:00:00')
    return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`
  }
  // Format date as DD-Mon-YYYY (table rows, matches reference)
  function ddMon(d?: string) {
    if (!d) return ''
    const dt = new Date(d + 'T00:00:00')
    const mon = dt.toLocaleDateString('en-GB', { month: 'short' })
    return `${String(dt.getDate()).padStart(2,'0')}-${mon}-${dt.getFullYear()}`
  }
  /**
   * Money, or a dash when there is no number to show.
   *
   * The null branch is not defensive padding — it is reachable. Roles without
   * billing.view_line_pricing get `unit_price` DELETED from every item by
   * stripInvoiceAmounts, and this function was then called on undefined:
   * `undefined.toLocaleString` threw, React unmounted the page to its error
   * boundary, and the invoice screen died the moment such a user opened a
   * preview. A formatter must never be the thing that takes a page down.
   *
   * Rendering '—' is the honest output, and the caller is responsible for not
   * SENDING a document full of them — see canSharePdf in invoices-client.
   */
  function inr(n: number | null | undefined, c = inv.currency || 'INR') {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    return getCurrencySymbol(c as Currency) + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  // Derived design tokens (reference look, brand-driven)
  const ALT_ROW   = tintHex(NAVY_LIGHT, 0.94)         // pale lavender alternate rows
  const HEAD_TOP  = NAVY                              // table header gradient top
  const HEAD_BOT  = shadeHex(NAVY, 0.55)              // table header gradient bottom
  const CELL_BORD = tintHex(NAVY_LIGHT, 0.82)         // faint column/row borders

  // Expense items — rendered as a separate "Expenses" section after the item table.
  // Display mode (A/B/C) controls what the client sees; internal costs are never shown in A or C.
  const expenseItems = inv.expense_items || []
  // Per-invoice override → company default → 'mode_a'
  const expensesMode = inv.expenses_mode || companySettings.expense_display_mode || 'mode_a'
  // Optional Service column: this invoice's override, else the client's rule.
  const withService = showServiceColumn(inv, inv.client)
  const SERVICE_COL_W = 150
  /**
   * Where a line's service actually lives.
   *
   * Almost nowhere on invoice_items: NOT ONE row in production carries
   * service_id, because the auto-collect path files the task and lets the
   * task hold the service. So the line's own service_id is only ever set by
   * hand, and the task behind it is the real source — which is why this
   * column printed blank for every invoice until the fallback existed.
   */
  const serviceNameOf = (
    it: { service?: { name?: string | null } | null; task?: { service?: { name?: string | null } | null } | null },
  ): string => it.service?.name || it.task?.service?.name || ''
  const ROW_H = 38
  const td = (extra: string) => `height:${ROW_H}px;padding:0 10px 8px 10px;line-height:${ROW_H - 8}px;border-bottom:1px solid ${CELL_BORD};border-left:1px solid ${CELL_BORD};font-size:13px;${extra}`

  // Build task item rows
  const itemRows = sortedItems.map((it, idx) => {
    // Task lines date from their task; lines with no task carry their own
    // line_date instead.
    const rowDate = it.task?.task_date || it.line_date
    const taskDate = rowDate ? ddMon(rowDate) : ''
    const bg = idx % 2 === 1 ? ALT_ROW : '#ffffff'
    return `
      <tr style="background:${bg};height:${ROW_H}px">
        <td style="${td('border-left:none;text-align:center;color:#222')}">${idx + 1}</td>
        <td style="${td('text-align:center;color:#222;white-space:nowrap')}">${taskDate}</td>
        <td style="${td('text-align:left;color:#222')}">${escapeHtml(it.description, true)}</td>
        ${withService ? `<td style="${td('text-align:left;color:#444')}">${escapeHtml(serviceNameOf(it), true)}</td>` : ''}
        <td style="${td('text-align:center;color:#222')}">${it.quantity}</td>
        <td style="${td('text-align:center;color:#222;white-space:nowrap')}">${inr(unitPriceOf(it))}</td>
        <td style="${td('text-align:right;color:#111;font-weight:700;white-space:nowrap')}">${inr(it.total)}</td>
      </tr>`
  })
  const emptyRow = `<tr><td colspan="${withService ? 7 : 6}" style="padding:20px;text-align:center;color:#999;font-size:12px">No items</td></tr>`

  // Expenses section block (separate from main item table in all modes)
  const expensesTotal = expenseItems.reduce((s: number, e: any) => s + (e.amount || 0), 0)
  const expensesBlock = expenseItems.length > 0 ? (() => {
    const EXP_H = 36
    const expRows = expenseItems.map((exp: any, i: number) => {
      const bg = i % 2 === 1 ? ALT_ROW : '#ffffff'
      const tdE = `height:${EXP_H}px;padding:0 10px 8px 10px;line-height:${EXP_H - 8}px;border-bottom:1px solid ${CELL_BORD};font-size:12.5px;`
      const hasMarkup = exp.markup_type !== 'none' && (exp.markup_amount || 0) > 0

      if (expensesMode === 'mode_b' && hasMarkup) {
        return `<tr style="background:${bg}">
          <td style="${tdE}color:#222">
            <div style="font-weight:600">${escapeHtml(exp.description)}</div>
            <table style="margin-top:4px;font-size:11px;color:#666;border-collapse:collapse">
              <tr><td style="padding:1px 0">Cost</td><td style="padding:1px 8px">:</td><td style="text-align:right">${inr(exp.original_amount || 0)}</td></tr>
              <tr><td style="padding:1px 0">Markup</td><td style="padding:1px 8px">:</td><td style="text-align:right">${inr(exp.markup_amount || 0)}</td></tr>
            </table>
          </td>
          <td style="${tdE}border-left:1px solid ${CELL_BORD};font-weight:700;text-align:right;white-space:nowrap">${inr(exp.amount)}</td>
        </tr>`
      }
      if (expensesMode === 'mode_c') {
        return `<tr style="background:${bg}">
          <td style="${tdE}color:#222">
            <div style="font-weight:600">${escapeHtml(exp.description)}</div>
            <div style="font-size:10.5px;color:#888;margin-top:2px;font-style:italic">Reimbursable Expense</div>
          </td>
          <td style="${tdE}border-left:1px solid ${CELL_BORD};font-weight:700;text-align:right;white-space:nowrap">${inr(exp.amount)}</td>
        </tr>`
      }
      // Mode A (default): description + billing amount only
      return `<tr style="background:${bg};height:${EXP_H}px">
        <td style="${tdE}color:#222">${escapeHtml(exp.description)}</td>
        <td style="${tdE}border-left:1px solid ${CELL_BORD};font-weight:700;text-align:right;white-space:nowrap">${inr(exp.amount)}</td>
      </tr>`
    }).join('')
    return `
  <div style="margin-top:18px">
    <div style="font-weight:700;font-size:13px;color:${NAVY};margin-bottom:6px;padding-bottom:5px;text-transform:uppercase;letter-spacing:0.05em">Expenses</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid ${CELL_BORD}">
      <thead>
        <tr style="background:linear-gradient(to bottom,${HEAD_TOP},${HEAD_BOT});height:${EXP_H}px">
          <th style="height:${EXP_H}px;padding:0 10px 8px 10px;line-height:${EXP_H - 8}px;text-align:left;color:#fff;font-size:12.5px;font-weight:700">Description</th>
          <th style="height:${EXP_H}px;padding:0 10px 8px 10px;line-height:${EXP_H - 8}px;text-align:right;color:#fff;font-size:12.5px;font-weight:700;white-space:nowrap;border-left:2px solid #fff">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${expRows}
        <tr style="background:#f8f8f8;height:${EXP_H}px">
          <td style="height:${EXP_H}px;padding:0 10px 8px 10px;line-height:${EXP_H - 8}px;font-size:12.5px;font-weight:700;color:#111;text-align:right">Expenses Total</td>
          <td style="height:${EXP_H}px;padding:0 10px 8px 10px;line-height:${EXP_H - 8}px;border-left:1px solid ${CELL_BORD};font-size:13px;font-weight:700;text-align:right;white-space:nowrap">${inr(expensesTotal)}</td>
        </tr>
      </tbody>
    </table>
  </div>`
  })() : ''

  // ── "Included in your agreement" ───────────────────────────────────────────
  //
  // A package fee replaces the task lines it covers, so without this the client
  // reads "Social Media Management — AED 400" against a blank space and cannot
  // tell what they got for it. Rows are deliberately UNPRICED: the covered tasks
  // carry internal work values, often in another currency, and showing those as
  // money would both misstate the amount and imply a second charge.
  const agreements = opts?.agreements || []
  const agreementBlock = agreements.length > 0 ? (() => {
    const A_H = 30
    const tdA = `height:${A_H}px;padding:0 10px 7px 10px;line-height:${A_H - 7}px;border-bottom:1px solid ${CELL_BORD};font-size:12.5px;`
    const sections = agreements.map(ag => {
      const rows = ag.covered.map((t, i) => `
        <tr style="background:${i % 2 === 1 ? ALT_ROW : '#ffffff'};height:${A_H}px">
          <td style="${tdA}border-left:none;text-align:center;color:#555;width:36px">${i + 1}</td>
          <td style="${tdA}border-left:1px solid ${CELL_BORD};text-align:center;color:#222;white-space:nowrap;width:110px">${t.taskDate ? ddMon(t.taskDate) : ''}</td>
          <td style="${tdA}border-left:1px solid ${CELL_BORD};text-align:left;color:#222">${escapeHtml(t.title)}</td>
          <td style="${tdA}border-left:1px solid ${CELL_BORD};text-align:right;color:#1d9a52;font-weight:700;white-space:nowrap;width:110px">Included</td>
        </tr>`).join('')

      // "5 of 15 Social Media Poster used" — tells the client what remains of
      // what they bought, which the covered list alone doesn't convey.
      const allowance = ag.allowance
        .map(a => `${escapeHtml(a.serviceName)}: ${a.delivered} of ${a.included} used${a.extra > 0 ? ` (+${a.extra} extra, billed above)` : ''}`)
        .join(' &nbsp;·&nbsp; ')

      const feeNote = ag.feeOnThisInvoice
        ? 'Charged on this invoice'
        : 'Already charged — no further fee this period'

      return `
      <div style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:4px">
          <span style="font-weight:700;font-size:12.5px;color:#111">${escapeHtml(ag.packageName)}</span>
          <span style="font-size:11px;color:#666;white-space:nowrap">${feeNote}</span>
        </div>
        ${allowance ? `<div style="font-size:11px;color:#666;margin-bottom:5px">${allowance}</div>` : ''}
        ${rows ? `<table style="width:100%;border-collapse:collapse;border:1px solid ${CELL_BORD}"><tbody>${rows}</tbody></table>` : ''}
      </div>`
    }).join('')

    return `
  <div style="margin-top:18px">
    <div style="font-weight:700;font-size:13px;color:${NAVY};margin-bottom:2px;padding-bottom:5px;text-transform:uppercase;letter-spacing:0.05em">Included in your agreement</div>
    ${sections}
  </div>`
  })() : ''

  const upiString = co.upi ? `upi://pay?pa=${co.upi}&pn=${encodeURIComponent(co.holder)}&cu=INR` : ''

  // Logo: use uploaded image if available, else SVG icon
  const logoBlockSized = (h: number) => showLogo
    ? co.logoUrl
      ? `<img src="${co.logoUrl}" alt="logo" crossorigin="anonymous" style="height:${h}px;object-fit:contain;display:block"/>`
      : `<svg width="${h}" height="${h}" viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg">
           <circle cx="21" cy="21" r="20" fill="none" stroke="${NAVY}" stroke-width="2.5"/>
           <circle cx="21" cy="21" r="14" fill="${NAVY}"/>
           <text x="21" y="26" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">c</text>
         </svg>`
    : ''
  const logoBlock = logoBlockSized(42)

  // Payment information — italic block, reference style
  const payRow = (label: string, value: string) => `
    <tr>
      <td style="font-family:'Open Sans',sans-serif;font-size:11.5px;font-style:italic;color:#222;padding:2.5px 0;white-space:nowrap">${label.replace(/ /g, '<span style="font-style:normal">&nbsp;</span>')}</td>
      <td style="font-family:'Open Sans',sans-serif;padding:2.5px 10px;font-size:11.5px;font-style:italic;color:#222">:</td>
      <td style="font-family:'Open Sans',sans-serif;font-size:11.5px;font-style:italic;font-weight:700;color:#111;white-space:nowrap">${value.replace(/ /g, '<span style="font-style:normal">&nbsp;</span>')}</td>
    </tr>`
  const paymentBlock = showPayInfo && (co.holder || co.account || co.upi) ? `
    <div style="font-family:'Open Sans',sans-serif">
      <div style="font-family:'Open Sans',sans-serif;font-weight:700;font-style:italic;font-size:13.5px;color:#111;margin-bottom:12px;text-decoration:underline;text-underline-offset:3px;letter-spacing:0.3px">Payment&nbsp;Information</div>
      <table style="border-collapse:collapse;font-family:'Open Sans',sans-serif">
        ${co.holder  ? payRow('A/C Holder Name', co.holder) : ''}
        ${co.account ? payRow('A/C Number', co.account) : ''}
        ${co.ifsc    ? payRow('IFSC Code', co.ifsc) : ''}
        ${co.upi     ? payRow('UPI ID', co.upi) : ''}
      </table>
    </div>` : ''

  // QR (encodes the UPI pay link or uses a custom uploaded QR image)
  const customQr = resolveBrandingUrl(companySettings.invoice_qr_image_url)
  const qrBlock = showQr
    ? (customQr ? `<img src="${customQr}" alt="QR Code" crossorigin="anonymous" style="width:104px;height:104px;object-fit:contain;display:block;margin:0 auto"/>` : (upiString ? qrSvgBlock(upiString, NAVY_LIGHT) : ''))
    : ''

  // Thank-you block: gradient from Figma design (#8D66DB→#52117E→#4548A5), fills QR height
  // Split into 3 lines: "Thank you" | "for your" | "Business!" to prevent cropping
  // Gradient-clipped text for real browser rendering; a solid brand purple when
  // rasterizing (html2canvas can't clip a gradient to text → it'd paint boxes).
  const THANK_FILL = forRaster
    ? 'color:#52117E'
    : 'background:linear-gradient(135deg,#8D66DB 0%,#52117E 52%,#4548A5 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text'
  const ftWords = (co.footerText || '').trim().split(/\s+/)
  const line1 = ftWords.length >= 2 ? `${ftWords[0]} ${ftWords[1]}` : (co.footerText || 'Thank you')
  const line2 = ftWords.length > 2 ? ftWords.slice(2, 4).join(' ') : ''  // e.g. "for your"
  const line3 = ftWords.length > 4 ? ftWords.slice(4).join(' ') : ''     // e.g. "Business!"
  const thankBlock = `
    <div style="font-family:'Airbnb Cereal App',${FONT};min-height:104px;display:flex;flex-direction:column;justify-content:center;line-height:1.2;padding-left:30px;padding-bottom:20px">
      <div style="font-size:31px;font-weight:800;${THANK_FILL}">${line1}</div>
      ${line2 ? `<div style="font-size:27px;font-weight:700;${THANK_FILL}">${line2}</div>` : ''}
      ${line3 ? `<div style="font-size:27px;font-weight:700;${THANK_FILL}">${line3}</div>` : ''}
    </div>`

  // Decorative layers come from the shared helper so every invoice-styled A4
  // export (invoices, Social Media Plan PDF, …) renders identical page decor.
  const { bgCss, fullBleed, bgTop, bgBottom, cornerSvg } = buildPageDecor(companySettings)
  // Shade bleeds to the paper edge: zero the @page margin and carry it on the body instead
  const pageMargin = fullBleed ? '0' : '15mm 12mm'
  const bodyPad = '53px 64px 46px'

  // Tagline splits so the last word lands bold on its own line (e.g. "Creative & Marketing" / "Solutions")
  // Special case: if it ends in "What's Next", keep those two words together on the second line.
  const rawTagline = (co.tagline || '').trim()
  let taglineL1 = ''
  let taglineL2 = ''
  const whatsNextMatch = rawTagline.match(/(.*?\s)(What['’]s Next)$/i)
  if (whatsNextMatch) {
    taglineL1 = whatsNextMatch[1].trim()
    taglineL2 = whatsNextMatch[2]
  } else {
    const tagWords = rawTagline.split(/\s+/)
    if (tagWords.length > 1) {
      taglineL1 = tagWords.slice(0, -1).join(' ')
      taglineL2 = tagWords[tagWords.length - 1]
    } else {
      taglineL1 = rawTagline
    }
  }

  // Inline icons — rendered as <img> with data-URI SVGs so html2canvas rasterises
  // them identically to the browser preview (inline SVG elements are unreliable).
  // WhatsApp: official logo (filled). Globe: standard filled-globe icon.
  // encodeURIComponent escapes quotes/angle-brackets so they don't break src="...".
  const waIconSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24"><path fill="#111" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`)
  const globeIconSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24"><path fill="#111" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm-1 17.938A8.015 8.015 0 014 12c0-.34.027-.674.07-1.003L8 14.935V16c0 1.1.9 2 2 2v1.938zm6.906-2.582A1.986 1.986 0 0016 16h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41a8.007 8.007 0 013.906 9.766z"/></svg>`)
  const waIcon = `<img src="data:image/svg+xml,${waIconSvg}" width="17" height="17" style="width:17px;height:17px;display:inline-block;position:relative;top:9px;flex-shrink:0" />`
  const globeIcon = `<img src="data:image/svg+xml,${globeIconSvg}" width="17" height="17" style="width:17px;height:17px;display:inline-block;position:relative;top:9px;flex-shrink:0" />`

  // ── UNIFIED HEADER + CONTACT + META (single table keeps column widths consistent) ──
  const headerBlock = `
  <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
    <tr>
      <td style="vertical-align:top;width:62%;padding-right:16px">
        <!-- Logo + Name + Tagline -->
        <table style="border-collapse:collapse">
          <tr>
            <td style="padding:0;vertical-align:middle">
              ${logoBlock}
            </td>
            ${showName ? `
            <td style="padding:0 0 0 8px;vertical-align:middle">
              <div class="disp" style="font-size:22px;font-weight:800;color:#111;letter-spacing:-0.5px;line-height:1">${co.name}</div>
            </td>` : ''}
            ${showTagline && taglineL1 ? `
            <td style="padding:0 12px;vertical-align:middle">
              <div style="width:1.5px;height:40px;background:#c4c4c4"></div>
            </td>
            <td style="padding:0;vertical-align:middle">
              <div class="disp" style="font-size:16px;line-height:1.25;color:#161616">
                ${taglineL2
                  ? `<div style="font-weight:400">${taglineL1}</div><div style="font-weight:700">${taglineL2}</div>`
                  : `<div style="font-weight:600">${taglineL1}</div>`}
              </div>
            </td>` : ''}
          </tr>
        </table>
        <!-- Phone + Website — same column, guaranteed to fit within 62% -->
        ${showContact && (co.phone || co.website) ? `
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:14px 22px;font-size:13px;font-weight:600;color:#111;margin-top:10px;letter-spacing:0.05px">
          ${co.phone ? `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${waIcon}<a href="tel:${co.phone.replace(/\\D/g, '')}" style="color:inherit;text-decoration:none">${co.phone}</a></span>` : ''}
          ${co.website ? `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${globeIcon}${co.website.replace(/^https?:\/\//, '')}</span>` : ''}
        </div>` : ''}
        <!-- Invoice meta -->
        <table style="border-collapse:collapse;margin-top:18px">
          <tr>
            <td style="font-size:13.5px;font-weight:700;color:#111;padding:2.5px 0;white-space:nowrap">Invoice No.</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 0">${escapeHtml(inv.invoice_number)}</td>
          </tr>
          <tr>
            <td style="font-size:13.5px;font-weight:700;color:#111;padding:2.5px 0">Date</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 0">${dd(inv.issue_date)}</td>
          </tr>
          ${inv.billing_period_start ? `
          <tr>
            <td style="font-size:12.5px;font-weight:700;color:#111;padding:2.5px 0">Period</td>
            <td style="font-size:12.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:12.5px;color:#222;padding:2.5px 0">${formatBillingPeriod(inv.billing_period_start)}</td>
          </tr>` : ''}
          ${inv.due_date ? `
          <tr>
            <td style="font-size:12.5px;font-weight:700;color:#111;padding:2.5px 0">Due Date</td>
            <td style="font-size:12.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:12.5px;font-weight:600;color:#b03030;padding:2.5px 0">${dd(inv.due_date)}</td>
          </tr>` : ''}
        </table>
      </td>
      <td style="vertical-align:top;text-align:right;width:38%">
        <!-- INVOICE title — the accent rule is a separate bar (not border-bottom)
             so html2canvas renders it as a solid 4px block, not a thin underline. -->
        <div style="display:inline-block">
          <div class="disp" style="font-size:33px;font-weight:800;color:#0f0f0f;letter-spacing:0.5px;line-height:1.1;padding-bottom:3px">INVOICE</div>
          <div style="height:4px;background:#0f0f0f;border-radius:1px;margin-top:8px"></div>
        </div>
        <!-- Bill To (below INVOICE in same td, aligned right then left for content) -->
        <div style="margin-top:16px;text-align:left">
          <div style="font-size:14.5px;color:#222">Bill to :</div>
          <div style="font-size:16px;font-weight:700;color:#111;margin-top:3px">${escapeHtml(inv.client?.name || '')}</div>
          ${inv.client?.address ? `<div style="font-size:13px;color:#222;margin-top:2px;line-height:1.5">${escapeHtml(inv.client.address, true)}</div>` : ''}
          ${inv.client?.phone   ? `<div style="font-size:13px;color:#222;margin-top:2px">${escapeHtml(inv.client.phone)}</div>` : ''}
          ${inv.client?.email   ? `<div style="font-size:13px;color:#222">${escapeHtml(inv.client.email)}</div>` : ''}
        </div>
      </td>
    </tr>
  </table>`

  // ── CONTINUATION HEADER (pages 2+) — minimal branded strip: logo/name left,
  //    "(Continued)" label + page counter right, invoice/client/date meta line,
  //    then a brand-gradient accent rule. All HTML, so the accent-to-white
  //    transition rasterizes perfectly clean (no jsPDF overdraw artifacts). ──
  const contHeader = (page: number, totalPages: number) => `
  <div style="margin-bottom:16px">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="vertical-align:middle;padding:0">
          <div style="display:flex;align-items:center">
            ${logoBlockSized(30)}
            ${showName ? `<div class="disp" style="font-size:17px;font-weight:800;color:#111;letter-spacing:-0.3px;margin-left:8px;line-height:1">${co.name}</div>` : ''}
          </div>
        </td>
        <td style="vertical-align:middle;text-align:right;padding:0;white-space:nowrap">
          <div class="disp" style="font-size:14.5px;font-weight:800;color:#0f0f0f;letter-spacing:0.4px">INVOICE <span style="font-weight:600;color:#777">(Continued)</span></div>
          <div style="font-size:11px;color:#888;margin-top:3px">Page ${page} of ${totalPages}</div>
        </td>
      </tr>
    </table>
    <div style="display:flex;flex-wrap:wrap;gap:6px 26px;margin-top:12px;font-size:11.5px;color:#555">
      <span style="white-space:nowrap"><span style="font-weight:700;color:#111">Invoice No.</span>&nbsp;&nbsp;${escapeHtml(inv.invoice_number)}</span>
      <span style="white-space:nowrap"><span style="font-weight:700;color:#111">Client</span>&nbsp;&nbsp;${escapeHtml(inv.client?.name || '')}</span>
      <span style="white-space:nowrap"><span style="font-weight:700;color:#111">Date</span>&nbsp;&nbsp;${dd(inv.issue_date)}</span>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,${NAVY},${NAVY_LIGHT});border-radius:2px;margin-top:12px"></div>
  </div>`

  // ── CONTINUATION FOOTER (all pages except the last) ──
  const contFooter = (page: number, totalPages: number) => `
  <div style="margin-top:auto;border-top:1px solid ${CELL_BORD};padding-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#666">
    <div style="display:flex;align-items:baseline;gap:12px">
      <span style="font-weight:700;color:${NAVY};font-size:11.5px">${co.name}</span>
      ${co.website ? `<span>${co.website}</span>` : ''}
    </div>
    <div>Page ${page} of ${totalPages}</div>
    <div style="font-style:italic;font-weight:600;color:${NAVY}">${page === 1 ? 'Continued on next page &#8594;' : 'Continued &#8594;'}</div>
  </div>`

  // ── ITEMS TABLE (thead repeats on every PDF page that carries rows) ──
  const itemsTable = (rowsHtml: string) => `
  <table style="width:100%;border-collapse:collapse;margin:14px 0 12px">
    <thead>
      <tr style="background:linear-gradient(180deg,${HEAD_TOP} 0%,${HEAD_BOT} 100%);height:${ROW_H}px">
        <th class="disp" style="height:${ROW_H}px;padding:0 8px 8px 8px;line-height:${ROW_H - 8}px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;width:46px">No.</th>
        <th class="disp" style="height:${ROW_H}px;padding:0 8px 8px 8px;line-height:${ROW_H - 8}px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;white-space:nowrap;width:118px">Date</th>
        <th class="disp" style="height:${ROW_H}px;padding:0 8px 8px 8px;line-height:${ROW_H - 8}px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff">Jobs Done</th>
        ${withService ? `<th class="disp" style="height:${ROW_H}px;padding:0 8px 8px 8px;line-height:${ROW_H - 8}px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;width:${SERVICE_COL_W}px">Service</th>` : ''}
        <th class="disp" style="height:${ROW_H}px;padding:0 8px 8px 8px;line-height:${ROW_H - 8}px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;width:54px">Qty</th>
        <th class="disp" style="height:${ROW_H}px;padding:0 8px 8px 8px;line-height:${ROW_H - 8}px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;white-space:nowrap;width:118px">Rate</th>
        <th class="disp" style="height:${ROW_H}px;padding:0 10px 8px 8px;line-height:${ROW_H - 8}px;text-align:right;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;white-space:nowrap;width:130px">Total Amount</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>`

  // ── TOTALS (right block, reference style) ──
  const totalsBlock = `
  <table style="width:100%;border-collapse:collapse;margin-top:6px">
    <tr>
      <td style="width:42%"></td>
      <td style="width:58%">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:1px 8px 9px 8px;font-size:13.5px;color:#222;text-align:right">Total Amount Due</td>
            <td style="padding:1px 6px 9px 6px;font-size:13.5px;color:#222;width:14px">:</td>
            <td style="padding:1px 10px 9px 10px;font-size:13.5px;font-weight:700;color:#111;text-align:right;width:130px;white-space:nowrap">${inr(subtotal)}</td>
          </tr>
          ${discount > 0 ? `
          <tr>
            <td style="padding:1px 8px 9px 8px;font-size:13.5px;color:#222;text-align:right">Discount</td>
            <td style="padding:1px 6px 9px 6px;font-size:13.5px;color:#222">:</td>
            <td style="padding:1px 10px 9px 10px;font-size:13.5px;font-weight:700;color:#1d9a52;text-align:right;white-space:nowrap">- ${inr(discount)}</td>
          </tr>` : ''}
          ${taxAmt > 0 ? `
          <tr>
            <td style="padding:1px 8px 9px 8px;font-size:13.5px;color:#222;text-align:right">Tax (${inv.tax_rate || 0}%)</td>
            <td style="padding:1px 6px 9px 6px;font-size:13.5px;color:#222">:</td>
            <td style="padding:1px 10px 9px 10px;font-size:13.5px;font-weight:700;color:#111;text-align:right;white-space:nowrap">+ ${inr(taxAmt)}</td>
          </tr>` : ''}
          ${prevBal > 0 ? `
          <tr>
            <td style="padding:1px 8px 9px 8px;font-size:13.5px;color:#222;text-align:right">Previous Balance</td>
            <td style="padding:1px 6px 9px 6px;font-size:13.5px;color:#222">:</td>
            <td style="padding:1px 10px 9px 10px;font-size:13.5px;font-weight:700;color:#111;text-align:right;white-space:nowrap">${inr(prevBal)}</td>
          </tr>` : ''}
          <tr>
            <td colspan="3" style="border-top:1.5px solid #9a9a9a;padding:0;height:1px"></td>
          </tr>
          <tr>
            <td class="disp" style="padding:2px 8px 6px 8px;font-size:15.5px;font-weight:700;color:#0f0f0f;text-align:right">Total Payable</td>
            <td class="disp" style="padding:2px 6px 6px 6px;font-size:15.5px;font-weight:700;color:#0f0f0f">:</td>
            <td class="disp" style="padding:2px 10px 6px 10px;font-size:15.5px;font-weight:800;color:#0f0f0f;text-align:right;white-space:nowrap">${inr(totalPayable)}</td>
          </tr>
          ${otherOutstanding > 0 ? `
          <tr>
            <td colspan="3" style="padding-top:8px"></td>
          </tr>
          <tr>
            <td style="padding:5px 8px 12px 8px;font-size:12.5px;font-style:italic;color:#c43c3c;text-align:right">Other Outstanding Invoices</td>
            <td style="padding:5px 6px 12px 6px;font-size:12.5px;color:#c43c3c">:</td>
            <td style="padding:5px 10px 12px 10px;font-size:12.5px;font-weight:700;color:#c43c3c;text-align:right;white-space:nowrap">+ ${inr(otherOutstanding)}</td>
          </tr>
          <tr>
            <td colspan="3" style="border-top:1.5px solid #9a9a9a;padding:0;height:4px"></td>
          </tr>
          <tr>
            <td class="disp" style="padding:6px 8px;font-size:15.5px;font-weight:700;color:#0f0f0f;text-align:right">Total Payable (All Invoices)</td>
            <td class="disp" style="padding:6px 6px;font-size:15.5px;font-weight:700;color:#0f0f0f">:</td>
            <td class="disp" style="padding:6px 10px;font-size:15.5px;font-weight:800;color:#0f0f0f;text-align:right;white-space:nowrap">${inr(totalPayable + otherOutstanding)}</td>
          </tr>` : ''}
        </table>
        ${(inv.paid_amount || 0) > 0 ? `
        <table style="width:100%;border-collapse:collapse;margin-top:6px">
          <tr>
            <td style="padding:2px 8px;font-size:12px;font-style:italic;color:#1d9a52;text-align:right">Amount Received</td>
            <td style="padding:2px 6px;font-size:12px;color:#1d9a52;width:14px">:</td>
            <td style="padding:2px 10px;font-size:12px;font-weight:700;color:#1d9a52;text-align:right;width:130px;white-space:nowrap">${inr(inv.paid_amount || 0)}</td>
          </tr>
          ${balanceDue(inv) > 0 ? `
          <tr>
            <td style="padding:2px 8px;font-size:12.5px;font-style:italic;font-weight:700;color:#c43c3c;text-align:right">Balance Due</td>
            <td style="padding:2px 6px;font-size:12.5px;color:#c43c3c">:</td>
            <td style="padding:2px 10px;font-size:12.5px;font-weight:700;color:#c43c3c;text-align:right;white-space:nowrap">${inr(balanceDue(inv))}</td>
          </tr>` : ''}
        </table>` : ''}
      </td>
    </tr>
  </table>`

  const notesBlock = inv.notes ? `<div style="margin-top:14px;font-size:11.5px;color:#444;font-style:italic">${escapeHtml(inv.notes, true)}</div>` : ''

  // ── FOOTER: payment info | QR | thank-you (pinned to page bottom) ──
  const footerBlock = `
  <div style="margin-top:auto;padding-top:44px;padding-bottom:32px">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="vertical-align:middle;padding:0;width:38%">${paymentBlock}</td>
        <td style="vertical-align:middle;text-align:center;padding:0 10px 0 30px;width:24%">${qrBlock}</td>
        <td style="vertical-align:middle;padding:0;width:38%">${thankBlock}</td>
      </tr>
    </table>
  </div>`

  const brandStrip = (rightExtra?: string) => `
  <div style="border-top:1px solid ${CELL_BORD};padding-top:16px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#666">
    <div style="font-weight:700;color:${NAVY}">${co.name}</div>
    <div style="display:flex;gap:18px">
      ${co.phone ? `<span>${co.phone}</span>` : ''}
      ${co.website ? `<span>${co.website}</span>` : ''}
      ${rightExtra ? `<span>${rightExtra}</span>` : ''}
    </div>
  </div>`

  const fontLinks = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&family=Open+Sans:ital,wght@0,400;0,600;0,700;1,400;1,700&display=swap" rel="stylesheet">`

  const autoprintScript = opts?.autoprint ? `<script>document.fonts.ready.then(function(){setTimeout(function(){window.print()},200)})</script>` : ''

  return {
    inv, co, NAVY, NAVY_LIGHT, CELL_BORD, FONT, bgStyle, bgCss, fullBleed, pageMargin, bodyPad,
    fontLinks, headerBlock, contHeader, contFooter, itemsTable, itemRows, emptyRow,
    expensesBlock, agreementBlock, totalsBlock, notesBlock, footerBlock, brandStrip,
    cornerSvg, bgTop, bgBottom, autoprintScript,
  }
}

/** Single-flow document (print / preview / public hosted page). */
export function renderInvoiceHtml(
  inv: any,
  companySettings: Record<string, string>,
  opts?: InvoiceRenderOpts,
): string {
  const p = buildInvoiceParts(inv, companySettings, opts)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${inv.invoice_number}</title>
  ${p.fontLinks}
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family: ${p.FONT}; color: #222; background:#fff; font-size:13px; ${p.bgCss} }
    .disp { font-family: 'Poppins', ${p.FONT} }
    @page { margin: ${p.pageMargin}; size: A4 portrait }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact } }
  </style>
</head>
<body style="padding:${p.bodyPad};max-width:${p.fullBleed ? '210mm' : '800px'};margin:0 auto;position:relative;min-height:297mm">
  ${p.cornerSvg('fixed')}${p.bgStyle === 'shade' ? p.bgTop('fixed') + p.bgBottom('fixed') : ''}${p.bgStyle === 'custom_images' ? p.bgTop('fixed') + p.bgBottom('fixed') : ''}
  <div style="position:relative;z-index:1;display:flex;flex-direction:column;min-height:${p.fullBleed ? '258mm' : '248mm'}">

  ${p.headerBlock}

  ${p.itemsTable(p.itemRows.join('') || p.emptyRow)}

  ${p.expensesBlock}

  ${p.agreementBlock}

  ${p.totalsBlock}

  ${p.notesBlock}

  ${p.footerBlock}

  ${p.brandStrip()}

  </div>
  ${p.autoprintScript}
</body>
</html>`
}

// ── PAGINATED PDF COMPOSITION ────────────────────────────────────────────────
// The Download PDF pipeline lays the invoice out as discrete A4-proportioned
// pages (800 × 1131 css px ≙ 210 × 297 mm) so html2canvas can rasterize each
// page separately — table rows never split, every page carries its own header/
// footer, and totals + payment info appear only on the last page.

export const PDF_PAGE_W = 800
export const PDF_PAGE_H = 1131  // 800 × 297/210
export const PDF_PAD_TOP = 53
export const PDF_PAD_BOTTOM = 46
export const PDF_PAD_X = 64

const pageHeadCss = (p: InvoiceRenderParts) => `
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family: ${p.FONT}; color: #222; background:#fff; font-size:13px; margin:0 }
    .disp { font-family: 'Poppins', ${p.FONT} }
    .pdf-page { position:relative; width:${PDF_PAGE_W}px; height:${PDF_PAGE_H}px; background:#ffffff; overflow:hidden; ${p.bgCss} }`

/**
 * Off-screen measurement document: every block wrapped in an overflow:hidden
 * (BFC) div so measured heights include the block's own margins. Same width /
 * horizontal padding as the real pages, so text wraps — and rows measure —
 * identically to the final render.
 */
export function renderMeasureHtml(p: InvoiceRenderParts): string {
  const wrap = (key: string, html: string) => html ? `<div data-m="${key}" style="overflow:hidden">${html}</div>` : `<div data-m="${key}" style="overflow:hidden;display:none"></div>`
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>measure</title>
  ${p.fontLinks}
  <style>${pageHeadCss(p)}</style>
</head>
<body style="width:${PDF_PAGE_W}px">
  <div style="padding:0 ${PDF_PAD_X}px">
    ${wrap('header', p.headerBlock)}
    ${wrap('contHeader', p.contHeader(2, 9))}
    ${wrap('table', p.itemsTable(p.itemRows.join('') || p.emptyRow))}
    ${wrap('expenses', p.expensesBlock)}
    ${wrap('agreement', p.agreementBlock)}
    ${wrap('totals', p.totalsBlock)}
    ${wrap('notes', p.notesBlock)}
    ${wrap('footer', p.footerBlock)}
    ${wrap('brand', p.brandStrip('Page 9 of 9'))}
    ${wrap('contFooter', p.contFooter(1, 9))}
  </div>
</body>
</html>`
}

/**
 * Compose the final paginated document. `pageRows` holds the item-row indices
 * for each page (the last entry may be empty — a totals/footer-only page).
 */
export function renderPaginatedInvoiceHtml(p: InvoiceRenderParts, pageRows: number[][]): string {
  const N = pageRows.length
  const pagesHtml = pageRows.map((rows, i) => {
    const isFirst = i === 0
    const isLast = i === N - 1
    const rowsHtml = rows.map(r => p.itemRows[r]).join('')
    // Empty invoice: keep the "No items" placeholder on the (single) page
    const tableHtml = rows.length > 0
      ? p.itemsTable(rowsHtml)
      : (isFirst && p.itemRows.length === 0 ? p.itemsTable(p.emptyRow) : '')
    return `
  <div class="pdf-page">
    ${isFirst ? p.cornerSvg('absolute') + p.bgTop('absolute') : ''}${isLast ? p.bgBottom('absolute') : ''}
    <div style="position:relative;z-index:1;display:flex;flex-direction:column;height:100%;padding:${PDF_PAD_TOP}px ${PDF_PAD_X}px ${PDF_PAD_BOTTOM}px">
      ${isFirst ? p.headerBlock : p.contHeader(i + 1, N)}
      ${tableHtml}
      ${isLast
        ? `${p.expensesBlock}${p.agreementBlock}${p.totalsBlock}${p.notesBlock}${p.footerBlock}${p.brandStrip(N > 1 ? `Page ${N} of ${N}` : '')}`
        : p.contFooter(i + 1, N)}
    </div>
  </div>`
  }).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${p.inv.invoice_number}</title>
  ${p.fontLinks}
  <style>${pageHeadCss(p)}</style>
</head>
<body>
${pagesHtml}
</body>
</html>`
}
