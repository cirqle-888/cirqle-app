/**
 * Team Work Report — what one department delivered for each client in a month.
 *
 * Made to be SHARED with the team (WhatsApp image or text), so it carries no
 * money at all: only counts of work, the people who did it (by CQID) and how
 * the month compares with the one before.
 *
 * What counts as DELIVERED in a month — one piece of work counted once:
 *   · a request marked Completed during the month (status_updated_at), and
 *   · a task finished (done / invoiced / paid) dated in the month that did NOT
 *     come from a request — a promoted request's task is the same work, and it
 *     is already counted through the request. A task counts by its quantity
 *     (nine posters on one task are nine pieces); a request counts once.
 * PLANNED  — Social Calendar items scheduled in the month, not cancelled.
 * POSTED   — calendar items marked posted during the month.
 * OPEN     — requests not finished (to do or in progress) at the time the
 *            report is made; WITH CLIENT — requests sent for review.
 *
 * Pure: the loader (team-work-load.ts) fetches, this decides. Tests need no DB.
 */

export interface TeamWorkInput {
  month: string                       // 'YYYY-MM'
  departmentId: string
  departmentName: string
  /** service id → department id */
  serviceDepartment: ReadonlyMap<string, string | null>
  serviceName: ReadonlyMap<string, string>
  /** client id → its departments (override, else what it buys) */
  clientDepartments: ReadonlyMap<string, readonly string[]>
  clientName: ReadonlyMap<string, string>
  /** employee id → CQID */
  employeeCqid: ReadonlyMap<string, string>
  requests: readonly {
    id: string; client_id: string | null; service_id: string | null; status: string
    status_updated_at: string | null; assigned_employee_id: string | null; promoted_task_id: string | null
    /** For the optional detailed breakdown. */
    title?: string | null
  }[]
  tasks: readonly {
    id: string; client_id: string | null; service_id: string | null; status: string
    task_date: string | null; quantity: number | null; assignees: readonly string[]
    title?: string | null
  }[]
  calendarItems: readonly {
    client_id: string | null; service_id: string | null; status: string
    scheduled_date: string | null; posted_at: string | null
  }[]
  /** Calendar items with no service count toward this department (the Social Calendar's own). */
  calendarDefaultDepartmentId: string | null
  /**
   * Whether open / with-client counts were loaded. They describe today's
   * queue, so only the current month's report has them; default true.
   */
  includeOpen?: boolean
}

export interface ClientWork {
  clientId: string
  client: string
  delivered: number
  /** service name → pieces delivered */
  byService: { service: string; count: number }[]
  lastMonth: number
  planned: number
  posted: number
  open: number
  withClient: number
  /** Each piece of work delivered this month — the optional detailed breakdown, newest first. */
  items: DeliveredItem[]
  /** CQID → pieces this client's work credited, so a hidden client also leaves the team counts. */
  credits: Record<string, number>
}

export interface DeliveredItem {
  title: string
  service: string
  /** 'YYYY-MM-DD' */
  date: string
  count: number
}

export interface TeamWorkReport {
  month: string
  monthLabel: string
  previousMonthLabel: string
  department: string
  delivered: number
  lastMonth: number
  planned: number
  posted: number
  open: number
  withClient: number
  /** False for a past month: open and with-client are not shown at all. */
  openKnown: boolean
  /** Clients with any activity, most delivered first. */
  clients: ClientWork[]
  /** Department clients with nothing delivered, planned or open this month. */
  quiet: { clientId: string; client: string }[]
  /** The same, names only. */
  quietClients: string[]
  /** Last month's pieces by client, so hiding a client keeps the comparison fair. */
  lastMonthByClient: Record<string, number>
  /** CQID → pieces delivered, most first. */
  people: { cqid: string; delivered: number }[]
}

export const DONE_REQUEST = 'completed'
export const DONE_TASK = ['done', 'invoiced', 'paid'] as const
export const OPEN_REQUEST = ['submitted', 'under_review', 'approved', 'started', 'in_progress', 'waiting_for_content', 'revision_requested'] as const
export const WITH_CLIENT_REQUEST = 'delivered'

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const inMonth = (iso: string | null | undefined, month: string) => !!iso && iso.slice(0, 7) === month

export function buildTeamWorkReport(i: TeamWorkInput): TeamWorkReport {
  const prev = previousMonth(i.month)
  const inDept = (serviceId: string | null, clientId: string | null): boolean => {
    if (serviceId) return i.serviceDepartment.get(serviceId) === i.departmentId
    // No service: the client's own department decides.
    return !!clientId && (i.clientDepartments.get(clientId) ?? []).includes(i.departmentId)
  }
  const calendarInDept = (serviceId: string | null): boolean =>
    serviceId ? i.serviceDepartment.get(serviceId) === i.departmentId : i.calendarDefaultDepartmentId === i.departmentId

  const rows = new Map<string, ClientWork & { services: Map<string, number> }>()
  const row = (clientId: string) => {
    let r = rows.get(clientId)
    if (!r) {
      r = { clientId, client: i.clientName.get(clientId) ?? 'Unknown client', delivered: 0, byService: [], lastMonth: 0,
        planned: 0, posted: 0, open: 0, withClient: 0, items: [], credits: {}, services: new Map() }
      rows.set(clientId, r)
    }
    return r
  }
  const credit = (w: ClientWork, employeeId: string | null, n: number) => {
    const cqid = employeeId ? i.employeeCqid.get(employeeId) : null
    if (cqid) w.credits[cqid] = (w.credits[cqid] ?? 0) + n
  }
  const itemTitle = (t: string | null | undefined, service: string) => (t ?? '').replace(/\s+/g, ' ').trim() || service
  const serviceLabel = (id: string | null) => (id && i.serviceName.get(id)) || 'Other work'

  // Requests
  const promoted = new Set(i.requests.map(r => r.promoted_task_id).filter((x): x is string => !!x))
  for (const r of i.requests) {
    if (!r.client_id || !inDept(r.service_id, r.client_id)) continue
    if (r.status === DONE_REQUEST && inMonth(r.status_updated_at, i.month)) {
      const w = row(r.client_id)
      const service = serviceLabel(r.service_id)
      w.delivered += 1
      w.services.set(service, (w.services.get(service) ?? 0) + 1)
      w.items.push({ title: itemTitle(r.title, service), service, date: r.status_updated_at!.slice(0, 10), count: 1 })
      credit(w, r.assigned_employee_id, 1)
    } else if (r.status === DONE_REQUEST && inMonth(r.status_updated_at, prev)) {
      row(r.client_id).lastMonth += 1
    } else if ((OPEN_REQUEST as readonly string[]).includes(r.status)) {
      row(r.client_id).open += 1
    } else if (r.status === WITH_CLIENT_REQUEST) {
      row(r.client_id).withClient += 1
    }
  }

  // Tasks that did not come from a request
  for (const t of i.tasks) {
    if (!t.client_id || promoted.has(t.id) || !inDept(t.service_id, t.client_id)) continue
    if (!(DONE_TASK as readonly string[]).includes(t.status)) continue
    const n = Math.max(1, Math.round(t.quantity ?? 1))
    if (inMonth(t.task_date, i.month)) {
      const w = row(t.client_id)
      const service = serviceLabel(t.service_id)
      w.delivered += n
      w.services.set(service, (w.services.get(service) ?? 0) + n)
      w.items.push({ title: itemTitle(t.title, service), service, date: t.task_date!.slice(0, 10), count: n })
      // Shared work is credited to each person on it — it is a count of
      // involvement for the team view, not a split of anything.
      for (const e of t.assignees) credit(w, e, n)
    } else if (inMonth(t.task_date, prev)) {
      row(t.client_id).lastMonth += n
    }
  }

  // Social Calendar
  for (const c of i.calendarItems) {
    if (!c.client_id || c.status === 'cancelled' || !calendarInDept(c.service_id)) continue
    if (inMonth(c.scheduled_date, i.month)) row(c.client_id).planned += 1
    if (inMonth(c.posted_at, i.month)) row(c.client_id).posted += 1
  }

  const clients = [...rows.values()]
    .filter(r => r.delivered || r.planned || r.posted || r.open || r.withClient)
    .map(({ services, ...r }) => ({
      ...r,
      byService: [...services].map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count),
      items: [...r.items].sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => b.delivered - a.delivered || b.planned - a.planned || a.client.localeCompare(b.client))

  const active = new Set(clients.map(c => c.clientId))
  const quiet = [...i.clientDepartments]
    .filter(([id, depts]) => depts.includes(i.departmentId) && !active.has(id) && i.clientName.has(id))
    .map(([id]) => ({ clientId: id, client: i.clientName.get(id)! }))
    .sort((a, b) => a.client.localeCompare(b.client))

  const lastMonthByClient: Record<string, number> = {}
  for (const r of rows.values()) if (r.lastMonth) lastMonthByClient[r.clientId] = r.lastMonth

  return totals({
    month: i.month,
    monthLabel: monthLabel(i.month),
    previousMonthLabel: monthLabel(prev),
    department: i.departmentName,
    openKnown: i.includeOpen !== false,
    clients,
    quiet,
    lastMonthByClient,
  })
}

type ReportParts = Pick<TeamWorkReport,
  'month' | 'monthLabel' | 'previousMonthLabel' | 'department' | 'openKnown' | 'clients' | 'quiet' | 'lastMonthByClient'>

/** Every total is worked out from the clients, so a report with some clients removed adds up. */
function totals(p: ReportParts): TeamWorkReport {
  const sum = (k: 'delivered' | 'planned' | 'posted' | 'open' | 'withClient') => p.clients.reduce((s, c) => s + c[k], 0)
  const people = new Map<string, number>()
  for (const c of p.clients) for (const [cqid, n] of Object.entries(c.credits)) people.set(cqid, (people.get(cqid) ?? 0) + n)
  return {
    ...p,
    delivered: sum('delivered'),
    lastMonth: Object.values(p.lastMonthByClient).reduce((s, n) => s + n, 0),
    planned: sum('planned'),
    posted: sum('posted'),
    open: sum('open'),
    withClient: sum('withClient'),
    quietClients: p.quiet.map(q => q.client),
    people: [...people].map(([cqid, delivered]) => ({ cqid, delivered })).sort((a, b) => b.delivered - a.delivered || a.cqid.localeCompare(b.cqid)),
  }
}

/**
 * The report without the clients someone chose to leave out of the share.
 * Totals, last month's comparison and the team counts drop with them.
 */
export function withoutClients(r: TeamWorkReport, hidden: ReadonlySet<string>): TeamWorkReport {
  if (!hidden.size) return r
  return totals({
    ...r,
    clients: r.clients.filter(c => !hidden.has(c.clientId)),
    quiet: r.quiet.filter(q => !hidden.has(q.clientId)),
    lastMonthByClient: Object.fromEntries(Object.entries(r.lastMonthByClient).filter(([id]) => !hidden.has(id))),
  })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const shortMonth = (label: string) => label.split(' ')[0]

/**
 * The awareness line: plainly, this is all we have done for our clients.
 * The report is shared to make the team aware of the gap, so it says "only"
 * and names how many clients were covered out of all of them.
 */
export function headline(r: TeamWorkReport): string {
  const covered = r.clients.filter(c => c.delivered).length
  const total = r.clients.length + r.quietClients.length
  const when = r.openKnown ? `So far in ${shortMonth(r.monthLabel)}` : `In ${shortMonth(r.monthLabel)}`
  const clients = plural(total, 'client')
  if (!r.delivered) {
    return r.openKnown
      ? `${when} we have not delivered anything yet for any of our ${clients} — please be aware.`
      : `${when} we did not deliver anything for any of our ${clients} — please be aware.`
  }
  const work = `${plural(r.delivered, 'piece')} of work for ${covered} of our ${clients}`
  return r.openKnown
    ? `${when} we have only done ${work} — please be aware.`
    : `${when} we only did ${work} — please be aware.`
}

/** The follow-up: how it compares with last month and what to do about it. */
export function nudge(r: TeamWorkReport): string {
  const parts: string[] = []
  const prev = shortMonth(r.previousMonthLabel)
  if (r.lastMonth) {
    const diff = r.delivered - r.lastMonth
    parts.push(diff < 0 ? `That is ${-diff} fewer than ${prev}.` : diff > 0 ? `That is ${diff} more than ${prev}.` : `That is the same as ${prev}.`)
  }
  const quiet = r.quietClients.length
  if (quiet) parts.push(`${plural(quiet, 'client')} ${quiet === 1 ? 'has' : 'have'} had nothing${r.openKnown ? ' yet' : ''} — let's make sure every client gets their work 💪`)
  else if (r.delivered) parts.push('Every client has had work — great going, let\'s keep it up 🙌')
  return parts.join(' ')
}

/** Choices for what a shared report includes. */
export interface ShareOptions {
  /** Show each person's count by CQID. Off by default: the report is about the clients. */
  showTeam?: boolean
  /** List each piece of work under its client. Off by default: the summary is the message. */
  showDetails?: boolean
}

/** Most pieces listed under one client in the image; the text lists more. */
export const CARD_ITEMS_PER_CLIENT = 12
const TEXT_ITEMS_PER_CLIENT = 40

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
const itemLine = (it: DeliveredItem) =>
  `${shortDate(it.date)} · ${it.title}${it.count > 1 ? ` ×${it.count}` : ''}${it.title === it.service ? '' : ` (${it.service})`}`

/** The WhatsApp message. */
export function teamWorkText(r: TeamWorkReport, opts: ShareOptions = {}): string {
  const lines = [`📢 *${r.department} — ${r.monthLabel}*`, '', headline(r)]
  const n = nudge(r)
  if (n) lines.push(n)
  lines.push('')
  const stat = [`✅ ${r.delivered} delivered`]
  if (r.planned) stat.push(`🗓 ${r.planned} planned`)
  if (r.posted) stat.push(`📣 ${r.posted} posted`)
  if (r.open) stat.push(`⏳ ${r.open} open`)
  if (r.withClient) stat.push(`👀 ${r.withClient} with clients`)
  lines.push(stat.join(' · '), '')
  if (r.clients.length) {
    lines.push('*By client*')
    for (const c of r.clients) {
      const parts = [`${c.delivered} done`]
      if (c.planned) parts.push(`${c.planned} planned`)
      if (c.open) parts.push(`${c.open} open`)
      lines.push(`• ${c.client} — ${parts.join(' · ')}`)
      if (opts.showDetails) {
        for (const it of c.items.slice(0, TEXT_ITEMS_PER_CLIENT)) lines.push(`   – ${itemLine(it)}`)
        if (c.items.length > TEXT_ITEMS_PER_CLIENT) lines.push(`   – and ${c.items.length - TEXT_ITEMS_PER_CLIENT} more`)
      }
    }
    lines.push('')
  }
  if (r.quietClients.length) {
    lines.push(`*Nothing yet this month (${r.quietClients.length})*`, r.quietClients.join(', '), '')
  }
  if (opts.showTeam && r.people.length) {
    lines.push('*Team*', r.people.map(p => `${p.cqid} ${p.delivered}`).join(' · '))
  }
  return lines.join('\n').trim()
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const TEAM_CARD_WIDTH = 760

/** Self-contained HTML for the shareable image (rendered with html2canvas). */
export function teamWorkCardHtml(r: TeamWorkReport, opts: ShareOptions = {}): string {
  const max = Math.max(1, ...r.clients.map(c => c.delivered))
  const clientRows = r.clients.map(c => `
    <div class="row">
      <div class="name">${esc(c.client)}
        <div class="svc">${c.byService.map(s => `${s.count} ${esc(s.service)}`).join(' · ') || 'Nothing delivered yet'}</div>
      </div>
      <div class="bar"><span style="width:${Math.round((c.delivered / max) * 100)}%"></span></div>
      <div class="num">${c.delivered}</div>
      <div class="meta">${c.planned ? `${c.planned} planned` : ''}${c.planned && c.open ? ' · ' : ''}${c.open ? `${c.open} open` : ''}</div>
      ${opts.showDetails && c.items.length ? `<ul class="items">${c.items.slice(0, CARD_ITEMS_PER_CLIENT).map(it =>
        `<li><span class="d">${esc(shortDate(it.date))}</span>${esc(it.title)}${it.count > 1 ? ` <b>×${it.count}</b>` : ''}${it.title === it.service ? '' : `<span class="s">${esc(it.service)}</span>`}</li>`).join('')}${
        c.items.length > CARD_ITEMS_PER_CLIENT ? `<li class="more">and ${c.items.length - CARD_ITEMS_PER_CLIENT} more</li>` : ''}</ul>` : ''}
    </div>`).join('')
  const stat = (n: number, label: string, cls = '') => `<div class="stat ${cls}"><b>${n}</b><small>${label}</small></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{width:${TEAM_CARD_WIDTH}px;background:#f6f5fb;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15141a;padding:28px}
    .card{background:#fff;border-radius:22px;padding:30px;box-shadow:0 12px 32px -18px rgba(40,20,90,.25)}
    .top{display:flex;justify-content:space-between;align-items:flex-start}
    .dept{font-size:13px;font-weight:700;color:#7c5cf0;letter-spacing:.8px;text-transform:uppercase}
    .month{font-size:30px;font-weight:700;letter-spacing:-.5px;margin-top:4px}
    .brand{font-size:13px;font-weight:600;color:#a3a2b1}
    .head{margin-top:14px;font-size:17px;font-weight:600;color:#3b3a4a;line-height:1.4}
    .nudge{margin-top:6px;font-size:14px;color:#6b6a78;line-height:1.45}
    .stats{display:flex;gap:10px;margin:20px 0 8px}
    .stat{flex:1;border:1px solid #ecebf3;border-radius:14px;padding:12px 14px}
    .stat b{display:block;font-size:26px;font-weight:700;line-height:1.1}.stat small{font-size:13px;color:#6b6a78}
    .stat.good{background:#f3f0ff;border-color:#e2dafe}.stat.good b{color:#6d28d9}
    .h{font-size:13px;font-weight:700;color:#6b6a78;text-transform:uppercase;letter-spacing:.6px;margin:20px 0 4px}
    .row{display:grid;grid-template-columns:1fr 170px 40px;gap:4px 14px;align-items:center;padding:11px 0;border-top:1px solid #f0eff6}
    .row:first-of-type{border-top:0}
    .name{font-size:16px;font-weight:600;line-height:1.3}
    .svc{font-size:13px;color:#6b6a78;font-weight:400;margin-top:2px}
    .bar{height:10px;background:#f1effa;border-radius:999px;overflow:hidden}
    .bar span{display:block;height:100%;background:linear-gradient(90deg,#a855f7,#6366f1);border-radius:999px}
    .num{font-size:20px;font-weight:700;text-align:right}
    .meta{grid-column:1 / -1;font-size:12px;color:#a3a2b1;margin-top:-4px}
    .meta:empty{display:none}
    .items{grid-column:1 / -1;list-style:none;margin:4px 0 0;padding:8px 12px;background:#faf9fd;border-radius:10px}
    .items li{font-size:13px;color:#3b3a4a;line-height:1.5;padding:2px 0}
    .items .d{display:inline-block;width:52px;color:#a3a2b1;font-weight:600}
    .items .s{color:#a3a2b1;margin-left:6px}.items .s::before{content:'· '}
    .items b{color:#6d28d9}.items .more{color:#a3a2b1;padding-left:52px}
    .quiet{font-size:14px;color:#55546a;line-height:1.6}
    .people{display:flex;flex-wrap:wrap;gap:8px}
    .p{background:#f3f2f8;border-radius:999px;padding:6px 12px;font-size:14px;font-weight:600}
    .p span{color:#7c5cf0;margin-left:6px}
    .foot{font-size:12px;color:#a3a2b1;text-align:center;margin-top:16px}
  </style></head><body><div class="card">
    <div class="top"><div><div class="dept">${esc(r.department)}</div><div class="month">${esc(r.monthLabel)}</div></div><div class="brand">Cirqle</div></div>
    <div class="head">${esc(headline(r))}</div>
    ${nudge(r) ? `<div class="nudge">${esc(nudge(r))}</div>` : ''}
    <div class="stats">
      ${stat(r.delivered, 'Delivered', 'good')}${stat(r.planned, 'Planned')}${r.posted ? stat(r.posted, 'Posted') : ''}${r.openKnown ? stat(r.open, 'Still open') : stat(r.quietClients.length, 'Clients with nothing')}
    </div>
    ${r.clients.length ? `<div class="h">By client</div>${clientRows}` : ''}
    ${r.quietClients.length ? `<div class="h">Nothing yet this month · ${r.quietClients.length}</div><div class="quiet">${r.quietClients.map(esc).join(' · ')}</div>` : ''}
    ${opts.showTeam && r.people.length ? `<div class="h">Team</div><div class="people">${r.people.map(p => `<div class="p">${esc(p.cqid)}<span>${p.delivered}</span></div>`).join('')}</div>` : ''}
  </div><div class="foot">Shared from Cirqle · Team Work Report</div></body></html>`
}
