/**
 * "Share my pending work" — the summary behind the Share button on My Work.
 *
 * One summary, two shapes: a WhatsApp text message and an image card. Both are
 * built here from the same rows so they can never disagree about what is
 * pending. Pure: no DOM, no database — the image renderer
 * (my-work-share-image.ts) only turns `pendingCardHtml` into a PNG.
 *
 * What goes in:
 *   Pending      — To Do and Working On It (the "Still to do" count on the
 *                  page). Overdue items first, then soonest due, then undated.
 *   With client  — Sent for Review, listed separately because it is waiting on
 *                  someone else, not on this person.
 * Done work is left out: the message is about what is still open.
 */
import { stageOf, stageOfPlan, isPending, type WorkStage } from './my-work'

/** The fields of a My Work row this needs. */
export interface ShareableRow {
  source: 'request' | 'plan'
  ref_no: number | null
  title: string
  status: string
  due_date: string | null
  client_name: string | null
  service_name: string | null
}

export interface ShareItem {
  title: string
  client: string | null
  service: string | null
  /** REQ-0045, or null for planned work, which has no request number. */
  ref: string | null
  due: string | null
  overdue: boolean
  stage: WorkStage
}

export interface PendingSummary {
  /** Who the list belongs to, as shown: "CQID004" or a first name. */
  owner: string
  /** Pending work, overdue first. */
  pending: ShareItem[]
  withClient: ShareItem[]
  overdueCount: number
  /** Today, ISO (YYYY-MM-DD), the day "overdue" was judged against. */
  today: string
}

/** Longest list a WhatsApp message or image carries before "+ N more". */
export const SHARE_LIMIT = 25

const stageOfRow = (r: ShareableRow): WorkStage =>
  r.source === 'plan' ? stageOfPlan(r.status || null) : stageOf(r.status)

function toItem(r: ShareableRow, today: string): ShareItem {
  const stage = stageOfRow(r)
  return {
    title: (r.title || 'Untitled').trim(),
    client: r.client_name?.trim() || null,
    service: r.service_name?.trim() || null,
    ref: r.source === 'request' && r.ref_no ? `REQ-${String(r.ref_no).padStart(4, '0')}` : null,
    due: r.due_date,
    overdue: isPending(stage) && !!r.due_date && r.due_date < today,
    stage,
  }
}

/** Overdue first (oldest first), then soonest due, then undated, then by title. */
function byUrgency(a: ShareItem, b: ShareItem): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
  if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due)
  if (!!a.due !== !!b.due) return a.due ? -1 : 1
  return a.title.localeCompare(b.title)
}

export function buildPendingSummary(owner: string, rows: readonly ShareableRow[], today: string): PendingSummary {
  const items = rows.map(r => toItem(r, today))
  const pending = items.filter(i => isPending(i.stage)).sort(byUrgency)
  const withClient = items.filter(i => i.stage === 'delivered').sort(byUrgency)
  return { owner, pending, withClient, overdueCount: pending.filter(i => i.overdue).length, today }
}

/** "18 Nov" — short, unambiguous, the way the board shows dates. */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function dueText(i: ShareItem, today: string): string {
  if (!i.due) return ''
  if (i.overdue) return `overdue since ${shortDate(i.due)}`
  if (i.due === today) return 'due today'
  return `due ${shortDate(i.due)}`
}

/** One line of the WhatsApp message. */
function textLine(i: ShareItem, today: string): string {
  const meta = [i.client, dueText(i, today), i.ref].filter(Boolean).join(' · ')
  return `${i.overdue ? '🔴' : '•'} ${i.title}${meta ? ` — ${meta}` : ''}`
}

function textSection(heading: string, items: ShareItem[], today: string): string[] {
  if (!items.length) return []
  const shown = items.slice(0, SHARE_LIMIT)
  const lines = [heading, ...shown.map(i => textLine(i, today))]
  if (items.length > shown.length) lines.push(`+ ${items.length - shown.length} more`)
  return lines
}

/**
 * The WhatsApp message. WhatsApp renders *bold*, so headings use it; the
 * rest is plain text that reads the same in any chat app.
 */
export function pendingShareText(s: PendingSummary): string {
  const head = [`*${s.owner} — pending work* (${shortDate(s.today)})`]
  if (!s.pending.length && !s.withClient.length) {
    return [...head, '', 'Nothing pending — all caught up. ✅'].join('\n')
  }
  const counts = [`${s.pending.length} to do`]
  if (s.overdueCount) counts.push(`${s.overdueCount} overdue`)
  if (s.withClient.length) counts.push(`${s.withClient.length} with the client`)
  head.push(counts.join(' · '))

  const body = [
    ...textSection(`*Still to do (${s.pending.length})*`, s.pending, s.today),
    ...(s.pending.length && s.withClient.length ? [''] : []),
    ...textSection(`*With the client (${s.withClient.length})*`, s.withClient, s.today),
  ]
  return [...head, '', ...body].join('\n')
}

/**
 * wa.me link. Without a number WhatsApp asks which chat or group to send to;
 * with one it opens that person's chat. 10-digit numbers are taken as Indian
 * (+91), matching src/lib/invoices/share.ts.
 */
export function whatsappUrl(text: string, phone?: string | null): string {
  let digits = (phone || '').replace(/\D/g, '')
  if (digits.length === 10) digits = '91' + digits
  return `${digits ? `https://wa.me/${digits}` : 'https://wa.me/'}?text=${encodeURIComponent(text)}`
}

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Width of the image card, in CSS pixels (rendered at 2x). */
export const CARD_WIDTH = 720

function cardRows(items: ShareItem[], today: string): string {
  const shown = items.slice(0, SHARE_LIMIT)
  const rows = shown.map(i => {
    const due = dueText(i, today)
    const meta = [i.client, i.service].filter(Boolean).map(x => esc(x as string)).join(' · ')
    return `<div class="row">
      <div class="dot ${i.overdue ? 'late' : i.stage === 'working' ? 'busy' : ''}"></div>
      <div class="body">
        <div class="title">${esc(i.title)}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
      </div>
      <div class="side">
        ${due ? `<span class="due ${i.overdue ? 'late' : i.due === today ? 'today' : ''}">${esc(due)}</span>` : ''}
        ${i.ref ? `<span class="ref">${esc(i.ref)}</span>` : ''}
      </div>
    </div>`
  }).join('')
  const more = items.length > shown.length ? `<div class="more">+ ${items.length - shown.length} more</div>` : ''
  return rows + more
}

/**
 * The image card as a self-contained HTML document (no external requests), so
 * html2canvas renders it the same everywhere. Light, plain and readable on a
 * phone: counts on top, then the two lists.
 */
export function pendingCardHtml(s: PendingSummary): string {
  const empty = !s.pending.length && !s.withClient.length
  const section = (title: string, n: number, items: ShareItem[]) => items.length
    ? `<div class="section"><div class="h">${esc(title)} <span>${n}</span></div>${cardRows(items, s.today)}</div>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{width:${CARD_WIDTH}px;background:#f6f5fb;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15141a;padding:28px}
    .card{background:#fff;border-radius:22px;padding:28px 28px 22px;box-shadow:0 1px 0 rgba(20,10,60,.04),0 12px 32px -18px rgba(40,20,90,.25)}
    .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
    .owner{font-size:30px;font-weight:700;letter-spacing:-.5px}
    .sub{font-size:15px;color:#6b6a78;margin-top:4px}
    .brand{font-size:13px;font-weight:600;color:#7c5cf0;letter-spacing:.4px;text-transform:uppercase;padding-top:6px}
    .stats{display:flex;gap:10px;margin:22px 0 6px}
    .stat{flex:1;border:1px solid #ecebf3;border-radius:14px;padding:12px 14px}
    .stat b{display:block;font-size:26px;font-weight:700;line-height:1.1}
    .stat small{font-size:13px;color:#6b6a78}
    .stat.late{border-color:#fbd0d0;background:#fff6f6}.stat.late b{color:#dc2626}
    .stat.client b{color:#7c3aed}
    .section{margin-top:20px}
    .h{font-size:13px;font-weight:700;color:#6b6a78;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
    .h span{color:#a3a2b1;margin-left:4px}
    .row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid #f0eff6}
    .row:first-of-type{border-top:0}
    .dot{width:9px;height:9px;border-radius:50%;background:#c9c7d6;margin-top:7px;flex:none}
    .dot.late{background:#dc2626}.dot.busy{background:#f59e0b}
    .body{flex:1;min-width:0}
    .title{font-size:17px;font-weight:600;line-height:1.3;word-wrap:break-word}
    .meta{font-size:14px;color:#6b6a78;margin-top:2px}
    .side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none;max-width:210px;text-align:right}
    .due{font-size:13px;font-weight:600;color:#55546a;background:#f3f2f8;border-radius:999px;padding:3px 10px;white-space:nowrap}
    .due.late{color:#b91c1c;background:#fde8e8}.due.today{color:#b45309;background:#fef3c7}
    .ref{font-size:12px;color:#a3a2b1;font-variant-numeric:tabular-nums}
    .more{font-size:14px;color:#6b6a78;padding:10px 0 2px}
    .empty{font-size:18px;color:#15803d;font-weight:600;padding:26px 0 10px;text-align:center}
    .foot{font-size:12px;color:#a3a2b1;text-align:center;margin-top:16px}
  </style></head><body><div class="card">
    <div class="top">
      <div><div class="owner">${esc(s.owner)}</div><div class="sub">Pending work · ${esc(shortDate(s.today))}</div></div>
      <div class="brand">Cirqle</div>
    </div>
    ${empty ? '<div class="empty">Nothing pending — all caught up ✓</div>' : `
    <div class="stats">
      <div class="stat"><b>${s.pending.length}</b><small>Still to do</small></div>
      <div class="stat ${s.overdueCount ? 'late' : ''}"><b>${s.overdueCount}</b><small>Overdue</small></div>
      <div class="stat client"><b>${s.withClient.length}</b><small>With the client</small></div>
    </div>
    ${section('Still to do', s.pending.length, s.pending)}
    ${section('With the client', s.withClient.length, s.withClient)}`}
  </div><div class="foot">Shared from Cirqle · My Work</div></body></html>`
}
