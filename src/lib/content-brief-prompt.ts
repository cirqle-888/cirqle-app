/**
 * "Copy AI prompt" for a post's brief: the ready-to-paste prompt a planner
 * (or the AI that planned the month) wrote into the notes, or, when there is
 * none, one built from the brief itself, so any post can go straight into
 * Firefly, ChatGPT, Gemini or a video tool.
 *
 * Pure: shared by the Social Calendar item form and the read-only brief in
 * Requests and Tasks.
 */
import { captionHtmlToText } from '@/lib/social/plan'
import { contentTypeLabel } from '@/lib/content-brief'

/** A paragraph that starts a new labelled section, e.g. "Goal:", "Reel script:", "AI prompt (paste …):". */
const LABEL = /^[A-Z][A-Za-z /&-]{1,40}(\([^)]{0,80}\))?:/

/** The text under the notes' "AI prompt" label, or null. */
export function extractAiPrompt(notes: string | null | undefined): string | null {
  if (!notes) return null
  const paras = notes.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const start = paras.findIndex(p => /^AI (image |video )?prompt\b/i.test(p.trim()))
  if (start === -1) return null
  const first = paras[start].trim().replace(/^AI (image |video )?prompt\b[^:\n]*:?\s*/i, '')
  const out = [first]
  for (let i = start + 1; i < paras.length; i++) {
    if (LABEL.test(paras[i].trim())) break
    out.push(paras[i].trim())
  }
  const text = out.filter(Boolean).join('\n\n').trim()
  return text || null
}

/** The notes paragraph with this label, without the label. */
function section(notes: string, label: RegExp): string | null {
  const p = notes.replace(/\r\n/g, '\n').split(/\n{2,}/).find(x => label.test(x.trim()))
  return p ? p.trim().replace(label, '').replace(/^[^:\n]*:\s*/, '').trim() || null : null
}

export interface BriefForPrompt {
  title: string | null | undefined
  contentType: string | null | undefined
  caption: string | null | undefined
  notes: string | null | undefined
  platforms?: string[] | null
}

/** A design prompt written from the brief when the notes carry none. */
export function promptFromBrief(b: BriefForPrompt): string {
  const kind = (contentTypeLabel(b.contentType) || 'social media post').toLowerCase()
  const reel = /reel|video/.test(kind)
  const notes = (b.notes || '').trim()
  const visual = notes ? section(notes, /^Visual direction\b/i) : null
  const onDesign = (() => {
    const text = captionHtmlToText(b.caption).trim()
    const m = text.match(/Text on design:\s*\n?([\s\S]*?)(\n\n|$)/i)
    return m ? m[1].trim() : null
  })()
  const lines = [
    `Create a ${kind}${b.platforms?.length ? ` for ${b.platforms.join(' and ')}` : ''}: ${(b.title || '').trim() || 'see the brief below'}.`,
    visual ? `Look: ${visual}` : '',
    onDesign ? `Leave clear space for this text, which is added later: ${onDesign.replace(/\n+/g, ' / ')}` : '',
    !visual && notes ? `Brief: ${notes.slice(0, 600)}` : '',
    reel ? 'Vertical 9:16, 5-8 seconds, smooth camera movement, natural light.' : 'Square 1:1 (or 4:5 for the feed), clean composition, natural light, high detail.',
    'No text in the image, no logo.',
  ]
  return lines.filter(Boolean).join('\n')
}

/** What "Copy AI prompt" copies, and whether it was written by the planner or built here. */
export function aiPromptForBrief(b: BriefForPrompt): { text: string; fromNotes: boolean } {
  const written = extractAiPrompt(b.notes)
  return written ? { text: written, fromNotes: true } : { text: promptFromBrief(b), fromNotes: false }
}
