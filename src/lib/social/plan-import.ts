/**
 * Social Calendar — turning an AI's answer into plan items.
 *
 * The planner copies a brief for an outside AI (Codex, Gemini, ChatGPT,
 * Claude), gets a table back, and pastes it here. This reads the table and
 * returns the items it holds, ready for addSocialPlanItems. Pure: no I/O.
 *
 * It understands the three tables the Social Media templates ask for:
 *   calendar  Date | Day | Platform | Format | Theme | Idea | Hook | What the designer needs
 *   ideas     Format | Idea | Hook | Effort | Best day
 *   trends    Trend | Why it fits | Post idea | Hook | Post by | Source link
 * Columns are found by their heading, so a reordered or shortened table still
 * works. Anything it cannot place is reported, never guessed.
 */

import { CONTENT_TYPES, PLATFORMS, type ContentType, type Platform } from '@/lib/social/plan'
import { itemKey, type PlanItemInput } from '@/lib/social/plan-mcp'
import { isImageUrl } from '@/lib/content-brief'

export type PlanTableKind = 'detailed' | 'calendar' | 'ideas' | 'trends' | 'unknown'

export interface ParsedPlan {
  kind: PlanTableKind
  items: PlanItemInput[]
  /** Rows that were left out, with the reason, so nothing disappears silently. */
  skipped: { row: string; reason: string }[]
}

type Col = 'date' | 'day' | 'platform' | 'format' | 'theme' | 'idea' | 'hook' | 'needs' | 'effort' | 'bestday' | 'trend' | 'why' | 'postby' | 'source'

/** Heading words → the column they mean. First match wins, so the specific ones come first. */
const HEADINGS: [RegExp, Col][] = [
  [/source|link/, 'source'],
  [/post by|deadline/, 'postby'],
  [/best day/, 'bestday'],
  [/why/, 'why'],
  [/trend/, 'trend'],
  [/designer|needs|assets/, 'needs'],
  [/effort/, 'effort'],
  [/hook|caption|headline/, 'hook'],
  [/idea|concept|post$|content/, 'idea'],
  [/theme|pillar|topic/, 'theme'],
  [/format|type/, 'format'],
  [/platform|channel/, 'platform'],
  [/date/, 'date'],
  [/day/, 'day'],
]

const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()

/** One table line → its cells. Pipes (markdown) or tabs (pasted from a sheet). */
function cells(line: string): string[] | null {
  if (line.includes('|')) {
    const parts = line.split('|').map(clean)
    if (parts[0] === '') parts.shift()
    if (parts.length && parts[parts.length - 1] === '') parts.pop()
    return parts.length >= 2 ? parts : null
  }
  if (line.includes('\t')) {
    const parts = line.split('\t').map(clean)
    return parts.length >= 2 ? parts : null
  }
  return null
}

const isDivider = (c: string[]) => c.every(x => /^:?-{2,}:?$/.test(x) || x === '')

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A date as the AI wrote it → YYYY-MM-DD inside the plan's month, or null.
 * `month` is 'YYYY-MM'. Understands 2026-12-04, 04/12/2026, 4 Dec, Dec 4,
 * "Friday 4" and a bare day number. A date in another month is refused (null
 * with `outside`), because the plan holds one month.
 */
export function planDate(raw: string, month: string): { date: string | null; outside?: boolean } {
  const s = clean(raw).toLowerCase()
  if (!s) return { date: null }
  const [py, pm] = month.split('-').map(Number)
  let y = py, m = pm, d = 0
  let hit: RegExpExecArray | null
  if ((hit = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +hit[1]; m = +hit[2]; d = +hit[3] }
  else if ((hit = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s))) { d = +hit[1]; m = +hit[2]; y = +hit[3] }
  else {
    const mi = MONTHS.findIndex(n => new RegExp(`\\b${n}`).test(s))
    const day = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(s)
    if (!day) return { date: null }
    d = +day[1]
    if (mi >= 0) m = mi + 1
  }
  if (y !== py || m !== pm) return { date: null, outside: true }
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate()
  if (d < 1 || d > last) return { date: null }
  return { date: `${py}-${pad(pm)}-${pad(d)}` }
}

/** "Reel", "Poster / Story", "Offer flyer post" → one of the app's content types. */
export function contentTypeOf(raw: string): ContentType {
  const s = clean(raw).toLowerCase()
  // Longest names first, so "carousel post" is a carousel and "flyer post" a flyer.
  const order: ContentType[] = ['carousel', 'poster', 'flyer', 'story', 'reel', 'video', 'blog', 'email', 'seo', 'ad', 'post']
  for (const t of order) if (CONTENT_TYPES.includes(t) && new RegExp(`\\b${t}`).test(s)) return t
  if (/\bshort\b/.test(s)) return 'reel'
  if (/\bstatus\b/.test(s)) return 'story'
  return 'post'
}

const PLATFORM_WORDS: [RegExp, Platform][] = [
  [/instagram|\binsta\b|\big\b/, 'instagram'], [/facebook|\bfb\b/, 'facebook'], [/whatsapp|\bwa\b/, 'whatsapp'],
  [/youtube|\byt\b/, 'youtube'], [/linkedin/, 'linkedin'], [/tiktok/, 'tiktok'], [/\bx\b|twitter/, 'x'],
]

/** "Instagram + Facebook", "IG/FB", "All" → the app's platform keys ("All" means none chosen: staff decide). */
export function platformsOf(raw: string): Platform[] {
  const s = clean(raw).toLowerCase()
  return PLATFORM_WORDS.filter(([re]) => re.test(s)).map(([, p]) => p).filter(p => PLATFORMS.includes(p))
}

const isTrendSlot = (s: string) => /trend slot/i.test(s)
const url = (s: string) => /https?:\/\/[^\s)>\]]+/.exec(s)?.[0] ?? ''

/**
 * The month the pasted dates are in ('YYYY-MM'), when they say: the month most
 * full dates fall in, else a "December 2026" written in the text. Null when
 * the answer only has day numbers, so the caller keeps its own month.
 */
export function planMonthIn(text: string): string | null {
  const t = text || ''
  const count = new Map<string, number>()
  const add = (y: number, m: number) => {
    if (y < 2000 || y > 2100 || m < 1 || m > 12) return
    const k = `${y}-${pad(m)}`
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  for (const h of t.matchAll(/\b(\d{4})-(\d{1,2})-\d{1,2}\b/g)) add(+h[1], +h[2])
  for (const h of t.matchAll(/\b\d{1,2}[/.](\d{1,2})[/.](\d{4})\b/g)) add(+h[2], +h[1])
  if (!count.size) {
    const named = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?,?\\s+(\\d{4})\\b`, 'gi')
    for (const h of t.matchAll(named)) add(+h[2], MONTHS.indexOf(h[1].toLowerCase()) + 1)
  }
  let best: string | null = null
  for (const [k, n] of count) if (!best || n > count.get(best)!) best = k
  return best
}

const headingCount = (r: string[]) => r.filter(c => HEADINGS.some(([re]) => re.test(c.toLowerCase()))).length

/**
 * Read the AI's answer. `month` ('YYYY-MM') is the plan the items will go
 * into; it is only used for dates. Text around the tables is ignored. An
 * answer may hold more than one table (a calendar, then some extra ideas):
 * each run of table lines is read on its own, by its own headings.
 */
export function parsePlanTable(text: string, month: string): ParsedPlan {
  const blocks: string[][][] = []
  let open: string[][] | null = null
  for (const line of (text || '').split(/\r?\n/)) {
    const c = cells(line)
    if (!c) { open = null; continue }
    if (!open) blocks.push((open = []))
    if (!isDivider(c)) open.push(c)
  }
  const out: ParsedPlan = { kind: 'unknown', items: [], skipped: [] }
  for (const rows of blocks) {
    const part = parseBlock(rows, month)
    if (part.kind === 'unknown') continue
    if (out.kind === 'unknown') out.kind = part.kind
    out.items.push(...part.items)
    out.skipped.push(...part.skipped)
  }
  return out
}

function parseBlock(rows: string[][], month: string): ParsedPlan {
  const headAt = rows.findIndex(r => headingCount(r) >= 2)
  if (headAt < 0) return { kind: 'unknown', items: [], skipped: [] }

  const cols: Partial<Record<Col, number>> = {}
  rows[headAt].forEach((h, i) => {
    const hit = HEADINGS.find(([re]) => re.test(h.toLowerCase()))
    if (hit && cols[hit[1]] === undefined) cols[hit[1]] = i
  })
  const kind: PlanTableKind = cols.trend !== undefined ? 'trends' : cols.date !== undefined ? 'calendar' : cols.idea !== undefined ? 'ideas' : 'unknown'
  if (kind === 'unknown') return { kind, items: [], skipped: [] }

  const items: PlanItemInput[] = []
  const skipped: ParsedPlan['skipped'] = []
  for (const r of rows.slice(headAt + 1)) {
    const get = (c: Col) => (cols[c] !== undefined ? clean(r[cols[c]!] ?? '') : '')
    const line = r.join(' | ')
    const idea = get('idea').replace(/^\*\s*/, '')
    const theme = get('theme')
    const trend = get('trend')
    const slot = isTrendSlot(line)
    const title = slot ? 'Trend slot (fill from the daily trend check)' : idea || theme || trend
    if (!title) { skipped.push({ row: line, reason: 'No idea in this row.' }); continue }

    let date: string | null = null
    if (kind === 'calendar') {
      const d = planDate(get('date'), month)
      if (d.outside) { skipped.push({ row: line, reason: `That date is outside ${month}.` }); continue }
      if (!d.date) { skipped.push({ row: line, reason: 'Could not read the date.' }); continue }
      date = d.date
    }
    const notes = [
      kind === 'trends' && trend && idea ? `Trend: ${trend}` : '',
      theme && theme !== title ? `Theme: ${theme}` : '',
      get('why') ? `Why it fits: ${get('why')}` : '',
      get('needs') ? `Designer needs: ${get('needs')}` : '',
      get('effort') ? `Effort: ${get('effort')}` : '',
      get('bestday') ? `Best day: ${get('bestday')}` : '',
      get('postby') ? `Post by: ${get('postby')}` : '',
      url(get('source') || line) ? `Source: ${url(get('source') || line)}` : '',
    ].filter(Boolean).join('\n')
    items.push({
      title,
      date,
      content_type: contentTypeOf(get('format') || (kind === 'trends' ? idea : '')),
      platforms: platformsOf(get('platform')),
      caption: slot ? null : get('hook') || null,
      notes: notes || null,
      asap: kind === 'trends' || slot,
    })
  }
  return { kind, items, skipped }
}

// ── Detailed plans: one block of "Label: value" lines per post ──────────────

type BlockKey = 'date' | 'day' | 'platform' | 'format' | 'theme' | 'idea' | 'goal' | 'hook' | 'designText' | 'visual'
  | 'caption' | 'hashtags' | 'needs' | 'prompt' | 'script' | 'refs' | 'trend' | 'postby' | 'effort' | 'bestday'

/** The labels the detailed calendar asks for, and the near-misses an AI writes instead. */
const BLOCK_LABELS: Record<string, BlockKey> = {
  date: 'date', day: 'day', platform: 'platform', platforms: 'platform', channel: 'platform',
  format: 'format', type: 'format', theme: 'theme', pillar: 'theme',
  idea: 'idea', concept: 'idea', 'post idea': 'idea', title: 'idea',
  goal: 'goal', objective: 'goal', why: 'goal', 'why now': 'goal', 'why it fits': 'goal',
  hook: 'hook',
  'text on design': 'designText', 'text on the design': 'designText', 'design text': 'designText', 'on design text': 'designText', 'text on poster': 'designText', 'on screen text': 'designText',
  'visual direction': 'visual', visual: 'visual', 'design direction': 'visual', 'art direction': 'visual', visuals: 'visual',
  caption: 'caption', hashtags: 'hashtags', tags: 'hashtags',
  'designer needs': 'needs', needs: 'needs', 'what the designer needs': 'needs', 'assets needed': 'needs',
  'ai prompt': 'prompt', 'design prompt': 'prompt', 'image prompt': 'prompt', 'video prompt': 'prompt', prompt: 'prompt',
  'reel script': 'script', script: 'script', 'shot list': 'script',
  references: 'refs', reference: 'refs', refs: 'refs', inspiration: 'refs', source: 'refs', 'source link': 'refs',
  trend: 'trend', 'post by': 'postby', effort: 'effort', 'best day': 'bestday',
}

const LABEL_LINE = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?([A-Za-z][A-Za-z '-]{1,30}?)(?:\*\*|__)?\s*[:：](?:\*\*|__)?\s*(.*)$/
const BREAK_LINE = /^\s*(#{1,6}\s.*|[-=_*]{3,}|(?:\*\*)?post\s*#?\d*(?:\*\*)?[:.]?)\s*$/i
const NOTHING = /^(-|–|—|n\/?a|none|nil|not needed|not applicable)\.?$/i

/** "[Label](https://…)", "Label: https://…" or a bare link → a reference link; anything else is a search phrase. */
function references(raw: string): { links: { label: string; url: string }[]; images: string[]; searches: string[] } {
  const links: { label: string; url: string }[] = []
  const images: string[] = []
  const searches: string[] = []
  for (const piece of raw.split(/\n|;|\s\|\s/).map(x => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)) {
    const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(piece)
    const href = md?.[2] ?? url(piece)
    if (href && isImageUrl(href.replace(/[.,]+$/, ''))) {
      // A link to the picture itself is a reference image: it previews inside the app.
      images.push(href.replace(/[.,]+$/, ''))
    } else if (href) {
      const label = (md?.[1] ?? piece.replace(href, '').replace(/[\s:,\-–()<>]+$/g, '').replace(/^[\s:,\-–()<>]+/g, '')).trim()
      links.push({ label: label.slice(0, 60), url: href.replace(/[.,]+$/, '') })
    } else {
      const phrase = piece.replace(/^search(?: for| phrase)?s?\s*[:\-]?\s*/i, '').replace(/^["“'‘]+|["”'’.]+$/g, '').trim()
      if (phrase && !NOTHING.test(phrase)) searches.push(phrase)
    }
  }
  return { links, images, searches }
}

/** A search phrase the designer can open in one click. */
const pinterest = (phrase: string) => ({
  label: `Pinterest: ${phrase}`.slice(0, 60),
  url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(phrase)}`,
})

/**
 * Read a detailed plan: one block per post, each a run of "Label: value" lines
 * (Date, Platform, Format, Idea, Hook, Text on design, Visual direction,
 * Caption, Hashtags, Designer needs, AI prompt, Reel script, References).
 * A value may run over several lines. Blocks without an idea are ignored.
 */
export function parsePlanBlocks(text: string, month: string): ParsedPlan {
  const blocks: Partial<Record<BlockKey, string>>[] = []
  let cur: Partial<Record<BlockKey, string>> | null = null
  let key: BlockKey | null = null
  const close = () => { if (cur && Object.keys(cur).length) blocks.push(cur); cur = null; key = null }
  for (const line of (text || '').replace(/```[a-z]*/gi, '').split(/\r?\n/)) {
    if (BREAK_LINE.test(line)) { close(); continue }
    if (cells(line) && /^\s*\|/.test(line)) { key = null; continue }
    const m = LABEL_LINE.exec(line)
    const k = m ? BLOCK_LABELS[m[1].toLowerCase().replace(/[-']/g, ' ').replace(/\s+/g, ' ').trim()] : undefined
    if (m && k) {
      // A second Date, or a second Idea, starts the next post even without a heading.
      if (cur && cur[k] !== undefined && (k === 'date' || k === 'idea' || k === 'trend')) close()
      cur = cur ?? {}
      cur[k] = m[2].trim()
      key = k
    } else if (cur && key && line.trim()) {
      cur[key] = `${cur[key] ?? ''}\n${line.trim()}`.trim()
    }
  }
  close()

  const items: PlanItemInput[] = []
  const skipped: ParsedPlan['skipped'] = []
  for (const b of blocks) {
    const v = (k: BlockKey) => { const x = (b[k] ?? '').replace(/\*\*|__/g, '').trim(); return NOTHING.test(x) ? '' : x }
    const one = (k: BlockKey) => clean(v(k))
    if (Object.keys(b).length < 2) continue
    const slot = isTrendSlot(`${one('idea')} ${one('theme')}`)
    const title = slot ? 'Trend slot (fill from the daily trend check)' : one('idea') || one('trend') || one('theme')
    if (!title) continue
    const row = `${one('date')} ${title}`.trim()
    let date: string | null = null
    if (b.date !== undefined && one('date')) {
      const d = planDate(one('date'), month)
      if (d.outside) { skipped.push({ row, reason: `That date is outside ${month}.` }); continue }
      if (!d.date) { skipped.push({ row, reason: 'Could not read the date.' }); continue }
      date = d.date
    }
    const refs = references(v('refs'))
    const copy = [
      one('hook') && (v('designText') || v('caption') ? `Hook: ${one('hook')}` : one('hook')),
      v('designText') && `Text on design:\n${v('designText')}`,
      v('caption') && `Caption:\n${v('caption')}`,
      one('hashtags'),
    ].filter(Boolean).join('\n\n')
    const notes = [
      one('trend') && one('idea') ? `Trend: ${one('trend')}` : '',
      one('theme') && one('theme') !== title && !slot ? `Theme: ${one('theme')}` : '',
      v('goal') && `Goal: ${v('goal')}`,
      v('visual') && `Visual direction: ${v('visual')}`,
      v('needs') && `Designer needs: ${v('needs')}`,
      v('script') && `Reel script:\n${v('script')}`,
      v('prompt') && `AI prompt (paste into the image or video tool):\n${v('prompt')}`,
      refs.searches.length ? `Reference searches: ${refs.searches.join('; ')}` : '',
      one('postby') && `Post by: ${one('postby')}`,
      one('effort') && `Effort: ${one('effort')}`,
      one('bestday') && `Best day: ${one('bestday')}`,
    ].filter(Boolean).join('\n\n')
    items.push({
      title,
      date,
      content_type: contentTypeOf(one('format')),
      platforms: platformsOf(one('platform')),
      caption: slot ? null : copy || null,
      notes: notes || null,
      asap: slot || !!one('trend'),
      links: [...refs.links, ...refs.searches.slice(0, 3).map(pinterest)].slice(0, 10),
      images: refs.images.slice(0, 8),
    })
  }
  return { kind: items.length || skipped.length ? 'detailed' : 'unknown', items, skipped }
}

/**
 * Read whatever the AI answered: detailed post blocks, tables, or both. An
 * item named twice (an overview table, then its full brief) is kept once, in
 * its fuller form.
 */
export function parsePlan(text: string, month: string): ParsedPlan {
  const blocks = parsePlanBlocks(text, month)
  const table = parsePlanTable(text, month)
  const seen = new Set(blocks.items.map(i => itemKey(i.date, i.title)))
  const extra = table.items.filter(i => !seen.has(itemKey(i.date, i.title)))
  return {
    kind: blocks.kind !== 'unknown' ? 'detailed' : table.kind,
    items: [...blocks.items, ...extra],
    skipped: [...blocks.skipped, ...table.skipped],
  }
}
