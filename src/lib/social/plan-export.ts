/**
 * Social Media Plan → professional A4 PDF / Excel exports.
 *
 * The PDF deliberately wears the SAME suit as invoices (src/lib/invoices/
 * render-html.ts + download-pdf.ts): identical fonts, brand colours from
 * company settings, logo + tagline header, gradient table head, alternating
 * rows, brand strip footer, continuation headers and "Page X of Y" — so a
 * client receiving an invoice and a content plan sees one visual identity.
 *
 * Browser-only (hidden iframe + html2canvas + jsPDF), multi-page safe:
 * row heights are measured for real (captions wrap), then whole rows are
 * greedily packed into A4-proportioned pages — the invoice pipeline's exact
 * approach.
 */

import {
  tintHex, shadeHex, buildPageDecor, type PageDecor,
  PDF_PAGE_W, PDF_PAGE_H, PDF_PAD_TOP, PDF_PAD_BOTTOM,
} from '@/lib/invoices/render-html'
import {
  sanitizeCaptionHtml, captionHtmlToText, canvasToText,
  CANVAS_W, type CaptionCanvas,
} from '@/lib/social/plan'

// The Content column's width is pinned by the table's colgroup
// (34 + 60 + 66 + 112 taken by the other four columns), so the board's scale
// is known up front. That determinism matters: the measuring pass and the
// composed page must compute the SAME height or pagination drifts.
const CONTENT_COL_W = (PDF_PAGE_W - 128) - 34 - 60 - 66 - 112
// 8px td padding each side + the 1px collapsed left border, then a 3px safety
// margin — overflowing here would push the board under the Type column.
const CANVAS_BOX_W = CONTENT_COL_W - 16 - 1 - 3
const CANVAS_SCALE = CANVAS_BOX_W / CANVAS_W

/**
 * Reproduce a layout board as absolutely-positioned HTML at a fixed scale.
 * html2canvas rasterises this faithfully, so the client sees the same
 * arrangement the planner dragged out.
 */
function canvasBlockHtml(canvas: CaptionCanvas): string {
  const inner = canvas.blocks
    .slice()
    .sort((a, b) => a.z - b.z)
    .map(b => {
      const box = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;`
      if (b.type === 'image') {
        return `<img src="${esc(b.url)}" crossorigin="anonymous" style="${box}object-fit:cover;border-radius:4px" />`
      }
      return `<div style="${box}font-size:${b.size ?? 14}px;font-weight:${b.bold ? 700 : 400};color:${esc(b.color ?? '#111827')};text-align:${b.align ?? 'left'};line-height:1.3;overflow:hidden">${esc(b.text)}</div>`
    })
    .join('')
  // Outer box reserves the SCALED height; the inner surface is authored at
  // full design size and scaled down from its top-left corner.
  return `
    <div style="position:relative;width:${Math.round(CANVAS_W * CANVAS_SCALE)}px;height:${Math.round(canvas.h * CANVAS_SCALE) + 6}px;padding-top:6px;box-sizing:border-box;overflow:hidden">
      <div style="position:absolute;top:6px;left:0;width:${CANVAS_W}px;height:${canvas.h}px;transform:scale(${CANVAS_SCALE});transform-origin:top left">
        ${inner}
      </div>
    </div>`
}

export interface PlanExportRow {
  date: string          // YYYY-MM-DD (start)
  /** end of a multi-day run; null for single-day items */
  endDate?: string | null
  title: string
  contentType: string   // display label
  platforms: string     // display label, e.g. "IG · FB"
  service: string       // service name or ''
  status: string        // display label, e.g. "Planned" / "In progress"
  caption?: string | null
  /** Reference images (public URLs) — thumbnailed next to the content title. */
  imageUrls?: string[] | null
  /** Free-drag layout board, reproduced to scale inside the Content cell. */
  canvas?: CaptionCanvas | null
}

export interface PlanExportInput {
  clientName: string
  monthLabel: string    // e.g. "July 2026"
  planTitle?: string | null
  rows: PlanExportRow[]
}

/** 'plan' = full month plan; 'report' = delivered-work client report. */
type ExportVariant = 'plan' | 'report'

// Escapes quotes too — these values are interpolated into ATTRIBUTES (img src,
// href) as well as text, and an unescaped " breaks out of the attribute.
const esc = (s: string | null | undefined) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function ddMon(d: string): string {
  const dt = new Date(d + 'T00:00:00')
  if (Number.isNaN(dt.getTime())) return d
  return `${String(dt.getDate()).padStart(2, '0')} ${dt.toLocaleDateString('en-GB', { month: 'short' })}`
}

/** "03 Jul" or "03 Jul – 11 Jul" for the date column. */
function dateCell(r: PlanExportRow): string {
  return r.endDate && r.endDate !== r.date ? `${ddMon(r.date)} – ${ddMon(r.endDate)}` : ddMon(r.date)
}

function fileSlug(input: PlanExportInput, variant: ExportVariant): string {
  return `${input.clientName}-${input.monthLabel}-${variant}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// ─── Excel ─────────────────────────────────────────────────────────────────────

export async function downloadPlanExcel(input: PlanExportInput): Promise<void> {
  const XLSX = await import('xlsx')
  const header = ['Date', 'End date', 'Title', 'Content Type', 'Platforms', 'Service', 'Status', 'Caption / Copy', 'References']
  const data = input.rows.map(r => [
    // Captions may be rich HTML — Excel gets the plain-text projection.
    r.date, r.endDate ?? '', r.title, r.contentType, r.platforms, r.service, r.status,
    // Board labels join the copy so the spreadsheet carries the whole brief.
    [captionHtmlToText(r.caption), canvasToText(r.canvas)].filter(Boolean).join('\n'),
    (r.imageUrls ?? []).join('\n'),
  ])
  const ws = XLSX.utils.aoa_to_sheet([
    [`Social Media Plan — ${input.clientName} — ${input.monthLabel}${input.planTitle ? ` — ${input.planTitle}` : ''}`],
    [],
    header,
    ...data,
  ])
  ws['!cols'] = [
    { wch: 12 }, { wch: 12 }, { wch: 34 }, { wch: 14 }, { wch: 20 }, { wch: 24 }, { wch: 14 }, { wch: 46 }, { wch: 40 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Plan')
  XLSX.writeFile(wb, `${fileSlug(input, 'plan')}.xlsx`)
}

// ─── PDF ───────────────────────────────────────────────────────────────────────

interface PlanPdfParts {
  fontLinks: string
  bodyPad: string
  FONT: string
  /** Silk-shade / custom-image page decoration — the invoice's own layers. */
  decor: PageDecor
  headerBlock: string
  contHeader: (page: number, total: number) => string
  contFooter: (page: number, total: number) => string
  table: (rowsHtml: string) => string
  /** One row alone, with the composed table's exact column widths — the
   *  measuring pass must lay rows out the same way the real pages do. */
  rowTable: (rowHtml: string, attr: string) => string
  rowsHtml: string[]
  summaryBlock: string
  brandStrip: (rightExtra?: string) => string
}

function buildPlanParts(
  input: PlanExportInput,
  companySettings: Record<string, string>,
  variant: ExportVariant = 'plan',
): PlanPdfParts {
  const isReport = variant === 'report'
  const docTitle = isReport ? 'MONTHLY REPORT' : 'SOCIAL MEDIA PLAN'
  const co = {
    name:    companySettings.company_name    || 'Cirqle Works',
    phone:   companySettings.company_phone   || '',
    website: companySettings.company_website || '',
    logoUrl: companySettings.logo_url_light || companySettings.logo_url || '',
  }
  // Same brand tokens the invoice template derives from settings.
  const NAVY       = companySettings.invoice_primary_color || '#1a2744'
  const NAVY_LIGHT = companySettings.invoice_accent_color  || '#243459'
  const FONT       = companySettings.invoice_font          || "'Airbnb Cereal App', Arial, Helvetica, sans-serif"
  const ALT_ROW    = tintHex(NAVY_LIGHT, 0.94)
  const HEAD_TOP   = NAVY
  const HEAD_BOT   = shadeHex(NAVY, 0.55)
  // A notch darker than the invoice's 0.82 tint: this table has more columns
  // and thinner cells, and at 0.82 the grid all but disappeared when rasterised.
  const CELL_BORD  = tintHex(NAVY_LIGHT, 0.68)

  const fontLinks = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&family=Open+Sans:ital,wght@0,400;0,600;0,700;1,400;1,700&display=swap" rel="stylesheet">`

  const logoBlock = (size: number) => co.logoUrl
    ? `<img src="${esc(co.logoUrl)}" crossorigin="anonymous" style="height:${size}px;width:auto;display:block" />`
    : `<div class="disp" style="font-size:22px;font-weight:800;color:#111;letter-spacing:-0.5px">${esc(co.name)}</div>`

  // Same inline data-URI icons the invoice header uses (html2canvas rasterises
  // <img> SVGs reliably; inline <svg> elements are not).
  const waIconSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24"><path fill="#111" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`)
  const globeIconSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24"><path fill="#111" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm-1 17.938A8.015 8.015 0 014 12c0-.34.027-.674.07-1.003L8 14.935V16c0 1.1.9 2 2 2v1.938zm6.906-2.582A1.986 1.986 0 0016 16h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41a8.007 8.007 0 013.906 9.766z"/></svg>`)
  const waIcon = `<img src="data:image/svg+xml,${waIconSvg}" width="17" height="17" style="width:17px;height:17px;display:inline-block;position:relative;top:9px;flex-shrink:0" />`
  const globeIcon = `<img src="data:image/svg+xml,${globeIconSvg}" width="17" height="17" style="width:17px;height:17px;display:inline-block;position:relative;top:9px;flex-shrink:0" />`
  const contactRow = (co.phone || co.website) ? `
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:22px;font-size:12.5px;font-weight:600;color:#111;letter-spacing:0.05px">
          ${co.phone ? `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${waIcon}${esc(co.phone)}</span>` : ''}
          ${co.website ? `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${globeIcon}${esc(co.website.replace(/^https?:\/\//, ''))}</span>` : ''}
        </div>` : ''

  // Page-1 header — logo left / contact right on one band, a brand-gradient
  // rule, a centred title flanked by hairlines (deliberate ornament, not an
  // underline), then the plan facts in a framed panel.
  const metaCell = (label: string, value: string) => `
        <td style="padding:0 26px 0 0;vertical-align:top">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a8a95">${esc(label)}</div>
          <div style="font-size:13.5px;font-weight:600;color:#111;margin-top:3px;white-space:nowrap">${esc(value)}</div>
        </td>`
  const headerBlock = `
  <div style="margin-bottom:12px">
    <div style="display:flex;align-items:center;justify-content:space-between">
      ${logoBlock(44)}
      ${contactRow || '<span></span>'}
    </div>
    <div style="height:3px;background:linear-gradient(90deg,${NAVY},${NAVY_LIGHT},${tintHex(NAVY_LIGHT, 0.55)});border-radius:2px;margin-top:14px"></div>
    <div style="display:flex;align-items:center;gap:18px;margin-top:22px">
      <div style="flex:1;height:1px;background:#d9d9e2"></div>
      <div class="disp" style="font-size:23px;font-weight:800;color:#0f0f0f;letter-spacing:0.14em;white-space:nowrap">${docTitle}</div>
      <div style="flex:1;height:1px;background:#d9d9e2"></div>
    </div>
    <div style="margin-top:18px;border:1px solid ${CELL_BORD};background:${tintHex(NAVY_LIGHT, 0.965)};border-radius:10px;padding:13px 18px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          ${metaCell('Client', input.clientName)}
          ${metaCell('Month', input.monthLabel)}
          ${input.planTitle ? metaCell('Plan', input.planTitle) : ''}
          <td style="vertical-align:top;text-align:right;width:99%">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a8a95">${isReport ? 'Delivered' : 'Items'}</div>
            <div class="disp" style="font-size:13.5px;font-weight:700;color:${NAVY};margin-top:3px;white-space:nowrap">${input.rows.length} ${isReport ? 'items' : 'planned'}</div>
          </td>
        </tr>
      </table>
    </div>
  </div>`

  const contHeader = (page: number, total: number) => `
  <div style="margin-bottom:16px">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="vertical-align:middle;padding:0">
          ${logoBlock(30)}
        </td>
        <td style="vertical-align:middle;text-align:right;padding:0;white-space:nowrap">
          <div class="disp" style="font-size:14.5px;font-weight:800;color:#0f0f0f;letter-spacing:0.4px">${docTitle} <span style="font-weight:600;color:#777">(Continued)</span></div>
          <div style="font-size:11px;color:#888;margin-top:3px">Page ${page} of ${total}</div>
        </td>
      </tr>
    </table>
    <div style="display:flex;flex-wrap:wrap;gap:6px 26px;margin-top:12px;font-size:11.5px;color:#555">
      <span style="white-space:nowrap"><span style="font-weight:700;color:#111">Client</span>&nbsp;&nbsp;${esc(input.clientName)}</span>
      <span style="white-space:nowrap"><span style="font-weight:700;color:#111">Month</span>&nbsp;&nbsp;${esc(input.monthLabel)}</span>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,${NAVY},${NAVY_LIGHT});border-radius:2px;margin-top:12px"></div>
  </div>`

  const contFooter = (page: number, total: number) => `
  <div style="margin-top:auto;border-top:1px solid ${CELL_BORD};padding-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#666">
    <div style="display:flex;align-items:baseline;gap:12px">
      <span style="font-weight:700;color:${NAVY};font-size:11.5px">${esc(co.name)}</span>
      ${co.website ? `<span>${esc(co.website)}</span>` : ''}
    </div>
    <div>Page ${page} of ${total}</div>
    <div style="font-style:italic;font-weight:600;color:${NAVY}">Continued &#8594;</div>
  </div>`

  const ROW_MIN = 36
  const th = (extra: string) => `height:${ROW_MIN}px;padding:0 8px 8px 8px;line-height:${ROW_MIN - 8}px;text-align:left;color:#fff;font-size:12.5px;font-weight:700;${extra}`
  // Column widths live HERE, not only on the <th>, so a table rendered without
  // its head (the measuring pass) still lays out identically. Without this the
  // measured rows auto-size, captions wrap differently, and the heights the
  // paginator packs against don't match what actually renders.
  const COLS = `<colgroup><col style="width:34px" /><col style="width:60px" /><col /><col style="width:66px" /><col style="width:112px" /></colgroup>`
  const TABLE_BOX = `width:100%;border-collapse:collapse;border:1px solid ${CELL_BORD};table-layout:fixed`
  const table = (rowsHtml: string) => `
  <table style="${TABLE_BOX};margin:14px 0 12px">
    ${COLS}
    <thead>
      <tr style="background:linear-gradient(180deg,${HEAD_TOP} 0%,${HEAD_BOT} 100%);height:${ROW_MIN}px">
        <th class="disp" style="${th('text-align:center;width:34px')}">No.</th>
        <th class="disp" style="${th('border-left:2px solid #fff;white-space:nowrap;width:60px')}">Date</th>
        <th class="disp" style="${th('border-left:2px solid #fff')}">Content</th>
        <th class="disp" style="${th('border-left:2px solid #fff;width:66px')}">Type</th>
        <th class="disp" style="${th('border-left:2px solid #fff;width:112px')}">Platforms</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>`

  // One row in isolation, wearing the composed table's exact column widths and
  // box model (minus its vertical margins, which the paginator counts itself).
  const rowTable = (rowHtml: string, attr: string) =>
    `<table ${attr} style="${TABLE_BOX}">${COLS}<tbody>${rowHtml}</tbody></table>`

  const td = (extra: string) => `padding:9px 8px;border-bottom:1px solid ${CELL_BORD};border-left:1px solid ${CELL_BORD};font-size:12px;vertical-align:top;${extra}`
  // Empty cells print an em-dash — a blank cell reads as a mistake on paper.
  const cell = (v: string | null | undefined) => v?.trim() ? esc(v) : '<span style="color:#b6b6c2">&#8212;</span>'
  const rowsHtml = input.rows.map((r, i) => {
    const bg = i % 2 === 1 ? ALT_ROW : '#ffffff'
    // Client-facing: the Content column IS the document — full-width title +
    // caption so the client can picture each planned creative. Internal fields
    // (service, status) stay in the Excel export, not here.
    return `
      <tr style="background:${bg}">
        <td style="${td('border-left:none;text-align:center;color:#222')}">${i + 1}</td>
        <td style="${td('color:#222;white-space:nowrap')}">${dateCell(r)}</td>
        <td style="${td('color:#111')}">
          <div style="display:flex;gap:8px;align-items:flex-start">
            ${(r.imageUrls ?? []).slice(0, 3).map(u => `<img src="${esc(u)}" crossorigin="anonymous" style="width:38px;height:38px;border-radius:6px;object-fit:cover;flex-shrink:0;border:1px solid ${CELL_BORD}" />`).join('')}
            <div style="min-width:0">
              <div style="font-weight:600;font-size:12.5px">${esc(r.title)}</div>
              ${r.caption ? `<div class="cap" style="font-size:11px;color:#666;margin-top:4px;line-height:1.5">${sanitizeCaptionHtml(r.caption)}</div>` : ''}
              ${(r.imageUrls?.length ?? 0) > 3 ? `<div style="font-size:9.5px;color:#999;margin-top:2px">+${(r.imageUrls!.length - 3)} more reference${r.imageUrls!.length - 3 > 1 ? 's' : ''}</div>` : ''}
            </div>
          </div>
          ${r.canvas?.blocks?.length ? canvasBlockHtml(r.canvas) : ''}
        </td>
        <td style="${td('color:#222')}">${cell(r.contentType)}</td>
        <td style="${td('color:#222')}">${cell(r.platforms)}</td>
      </tr>`
  })

  // Per-content-type counts — a compact professional wrap-up for the last page.
  const typeCounts = new Map<string, number>()
  for (const r of input.rows) typeCounts.set(r.contentType, (typeCounts.get(r.contentType) || 0) + 1)
  // Summary card — contained like the invoice's totals block, so the divider
  // and numbers line up instead of floating on the page.
  const summaryBlock = input.rows.length ? `
  <div style="margin-top:8px;display:flex;justify-content:flex-end">
    <div style="min-width:230px;border:1px solid ${CELL_BORD};border-radius:10px;background:#ffffff;padding:12px 16px 11px">
      <table style="width:100%;border-collapse:collapse">
        ${[...typeCounts.entries()].map(([label, n]) => `
        <tr>
          <td style="padding:2.5px 12px 2.5px 0;font-size:12.5px;color:#444;white-space:nowrap">${esc(label)}</td>
          <td style="padding:2.5px 0;font-size:12.5px;font-weight:700;color:#111;text-align:right">${n}</td>
        </tr>`).join('')}
        <tr><td colspan="2" style="border-bottom:1px solid ${CELL_BORD};height:6px;padding:0"></td></tr>
        <tr>
          <td class="disp" style="padding:8px 12px 0 0;font-size:13px;font-weight:700;color:#0f0f0f;white-space:nowrap">${isReport ? 'Total delivered' : 'Total items'}</td>
          <td class="disp" style="padding:8px 0 0;font-size:14px;font-weight:800;color:${NAVY};text-align:right">${input.rows.length}</td>
        </tr>
      </table>
    </div>
  </div>` : ''

  const brandStrip = (rightExtra?: string) => `
  <div style="margin-top:auto;border-top:1px solid ${CELL_BORD};padding-top:16px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#666">
    <div style="font-weight:700;color:${NAVY}">${esc(co.name)}</div>
    <div style="display:flex;gap:18px">
      ${co.phone ? `<span>${esc(co.phone)}</span>` : ''}
      ${co.website ? `<span>${esc(co.website)}</span>` : ''}
      ${rightExtra ? `<span>${rightExtra}</span>` : ''}
    </div>
  </div>`

  return {
    fontLinks, FONT, bodyPad: `${PDF_PAD_TOP}px 64px ${PDF_PAD_BOTTOM}px`,
    decor: buildPageDecor(companySettings),
    headerBlock, contHeader, contFooter, table, rowTable, rowsHtml, summaryBlock, brandStrip,
  }
}

// Every page carries the invoice template's decorative layers (silk-shade
// waves / custom top+bottom images / dot patterns) behind a z-indexed content
// column — identical structure to the invoice's paginated PDF pages.
const pageShell = (parts: PlanPdfParts, inner: string) => `
  <div class="pdf-page" style="position:relative;width:${PDF_PAGE_W}px;height:${PDF_PAGE_H}px;background:#fff;${parts.decor.bgCss}box-sizing:border-box;overflow:hidden;font-family:'Open Sans',${parts.FONT};color:#111">
    ${parts.decor.bgTop('absolute')}
    ${parts.decor.bgBottom('absolute')}
    ${parts.decor.cornerSvg('absolute')}
    <div style="position:relative;z-index:1;height:100%;box-sizing:border-box;padding:${parts.bodyPad};display:flex;flex-direction:column">
      ${inner}
    </div>
  </div>`

// Caption list styles — identical in the measure and compose documents so the
// row heights the paginator reads match what actually renders.
// Covers every tag sanitizeCaptionHtml allowlists — headings and blockquotes
// included. Left to UA defaults they carry huge margins and 2em font sizes,
// which both blow up the row and diverge from the editor's preview.
const CAPTION_CSS = `.cap ul,.cap ol{margin:3px 0 3px 18px;padding:0} .cap ul{list-style:disc} .cap ol{list-style:decimal} .cap li{margin:2px 0} .cap p,.cap div{margin:0}`
  + ` .cap h1,.cap h2,.cap h3{margin:4px 0 2px;font-weight:700;line-height:1.35}`
  + ` .cap h1{font-size:13px} .cap h2{font-size:12.5px} .cap h3{font-size:12px}`
  + ` .cap blockquote{margin:3px 0 3px 8px;padding-left:8px;border-left:2px solid #d9d9e2;color:#555;font-style:italic}`
  + ` .cap a{color:#1a2744;text-decoration:underline}`

function measureHtml(parts: PlanPdfParts): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${parts.fontLinks}
  <style>body{margin:0} .disp{font-family:'Poppins',${parts.FONT}} ${CAPTION_CSS}</style></head>
  <body style="font-family:'Open Sans',${parts.FONT}">
    <div style="width:${PDF_PAGE_W - 128}px">
      <div data-m="header">${parts.headerBlock}</div>
      <div data-m="contHeader">${parts.contHeader(2, 9)}</div>
      <div data-m="thead">${parts.table('')}</div>
      ${parts.rowsHtml.map((r, i) => parts.rowTable(r, `data-m="row-${i}"`)).join('')}
      <div data-m="summary">${parts.summaryBlock}</div>
      <div data-m="brand">${parts.brandStrip('Page 9 of 9')}</div>
      <div data-m="contFooter">${parts.contFooter(1, 9)}</div>
    </div>
  </body></html>`
}

function composeHtml(parts: PlanPdfParts, pages: number[][]): string {
  const total = pages.length
  const pageHtml = pages.map((rowIdxs, p) => {
    const isFirst = p === 0
    const isLast = p === total - 1
    const header = isFirst ? parts.headerBlock : parts.contHeader(p + 1, total)
    const body = rowIdxs.length ? parts.table(rowIdxs.map(i => parts.rowsHtml[i]).join('')) : ''
    const tail = isLast
      ? `${parts.summaryBlock}${parts.brandStrip(`Page ${p + 1} of ${total}`)}`
      : parts.contFooter(p + 1, total)
    return pageShell(parts, `${header}${body}${tail}`)
  }).join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${parts.fontLinks}
  <style>body{margin:0;background:#fff} .disp{font-family:'Poppins',${parts.FONT}} ${CAPTION_CSS}</style></head>
  <body>${pageHtml}</body></html>`
}

async function loadHiddenIframe(html: string): Promise<{ iframe: HTMLIFrameElement; doc: Document }> {
  const iframe = document.createElement('iframe')
  iframe.style.cssText = `position:fixed;top:-99999px;left:-99999px;width:${PDF_PAGE_W}px;border:0;`
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('Could not create render frame')
  doc.open(); doc.write(html); doc.close()
  await new Promise<void>(resolve => {
    const done = () => setTimeout(resolve, 120) // let fonts/layout settle
    if (doc.readyState === 'complete') done()
    else iframe.addEventListener('load', done, { once: true })
  })
  try { await (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready } catch { /* fonts blocked — measure with fallbacks */ }
  return { iframe, doc }
}

/**
 * First page of the plan document as standalone HTML (no measurement pass —
 * every row on one page). Powers design previews and visual tests; the real
 * download path below still measures and paginates properly.
 */
export function previewPlanPageHtml(
  input: PlanExportInput,
  companySettings: Record<string, string>,
): string {
  const parts = buildPlanParts(input, companySettings)
  return composeHtml(parts, [input.rows.map((_, i) => i)])
}

export async function downloadPlanPdf(
  input: PlanExportInput,
  companySettings: Record<string, string>,
): Promise<void> {
  return renderPlanPdf(input, companySettings, 'plan')
}

/**
 * Monthly client REPORT — same suit as the plan PDF, but titled "Monthly
 * Report" and driven by the delivered/completed subset. Callers pass only the
 * done-work rows; this just restyles the header + filename.
 */
export async function downloadReportPdf(
  input: PlanExportInput,
  companySettings: Record<string, string>,
): Promise<void> {
  return renderPlanPdf(input, companySettings, 'report')
}

async function renderPlanPdf(
  input: PlanExportInput,
  companySettings: Record<string, string>,
  variant: ExportVariant,
): Promise<void> {
  const parts = buildPlanParts(input, companySettings, variant)

  // 1. Measure block + per-row heights at the real page width.
  const mFrame = await loadHiddenIframe(measureHtml(parts))
  let m: { header: number; contHeader: number; thead: number; rows: number[]; summary: number; brand: number; contFooter: number }
  try {
    const h = (k: string) => (mFrame.doc.querySelector(`[data-m="${k}"]`) as HTMLElement | null)?.offsetHeight ?? 0
    m = {
      header: h('header'), contHeader: h('contHeader'), thead: h('thead'),
      rows: parts.rowsHtml.map((_, i) => h(`row-${i}`)),
      summary: h('summary'), brand: h('brand'), contFooter: h('contFooter'),
    }
  } finally {
    mFrame.iframe.remove()
  }

  // 2. Greedy whole-row packing (the invoice pipeline's paginateRows shape).
  const inner = PDF_PAGE_H - PDF_PAD_TOP - PDF_PAD_BOTTOM
  const tableChrome = 14 + m.thead + 12 // table margins in table()
  const tail = m.summary + m.brand
  const rowsTotal = m.rows.reduce((s, r) => s + r, 0)
  let pages: number[][]
  if (m.header + tableChrome + rowsTotal + tail <= inner) {
    pages = [m.rows.map((_, i) => i)]
  } else {
    const firstCap = inner - m.header - tableChrome - m.contFooter
    const midCap = inner - m.contHeader - tableChrome - m.contFooter
    pages = []
    let cur: number[] = []
    let capLeft = firstCap
    m.rows.forEach((rh, i) => {
      if (rh > capLeft && cur.length > 0) { pages.push(cur); cur = []; capLeft = midCap }
      cur.push(i); capLeft -= rh
    })
    pages.push(cur)
    const last = pages[pages.length - 1]
    const lastHeader = pages.length === 1 ? m.header : m.contHeader
    const lastUsed = lastHeader + tableChrome + last.reduce((s, i) => s + m.rows[i], 0)
    if (lastUsed + tail > inner) pages.push([])
  }

  // 3. Compose paginated pages and rasterize each one into a jsPDF A4 page.
  const frame = await loadHiddenIframe(composeHtml(parts, pages))
  try {
    const pageEls = Array.from(frame.doc.querySelectorAll<HTMLElement>('.pdf-page'))
    const { default: html2canvas } = await import('html2canvas')
    const { default: jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: 'a4', compress: true })
    const pdfW = pdf.internal.pageSize.getWidth()
    const pdfH = pdf.internal.pageSize.getHeight()
    for (let i = 0; i < pageEls.length; i++) {
      const canvas = await html2canvas(pageEls[i], { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
      if (i > 0) pdf.addPage()
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, pdfW, pdfH, undefined, 'FAST')
    }
    pdf.save(`${fileSlug(input, variant)}.pdf`)
  } finally {
    frame.iframe.remove()
  }
}
