/**
 * Business Partner statement → PNG (WhatsApp Image export) and → PDF
 * (secondary/formal export). Browser-only, mirrors the hidden-iframe +
 * html2canvas technique used by src/lib/invoices/download-pdf.ts, but
 * reimplemented locally so this module stays independent of the invoice
 * PDF pipeline.
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

/** Renders the statement to a PNG data URL, sized for WhatsApp Image sharing. */
export async function generateStatementImage(data: PartnerStatementData, brand: StatementBrand): Promise<string> {
  const html = renderPartnerStatementHtml(data, brand)
  const { iframe, doc } = await loadHiddenIframe(html)
  try {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(doc.body, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
    return canvas.toDataURL('image/png')
  } finally {
    iframe.remove()
  }
}

/** Triggers a browser download of the statement PNG. */
export async function downloadStatementImage(data: PartnerStatementData, brand: StatementBrand): Promise<void> {
  const dataUrl = await generateStatementImage(data, brand)
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = `${data.partner.partner_code || data.partner.name}-statement.png`
  a.click()
}
