/**
 * Turns the pending-work card (my-work-share.ts → pendingCardHtml) into a PNG.
 * Browser only. Same technique as src/lib/partners/statement-image.ts: render
 * the self-contained HTML in a hidden iframe, then html2canvas at 2x.
 */
import { CARD_WIDTH } from './my-work-share'

export async function renderPendingCard(html: string, width: number = CARD_WIDTH): Promise<Blob> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = `position:fixed;top:-99999px;left:-99999px;width:${width}px;height:10px;border:0;`
  document.body.appendChild(iframe)
  try {
    const doc = iframe.contentDocument
    if (!doc) throw new Error('Could not create a render frame')
    doc.open(); doc.write(html); doc.close()
    await Promise.race([
      (doc as Document & { fonts?: FontFaceSet }).fonts?.ready ?? Promise.resolve(),
      new Promise(r => setTimeout(r, 800)),
    ])
    iframe.style.height = `${doc.body.scrollHeight}px`
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(doc.body, { scale: 2, backgroundColor: '#f6f5fb', logging: false })
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
    if (!blob) throw new Error('Could not create the image')
    return blob
  } finally {
    iframe.remove()
  }
}

/** Blob → base64 (no data: prefix), for saving through the native shell. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}
