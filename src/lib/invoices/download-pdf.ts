/**
 * Invoice → downloadable PDF, paginated at row boundaries.
 *
 * Browser-only (hidden iframes + html2canvas + jsPDF). Pipeline:
 *   1. Measure — render every layout block (header, each table row, totals,
 *      footers…) in an off-screen iframe at the exact page width and read the
 *      real heights, so text wrapping is accounted for.
 *   2. Paginate — greedily pack whole rows into A4-proportioned pages. A row
 *      that doesn't fit moves entirely to the next page; totals + payment
 *      info always land on the last page (on their own page if needed).
 *   3. Compose + rasterize — render the paginated document (continuation
 *      headers/footers, repeated table head, Page X of Y) and html2canvas
 *      each page div separately into one jsPDF A4 page each. No slicing, so
 *      no clipped rows and no header overdraw artifacts.
 */
import {
  buildInvoiceParts,
  renderMeasureHtml,
  renderPaginatedInvoiceHtml,
  PDF_PAGE_W,
  PDF_PAGE_H,
  PDF_PAD_TOP,
  PDF_PAD_BOTTOM,
  type InvoiceRenderParts,
} from './render-html'

// Vertical margins around the items table (must match itemsTable's
// `margin:14px 0 12px` in render-html.ts) — offsetHeight excludes them.
const TABLE_MARGIN_TOP = 14
const TABLE_MARGIN_BOTTOM = 12

interface Measurements {
  header: number      // page-1 header block
  contHeader: number  // continuation header (pages 2+)
  thead: number       // items-table gradient header row
  rows: number[]      // each item row, includes its border
  expenses: number
  totals: number
  notes: number
  footer: number      // payment/QR/thank-you block
  brand: number       // bottom brand strip
  contFooter: number  // "Continued →" strip
}

async function loadHiddenIframe(html: string): Promise<{ iframe: HTMLIFrameElement; doc: Document }> {
  const iframe = document.createElement('iframe')
  iframe.style.cssText = `position:fixed; top:-99999px; left:-99999px; width:${PDF_PAGE_W}px; border:0;`
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('Could not create render frame')
  doc.open(); doc.write(html); doc.close()

  // Wait for the frame to finish loading, then webfonts and any <img>s
  // (logo / QR / background art), each with a safety timeout.
  await new Promise<void>(resolve => {
    if (doc.readyState === 'complete') { resolve(); return }
    iframe.addEventListener('load', () => resolve(), { once: true })
    setTimeout(resolve, 1500)
  })
  await Promise.race([
    Promise.all([
      (doc as any).fonts?.ready ?? Promise.resolve(),
      ...Array.from(doc.images).map(img => img.complete
        ? Promise.resolve()
        : new Promise<void>(r => { img.onload = () => r(); img.onerror = () => r() })),
    ]),
    new Promise<void>(r => setTimeout(r, 3000)),
  ])
  // Size the frame to its content so no scrollbar steals layout width.
  iframe.style.height = doc.body.scrollHeight + 'px'
  return { iframe, doc }
}

function measureBlocks(doc: Document): Measurements {
  const h = (key: string): number => {
    const el = doc.querySelector<HTMLElement>(`[data-m="${key}"]`)
    return el && el.style.display !== 'none' ? el.getBoundingClientRect().height : 0
  }
  const table = doc.querySelector<HTMLElement>('[data-m="table"]')
  const thead = table?.querySelector('thead')
  const rows = Array.from(table?.querySelectorAll('tbody tr') ?? [])
    .map(tr => tr.getBoundingClientRect().height)
  return {
    header: h('header'),
    contHeader: h('contHeader'),
    thead: thead ? thead.getBoundingClientRect().height : 0,
    rows,
    expenses: h('expenses'),
    totals: h('totals'),
    notes: h('notes'),
    footer: h('footer'),
    brand: h('brand'),
    contFooter: h('contFooter'),
  }
}

/**
 * Assign whole rows to pages. Returns row-index lists per page; the last
 * entry may be [] when the trailing blocks need a page of their own.
 */
export function paginateRows(m: Measurements): number[][] {
  const inner = PDF_PAGE_H - PDF_PAD_TOP - PDF_PAD_BOTTOM
  const tableChrome = TABLE_MARGIN_TOP + m.thead + TABLE_MARGIN_BOTTOM
  const tail = m.expenses + m.totals + m.notes + m.footer + m.brand
  const rowsTotal = m.rows.reduce((s, r) => s + r, 0)

  // Everything fits on one page → single page, identical to the classic layout
  if (m.header + tableChrome + rowsTotal + tail <= inner) {
    return [m.rows.map((_, i) => i)]
  }

  const firstCap = inner - m.header - tableChrome - m.contFooter
  const midCap = inner - m.contHeader - tableChrome - m.contFooter

  const pages: number[][] = []
  let cur: number[] = []
  let capLeft = firstCap
  m.rows.forEach((rh, i) => {
    // Row doesn't fit → close this page, start the next (a row taller than a
    // whole page still gets placed alone rather than looping forever).
    if (rh > capLeft && cur.length > 0) {
      pages.push(cur)
      cur = []
      capLeft = midCap
    }
    cur.push(i)
    capLeft -= rh
  })
  pages.push(cur)

  // Trailing blocks (expenses, totals, notes, payment footer, brand strip) go
  // on the last page — with the rows if they fit (the continuation-footer
  // reserve is freed since the last page doesn't carry one), else on a fresh
  // page of their own.
  const lastRows = pages[pages.length - 1]
  const lastHeader = pages.length === 1 ? m.header : m.contHeader
  const lastUsed = lastHeader + tableChrome + lastRows.reduce((s, i) => s + m.rows[i], 0)
  if (lastUsed + tail > inner) {
    pages.push([])
  }
  return pages
}

export interface DownloadPdfOpts {
  otherOutstanding?: number
}

/** Build the paginated PDF and return the jsPDF document (caller saves it). */
export async function generateInvoicePdf(
  inv: any,
  companySettings: Record<string, string>,
  opts?: DownloadPdfOpts,
): Promise<any> {
  const parts: InvoiceRenderParts = buildInvoiceParts(inv, companySettings, {
    forRaster: true,
    otherOutstanding: opts?.otherOutstanding,
  })

  // 1. Measure real block/row heights at page width
  const mFrame = await loadHiddenIframe(renderMeasureHtml(parts))
  let pageRows: number[][]
  try {
    pageRows = paginateRows(measureBlocks(mFrame.doc))
  } finally {
    mFrame.iframe.remove()
  }

  // 2. Compose the paginated document and rasterize page by page
  const frame = await loadHiddenIframe(renderPaginatedInvoiceHtml(parts, pageRows))
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
    return pdf
  } finally {
    frame.iframe.remove()
  }
}

/** Generate and trigger a real browser download of the invoice PDF. */
export async function downloadInvoicePdf(
  inv: any,
  companySettings: Record<string, string>,
  opts?: DownloadPdfOpts,
): Promise<void> {
  const pdf = await generateInvoicePdf(inv, companySettings, opts)
  pdf.save(`${inv.invoice_number}.pdf`)
}
