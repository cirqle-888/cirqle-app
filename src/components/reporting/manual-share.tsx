'use client'
import { useState } from 'react'
import type { ReportFormat } from '@/lib/reporting/types'

export function ManualReportShare({ reportId, caption, formats }: { reportId: string; caption: string; formats: ReportFormat[] }) {
  const [message, setMessage] = useState(caption)
  const [notice, setNotice] = useState('')
  async function copy() {
    try { await navigator.clipboard.writeText(message); setNotice('Message copied. Attach the downloaded report in WhatsApp.') }
    catch { setNotice('Copy is unavailable here. Select the message and copy it manually.') }
  }
  async function share() {
    if (!navigator.share) { await copy(); return }
    try { await navigator.share({ text: message }); setNotice('Share sheet closed. Attach a downloaded report if needed.') }
    catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) setNotice('Sharing is unavailable. Copy the message and download the report below.') }
  }
  return <section className="m-4 rounded-xl border bg-background p-4 space-y-3" aria-labelledby="share-title">
    <h2 id="share-title" className="font-medium">Prepare a WhatsApp update</h2>
    <label htmlFor="report-caption" className="block text-sm text-muted-foreground">Review and edit your message before sharing.</label>
    <textarea id="report-caption" value={message} onChange={e => setMessage(e.target.value)} rows={7} className="w-full rounded-lg border bg-background p-3 text-sm" />
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <button type="button" onClick={copy} className="rounded-lg border px-3 py-2">Copy message</button>
      <button type="button" onClick={share} className="rounded-lg border px-3 py-2">Open share sheet</button>
      {formats.filter(f => ['pdf', 'image_portrait', 'image_square', 'image_bundle'].includes(f)).map(format =>
        <a key={format} className="rounded-lg border px-3 py-2" href={`/api/advertising/reports/${reportId}/download?format=${format}&redirect=1`} target="_blank" rel="noopener noreferrer">Download {format === 'image_bundle' ? 'all image pages (ZIP)' : format === 'pdf' ? 'PDF' : format === 'image_portrait' ? 'portrait image' : 'square image'}</a>)}
    </div>
    <p role="status" className="text-sm text-muted-foreground">{notice || 'Nothing is sent automatically.'}</p>
  </section>
}
