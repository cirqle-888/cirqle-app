/**
 * "Copy AI prompt" for a post's brief: the ready-to-paste prompt a planner
 * (or the AI that planned the month) wrote into the notes, or, when there is
 * none, one built from the brief itself, so any post can go straight into
 * Firefly, ChatGPT, Gemini or a video tool.
 *
 * A fresh chat knows nothing about the client, so the full copy puts the
 * client's card and the post's details above the prompt (postPromptWithCard).
 * "Prompt only" stays short for image tools with a small prompt box.
 *
 * Pure: shared by the Social Calendar item form and the read-only brief in
 * Requests and Tasks.
 */
import { captionHtmlToText, PLATFORM_LABEL, type Platform } from '@/lib/social/plan'
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
  /** The post date, YYYY-MM-DD. */
  date?: string | null
}

/** "Instagram and Facebook" from ['instagram', 'facebook']. */
function platformWords(platforms: string[] | null | undefined): string {
  const names = (platforms ?? []).map(p => PLATFORM_LABEL[p as Platform] ?? p).filter(Boolean)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? ''
}

/** The words the designer puts on the poster, from the caption's "Text on design:" part. */
function textOnDesign(caption: string | null | undefined): string | null {
  const text = captionHtmlToText(caption).trim()
  const m = text.match(/Text on design:\s*\n?([\s\S]*?)(\n\n|$)/i)
  return m ? m[1].trim() || null : null
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "1 December 2026" from "2026-12-01"; '' for anything else. */
function longDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  return m && MONTHS[+m[2] - 1] ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : ''
}

/** A design prompt written from the brief when the notes carry none. */
export function promptFromBrief(b: BriefForPrompt): string {
  const kind = (contentTypeLabel(b.contentType) || 'social media post').toLowerCase()
  const reel = /reel|video/.test(kind)
  const notes = (b.notes || '').trim()
  const visual = notes ? section(notes, /^Visual direction\b/i) : null
  const onDesign = textOnDesign(b.caption)
  const where = platformWords(b.platforms)
  const lines = [
    `Create a ${kind}${where ? ` for ${where}` : ''}: ${(b.title || '').trim() || 'see the brief below'}.`,
    visual ? `Look: ${visual}` : '',
    onDesign ? `Leave clear space for this text, which is added later: ${onDesign.replace(/\n+/g, ' / ')}` : '',
    !visual && notes ? `Brief: ${notes.slice(0, 600)}` : '',
    reel ? 'Vertical 9:16, 5-8 seconds, smooth camera movement, natural light.' : 'Square 1:1 (or 4:5 for the feed), clean composition, natural light, high detail.',
    'No text in the image, no logo.',
  ]
  return lines.filter(Boolean).join('\n')
}

/** The prompt alone, and whether it was written by the planner or built here. */
export function aiPromptForBrief(b: BriefForPrompt): { text: string; fromNotes: boolean } {
  const written = extractAiPrompt(b.notes)
  return written ? { text: written, fromNotes: true } : { text: promptFromBrief(b), fromNotes: false }
}

/** Says the AI prompt makes the picture only, so the words and logo are not drawn by the AI. */
const PICTURE_ONLY = /\bno (text|words|logo|lettering)\b|\bwithout (any )?(text|words|logo)\b/i

/**
 * Everything a fresh ChatGPT, Gemini or Claude chat needs to make this post's
 * visual: a short instruction, the client's card (rendered by Prompt Studio),
 * the post's details and the prompt. With no card, the prompt alone.
 */
export function postPromptWithCard(cardText: string | null | undefined, b: BriefForPrompt): string {
  const { text: prompt } = aiPromptForBrief(b)
  const card = (cardText ?? '').trim()
  if (!card) return prompt
  const notes = (b.notes || '').trim()
  const kind = contentTypeLabel(b.contentType) || 'Social media post'
  const where = platformWords(b.platforms)
  const intro = [
    'Make the visual for one social media post for the client below.',
    'The CLIENT CARD is their brand: follow its look and feel, colours, logo rule, must show and never show.',
    /^Audience by service:/m.test(card)
      ? 'Pick the people, their clothes and the setting from the Audience by service line that matches this post.'
      : 'Match the people, their clothes and the setting to the audience this post is for.',
    PICTURE_ONLY.test(prompt)
      ? 'The AI PROMPT makes the picture only: leave clear space for the text on design, the logo and the location line, which the designer adds later.'
      : '',
  ].filter(Boolean).join(' ')
  const post = [
    'POST',
    (b.title || '').trim() && `Title: ${(b.title || '').trim()}`,
    `Format: ${kind}${where ? ` for ${where}` : ''}`,
    longDate(b.date) && `Publishes: ${longDate(b.date)}`,
    notes && section(notes, /^Theme\b/i) && `Theme: ${section(notes, /^Theme\b/i)}`,
    notes && section(notes, /^Goal\b/i) && `Goal: ${section(notes, /^Goal\b/i)}`,
    textOnDesign(b.caption) && `Text on design: ${textOnDesign(b.caption)!.replace(/\n+/g, ' / ')}`,
    notes && section(notes, /^Visual direction\b/i) && `Visual direction: ${section(notes, /^Visual direction\b/i)}`,
  ].filter(Boolean).join('\n')
  return [intro, card, post, `AI PROMPT\n${prompt}`].join('\n\n')
}
