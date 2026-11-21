/**
 * Put an image on the clipboard, to paste into an AI tool after a prompt.
 * Clipboards take PNG, so anything else is redrawn as one. Works for logos
 * uploaded to the app and any image link that allows it; a page link (a Drive
 * preview, say) cannot be read, and the caller says so.
 */
export async function copyImage(url: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) return false
    let blob = await res.blob()
    if (!blob.type.startsWith('image/')) return false
    if (blob.type !== 'image/png') {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      const png = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/png'))
      if (!png) return false
      blob = png
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}
