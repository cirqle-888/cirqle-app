/**
 * Business Partner statement → one-page PDF (secondary/formal export).
 * Wraps the same rasterized HTML used for the WhatsApp Image export into a
 * single jsPDF page. Independent of src/lib/invoices/download-pdf.ts.
 */
import { renderPartnerStatementHtml, STATEMENT_WIDTH, type StatementBrand } from './render-html'
import type { PartnerStatementData } from './queries'

async function loadHiddenIframe(html: string): Promise<{ iframe: HTMLIFrameElement; doc: Document }> {
  const iframe = document.createElement('iframe')
  iframe.style.cssText = `position:fixed; top:-99999px; left:-99999px; width:${STATEMENT_WIDTH}px; border:0;`
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('Could not create render frame')
  doc.open(); doc.write(html); doc.close()

  await new Promise<void>(resolve => {
    if (doc.readyState === 'complete') { resolve(); return }
    iframe.addEventListener('load', () => resolve(), { once: true })
    setTimeout(resolve, 1500)
  })
  await Promise.race([
    (doc as Document & { fonts?: FontFaceSet }).fonts?.ready ?? Promise.resolve(),
    new Promise<void>(r => setTimeout(r, 1000)),
  ])
  iframe.style.height = doc.body.scrollHeight + 'px'
  return { iframe, doc }
}

/** Generate and trigger a browser download of the statement PDF. */
export async function downloadStatementPdf(data: PartnerStatementData, brand: StatementBrand): Promise<void> {
  const html = renderPartnerStatementHtml(data, brand)
  const { iframe, doc } = await loadHiddenIframe(html)
  try {
    const { default: html2canvas } = await import('html2canvas')
    const { default: jsPDF } = await import('jspdf')
    const canvas = await html2canvas(doc.body, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: [canvas.width / 2, canvas.height / 2] })
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, canvas.width / 2, canvas.height / 2, undefined, 'FAST')
    pdf.save(`${data.partner.partner_code || data.partner.name}-statement.pdf`)
  } finally {
    iframe.remove()
  }
}
