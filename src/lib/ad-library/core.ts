/**
 * Ad Library — shared rules for ads saved from the Facebook Ad Library.
 *
 * Used by three callers that must agree: the extension's API
 * (/api/ad-library), the dashboard's server actions, and the page. Everything
 * that arrives from the extension is page text scraped from facebook.com, so
 * every field is cleaned here, again, whatever the extension sent.
 */

export const AD_BUCKET = 'ad-library'
export const MAX_MEDIA = 10

export type AdMediaKind = 'image' | 'video'
export interface AdMedia { kind: AdMediaKind; path: string; poster: string | null }

export interface SavedAd {
  id: string
  library_id: string
  platform: string
  status: 'active' | 'inactive' | null
  page_name: string | null
  page_url: string | null
  page_avatar: string | null
  body: string | null
  headline: string | null
  link_caption: string | null
  landing_url: string | null
  cta: string | null
  started_on: string | null
  ended_on: string | null
  multiple_versions: boolean
  media: AdMedia[]
  folder_id: string | null
  client_id: string | null
  tags: string[]
  notes: string | null
  source_url: string | null
  saved_by: string | null
  created_at: string
}

export interface AdFolder { id: string; name: string; sort: number }

/** The fields the extension may set on a saved ad. */
export interface IncomingAd {
  library_id: string
  status: 'active' | 'inactive' | null
  page_name: string | null
  page_url: string | null
  body: string | null
  headline: string | null
  link_caption: string | null
  landing_url: string | null
  cta: string | null
  started_on: string | null
  ended_on: string | null
  multiple_versions: boolean
  source_url: string | null
}

// ── small cleaners ───────────────────────────────────────────────────────────

export function cleanText(v: unknown, max = 300): string | null {
  if (typeof v !== 'string') return null
  // Drop zero-width and control characters Facebook sprinkles through its markup.
  const s = v.replace(/[​-‍﻿]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return s ? s.slice(0, max) : null
}

export function cleanUrl(v: unknown, hosts?: RegExp): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const u = new URL(v.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (hosts && !hosts.test(u.hostname)) return null
    return u.toString().slice(0, 1000)
  } catch { return null }
}

export const FB_HOSTS = /(^|\.)(facebook\.com|instagram\.com|fb\.com)$/i

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/** "20 Oct 2026", "Oct 20, 2026" or "2026-10-20" → "2026-10-20". Anything else → null. */
export function parseAdDate(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  let y: number, m: number, d: number
  let r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (r) { y = +r[1]; m = +r[2]; d = +r[3] }
  else if ((r = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) { d = +r[1]; m = MONTHS[r[2].slice(0, 4).toLowerCase()] ?? MONTHS[r[2].slice(0, 3).toLowerCase()]; y = +r[3] }
  else if ((r = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) { m = MONTHS[r[1].slice(0, 4).toLowerCase()] ?? MONTHS[r[1].slice(0, 3).toLowerCase()]; d = +r[2]; y = +r[3] }
  else return null
  if (!m || d < 1 || d > 31 || y < 2004 || y > 2100) return null
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const t = new Date(iso + 'T00:00:00Z')
  return Number.isNaN(t.getTime()) || t.getUTCDate() !== d ? null : iso
}

/** Days an ad has run: start to end, or start to today if still running. */
export function daysRunning(started: string | null, ended: string | null, today: string): number | null {
  if (!started) return null
  const a = Date.parse(started + 'T00:00:00Z')
  const b = Date.parse((ended || today) + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null
  return Math.round((b - a) / 86_400_000) + 1
}

export function isLibraryId(v: unknown): v is string {
  return typeof v === 'string' && /^\d{6,25}$/.test(v)
}

export function cleanTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  const out: string[] = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    const s = t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 30)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= 12) break
  }
  return out
}

// ── incoming ad (from the extension) ─────────────────────────────────────────

export function cleanIncomingAd(raw: unknown): IncomingAd | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = typeof r.library_id === 'string' ? r.library_id.trim() : typeof r.library_id === 'number' ? String(r.library_id) : ''
  if (!isLibraryId(id)) return null
  const status = r.status === 'active' || r.status === 'inactive' ? r.status : null
  const started = parseAdDate(r.started_on)
  let ended = parseAdDate(r.ended_on)
  if (started && ended && ended < started) ended = null
  return {
    library_id: id,
    status,
    page_name: cleanText(r.page_name, 200),
    page_url: cleanUrl(r.page_url, FB_HOSTS),
    body: cleanText(r.body, 5000),
    headline: cleanText(r.headline, 300),
    link_caption: cleanText(r.link_caption, 120),
    landing_url: cleanUrl(r.landing_url),
    cta: cleanText(r.cta, 40),
    started_on: started,
    ended_on: ended,
    multiple_versions: r.multiple_versions === true,
    source_url: cleanUrl(r.source_url, FB_HOSTS),
  }
}

// ── media files ──────────────────────────────────────────────────────────────

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' }

export function extFor(contentType: unknown, kind: AdMediaKind): string {
  const t = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : ''
  return EXT[t] ?? (kind === 'video' ? 'mp4' : 'jpg')
}

/** Where file number `n` of an ad lives in the bucket. */
export function mediaPath(libraryId: string, n: number, role: 'image' | 'video' | 'poster' | 'avatar', ext: string): string {
  return `fb/${libraryId}/${role}-${n}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'}`
}

/** Only paths under this ad's own folder are accepted back from the extension. */
export function ownsPath(libraryId: string, p: unknown): p is string {
  return typeof p === 'string' && p.startsWith(`fb/${libraryId}/`) && /^fb\/\d+\/(image|video|poster|avatar)-\d+\.[a-z0-9]{1,5}$/i.test(p)
}

export function cleanMedia(libraryId: string, raw: unknown): AdMedia[] {
  if (!Array.isArray(raw)) return []
  const out: AdMedia[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const r = m as Record<string, unknown>
    const kind: AdMediaKind = r.kind === 'video' ? 'video' : 'image'
    if (!ownsPath(libraryId, r.path)) continue
    out.push({ kind, path: r.path, poster: ownsPath(libraryId, r.poster) ? r.poster : null })
    if (out.length >= MAX_MEDIA) break
  }
  return out
}

/** Media as stored in the database row (already trusted). */
export function readMedia(raw: unknown): AdMedia[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((m): m is AdMedia => !!m && typeof m === 'object' && typeof (m as AdMedia).path === 'string')
    .map(m => ({ kind: m.kind === 'video' ? 'video' : 'image', path: m.path, poster: typeof m.poster === 'string' ? m.poster : null }))
}

export function cleanSavedAd(row: Record<string, unknown>): SavedAd {
  const s = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : null)
  return {
    id: String(row.id), library_id: String(row.library_id), platform: s('platform') || 'facebook',
    status: row.status === 'active' || row.status === 'inactive' ? row.status : null,
    page_name: s('page_name'), page_url: s('page_url'), page_avatar: s('page_avatar'),
    body: s('body'), headline: s('headline'), link_caption: s('link_caption'), landing_url: s('landing_url'), cta: s('cta'),
    started_on: s('started_on'), ended_on: s('ended_on'), multiple_versions: row.multiple_versions === true,
    media: readMedia(row.media), folder_id: s('folder_id'), client_id: s('client_id'),
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    notes: s('notes'), source_url: s('source_url'), saved_by: s('saved_by'), created_at: s('created_at') || '',
  }
}

export function adLibraryLink(libraryId: string): string {
  return `https://www.facebook.com/ads/library/?id=${libraryId}`
}

// ── export ───────────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s
  return '"' + safe.replace(/"/g, '""') + '"'
}

export function adsToCsv(ads: SavedAd[], folderName: (id: string | null) => string, clientName: (id: string | null) => string, today: string): string {
  const head = ['Library ID', 'Ad Library link', 'Page', 'Status', 'Started', 'Ended', 'Days running', 'Text', 'Headline', 'Link caption', 'Landing page', 'Button', 'Media', 'Folder', 'Client', 'Tags', 'Notes', 'Saved on']
  const rows = ads.map(a => [
    a.library_id, adLibraryLink(a.library_id), a.page_name, a.status, a.started_on, a.ended_on,
    daysRunning(a.started_on, a.status === 'active' ? null : a.ended_on, today),
    a.body, a.headline, a.link_caption, a.landing_url, a.cta,
    a.media.map(m => m.kind).join(' + '), folderName(a.folder_id), clientName(a.client_id), a.tags.join(', '), a.notes,
    a.created_at.slice(0, 10),
  ])
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')
}
