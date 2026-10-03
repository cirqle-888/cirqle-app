'use client'

/**
 * Read-only Content Brief — what a designer reads. Used in the Requests popup
 * and the task's "request brief" view, so a brief planned in the Calendar or
 * written in Requests looks the same wherever it is opened.
 */

import { useState } from 'react'
import { Check, Copy, Link2, LayoutTemplate } from 'lucide-react'
import {
  sanitizeCaptionHtml, captionHtmlToText, canvasToText, canvasImageUrls, platformLabels,
} from '@/lib/social/plan'
import { contentTypeLabel, linkDisplay, type ContentBrief } from '@/lib/content-brief'

const SECTION = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1.5'

export default function ContentBriefView({ brief, platforms, scheduledDate }: {
  brief: ContentBrief
  /** From a calendar push (task_requests.social_meta) — shown as context. */
  platforms?: string[] | null
  scheduledDate?: string | null
}) {
  const [copied, setCopied] = useState(false)
  const type = contentTypeLabel(brief.contentType)
  const captionText = captionHtmlToText(brief.caption).trim()
  const boardText = canvasToText(brief.captionCanvas)
  const images = [...brief.referenceImages, ...canvasImageUrls(brief.captionCanvas)]
    .filter((u, i, a) => a.indexOf(u) === i)

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(captionText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard blocked — nothing to do */ }
  }

  const nothing = !captionText && !boardText && !images.length && !brief.notes && !brief.links.length

  return (
    <div className="space-y-4">
      {(type || platforms?.length || scheduledDate) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {type && <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">{type}</span>}
          {platforms?.length ? <span className="text-[11px] px-2 py-0.5 rounded-md bg-secondary border border-border text-muted-foreground">{platformLabels(platforms)}</span> : null}
          {scheduledDate && <span className="text-[11px] px-2 py-0.5 rounded-md bg-secondary border border-border text-muted-foreground">Publishes {new Date(scheduledDate + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
        </div>
      )}

      {captionText && (
        <div>
          <div className="flex items-center justify-between">
            <p className={SECTION}>Caption / copy</p>
            <button type="button" onClick={() => void copyCaption()}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground mb-1.5 transition-colors">
              {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy text'}
            </button>
          </div>
          <div
            className="rounded-xl border border-border bg-background px-3.5 py-3 text-sm leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h2]:font-bold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_a]:text-primary [&_a]:underline whitespace-pre-wrap"
            // Sanitized again on read: the stored value was sanitized on write,
            // this keeps the render safe even for rows written by older code.
            dangerouslySetInnerHTML={{ __html: sanitizeCaptionHtml(brief.caption) }}
          />
        </div>
      )}

      {boardText && (
        <div>
          <p className={`${SECTION} flex items-center gap-1`}><LayoutTemplate className="w-3 h-3" />Layout board</p>
          <p className="whitespace-pre-wrap text-sm text-foreground/90">{boardText}</p>
        </div>
      )}

      {images.length > 0 && (
        <div>
          <p className={SECTION}>Reference images</p>
          <div className="flex flex-wrap gap-2">
            {images.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noreferrer" title="Open full size"
                className="block w-24 h-24 rounded-lg overflow-hidden border border-border bg-secondary hover:ring-2 hover:ring-violet-500/40 transition-all">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`Reference ${i + 1}`} loading="lazy" className="w-full h-full object-cover" />
              </a>
            ))}
          </div>
        </div>
      )}

      {brief.notes && (
        <div>
          <p className={SECTION}>Notes for designer</p>
          <p className="whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed">{brief.notes}</p>
        </div>
      )}

      {brief.links.length > 0 && (
        <div>
          <p className={SECTION}>Links</p>
          <div className="flex flex-wrap gap-1.5">
            {brief.links.map((l, i) => (
              <a key={i} href={l.url} target="_blank" rel="noreferrer" title={l.url}
                className="inline-flex items-center gap-1 max-w-[260px] px-2.5 py-1 rounded-lg text-xs border bg-blue-500/8 border-blue-500/20 text-blue-700 dark:text-blue-300 hover:bg-blue-500/12 transition-colors">
                <Link2 className="w-3 h-3 shrink-0" /><span className="truncate">{linkDisplay(l)}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {nothing && <p className="text-sm text-muted-foreground/70 italic">No brief added.</p>}
    </div>
  )
}
