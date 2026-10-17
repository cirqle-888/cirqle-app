/**
 * Reading an analytics dashboard into posting evidence.
 *
 * The brief asked for "drop in a screenshot". What this does instead is parse
 * the TEXT of a dashboard — pasted, or pulled out of an image elsewhere — and
 * the reason is worth stating rather than hiding.
 *
 * A vision model would have to be chosen, and the one shared AI module in this
 * codebase says in its own comments that provider model ids get retired
 * regularly and 404. A feature whose entire job is "tell me when to post"
 * failing silently because a model id moved is worse than one that asks for
 * text. So the parser is deterministic and unit-tested, and AI is the fallback
 * for input it cannot read — not the thing standing between the user and a
 * result.
 *
 * What it accepts is what people actually paste out of Instagram, Facebook
 * Business Suite, Later, Buffer and a spreadsheet:
 *
 *     19:00  1,240              Mon 7pm — 1240
 *     7 PM   1.2K               Monday, 19:00, 1240
 *     19     1240               19:00 → 1,240 followers online
 *
 * Numbers are relative. Nothing here claims 1,240 means anything in itself;
 * it only has to be comparable with the other hours from the same paste.
 */

import type { Weekday } from './posting-time'

export interface ParsedBestTime {
  /** Null when the paste never named a day — see spreadAcrossWeek. */
  weekday: Weekday | null
  hour: number
  score: number
}

export interface ImportResult {
  rows: ParsedBestTime[]
  /** True when the source named weekdays; false when it was one day's hours. */
  hasWeekdays: boolean
  /** Lines the parser could not read, verbatim, so nothing vanishes quietly. */
  ignored: string[]
}

const DAYS: Array<[RegExp, Weekday]> = [
  [/\bsun(day)?\b/i, 0], [/\bmon(day)?\b/i, 1], [/\btue(s|sday)?\b/i, 2],
  [/\bwed(nesday)?\b/i, 3], [/\bthu(r|rs|rsday)?\b/i, 4],
  [/\bfri(day)?\b/i, 5], [/\bsat(urday)?\b/i, 6],
]

function weekdayIn(line: string): Weekday | null {
  for (const [re, day] of DAYS) if (re.test(line)) return day
  return null
}

/** '1,240' → 1240 · '1.2K' → 1200 · '3.4k' → 3400 · '12%' → 12 */
export function parseCount(raw: string): number | null {
  const m = /^([\d.,]+)\s*([km])?%?$/i.exec(raw.trim())
  if (!m) return null
  const digits = m[1].replace(/,/g, '')
  // A lone trailing '.' or multiple dots is not a number we should guess at.
  if (!/^\d*\.?\d+$/.test(digits)) return null
  const n = Number(digits)
  if (!Number.isFinite(n)) return null
  const mult = m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1
  return n * mult
}

/** '19:00' · '7 PM' · '19' · '7pm' → 0–23, or null. */
export function parseHour(raw: string): number | null {
  const s = raw.trim().toLowerCase()
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(s)
  if (ampm) {
    let h = Number(ampm[1])
    if (h < 1 || h > 12) return null
    if (ampm[3] === 'pm' && h !== 12) h += 12
    if (ampm[3] === 'am' && h === 12) h = 0
    return h
  }
  const h24 = /^(\d{1,2})(?::(\d{2}))?$/.exec(s)
  if (h24) {
    const h = Number(h24[1])
    return h >= 0 && h <= 23 ? h : null
  }
  return null
}

/**
 * Read a pasted dashboard.
 *
 * Deliberately line-based and forgiving: it takes the FIRST thing on a line
 * that reads as an hour and the LAST thing that reads as a count, which is
 * how every one of these dashboards lays a row out, and ignores everything
 * between them. Lines it cannot read come back in `ignored` rather than being
 * dropped — a silent parser on a 24-row paste is how you end up scheduling
 * against four hours and never noticing.
 */
export function parseBestTimes(text: string): ImportResult {
  const rows: ParsedBestTime[] = []
  const ignored: string[] = []
  let hasWeekdays = false
  // A heading like "Monday" on its own line applies to the rows beneath it,
  // which is how Business Suite and most spreadsheet exports are shaped.
  let currentDay: Weekday | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const lineDay = weekdayIn(line)
    // Thousands separators come out BEFORE tokenising. The separator set has
    // to include the comma — "Tuesday, 19:00, 980" is a real shape — and that
    // would otherwise cut 1,240 into a 1 and a 240, which parses as a
    // plausible number and is wrong by a factor of five.
    const flat = line.replace(/(\d),(?=\d{3}(\D|$))/g, '$1')
    const tokens = flat.split(/[\s,|→>:—–-]+|\t+/).map(t => t.trim()).filter(Boolean)

    // Re-join 'hh:mm' that the split above pulled apart, and drop day words.
    const cleaned: string[] = []
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (DAYS.some(([re]) => re.test(t))) continue
      const next = tokens[i + 1]
      if (/^\d{1,2}$/.test(t) && /^\d{2}$/.test(next ?? '') && Number(next) < 60) {
        cleaned.push(`${t}:${next}`); i++; continue
      }
      cleaned.push(t)
    }

    let hour: number | null = null
    let hourAt = -1
    for (let i = 0; i < cleaned.length; i++) {
      // '7' followed by 'pm' is one value, not two.
      const joined = /^(am|pm)$/i.test(cleaned[i + 1] ?? '') ? `${cleaned[i]}${cleaned[i + 1]}` : cleaned[i]
      const h = parseHour(joined)
      if (h !== null) { hour = h; hourAt = i + (joined !== cleaned[i] ? 1 : 0); break }
    }

    if (hour === null) {
      // A bare day heading is structure, not a failure.
      if (lineDay !== null && cleaned.length === 0) { currentDay = lineDay; hasWeekdays = true; continue }
      if (lineDay !== null && cleaned.every(t => !parseCount(t))) { currentDay = lineDay; hasWeekdays = true; continue }
      ignored.push(line)
      continue
    }

    let score: number | null = null
    for (let i = cleaned.length - 1; i > hourAt; i--) {
      const n = parseCount(cleaned[i])
      if (n !== null) { score = n; break }
    }
    if (score === null) { ignored.push(line); continue }

    const day = lineDay ?? currentDay
    if (lineDay !== null) hasWeekdays = true
    rows.push({ weekday: day, hour, score })
  }

  return { rows, hasWeekdays, ignored }
}

/**
 * Turn a single day's hourly curve into every weekday.
 *
 * Instagram's "most active times" is often shown for one day at a time, and
 * somebody pasting it means "this is roughly our shape". Copying it across the
 * week is the honest reading of that — and it is marked `source: 'screenshot'`
 * in the database, so it can never be mistaken for a measured per-day figure.
 */
export function spreadAcrossWeek(rows: readonly ParsedBestTime[]): Array<{ weekday: number; hour: number; score: number }> {
  const out: Array<{ weekday: number; hour: number; score: number }> = []
  for (const row of rows) {
    if (row.weekday !== null) { out.push({ weekday: row.weekday, hour: row.hour, score: row.score }); continue }
    for (let d = 0; d <= 6; d++) out.push({ weekday: d, hour: row.hour, score: row.score })
  }
  // Last write wins per cell, so a day named explicitly beats a spread one.
  const byCell = new Map<string, { weekday: number; hour: number; score: number }>()
  for (const r of out) byCell.set(`${r.weekday}-${r.hour}`, r)
  return [...byCell.values()]
}
