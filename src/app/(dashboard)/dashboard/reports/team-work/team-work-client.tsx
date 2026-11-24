'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Share2, Copy, Download, MessageCircle, Image as ImageIcon, Loader2, Check, X as XIcon, Users, ListChecks, ListTree, EyeOff } from 'lucide-react'
import Header from '@/components/layout/header'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { isNative } from '@/lib/native'
import { shareContent, saveBase64File, writeClipboard } from '@/lib/native-capabilities'
import { renderPendingCard, blobToBase64 } from '@/lib/requests/my-work-share-image'
import { whatsappUrl } from '@/lib/requests/my-work-share'
import {
  headline, nudge, previousMonth, shortDate, withoutClients, teamWorkText, teamWorkCardHtml, TEAM_CARD_WIDTH,
  type TeamWorkReport, type ShareOptions,
} from '@/lib/reports/team-work'

interface Props {
  report: TeamWorkReport | null
  departments: { id: string; name: string }[]
  departmentId: string
  month: string
  thisMonth: string
}

function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

// Left-out clients live in this browser's storage (per department), with a
// copy in memory so a private window still works for the visit.
const HIDDEN_EVENT = 'team-work-hidden'
const hiddenMemory = new Map<string, string>()
function readHidden(key: string): string {
  if (hiddenMemory.has(key)) return hiddenMemory.get(key)!
  try { return localStorage.getItem(key) || '[]' } catch { return '[]' }
}
function writeHidden(key: string, value: string) {
  hiddenMemory.set(key, value)
  try { localStorage.setItem(key, value) } catch { /* memory copy is enough for now */ }
  window.dispatchEvent(new Event(HIDDEN_EVENT))
}
function subscribeHidden(cb: () => void) {
  window.addEventListener(HIDDEN_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => { window.removeEventListener(HIDDEN_EVENT, cb); window.removeEventListener('storage', cb) }
}

export default function TeamWorkClient({ report: full, departments, departmentId, month, thisMonth }: Props) {
  const router = useRouter()
  const [sharing, setSharing] = useState(false)
  const [picking, setPicking] = useState(false)
  // Who did what (by CQID) and the piece-by-piece list are optional — off by
  // default, for the page and the share alike.
  const [showTeam, setShowTeam] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  // Clients left out of the report, remembered per department on this device.
  const storageKey = `team-work-hidden:${departmentId}`
  const hiddenRaw = useSyncExternalStore(subscribeHidden, () => readHidden(storageKey), () => '[]')
  const hidden = useMemo(() => {
    try { return new Set(JSON.parse(hiddenRaw) as string[]) } catch { return new Set<string>() }
  }, [hiddenRaw])
  const saveHidden = (next: Set<string>) => writeHidden(storageKey, JSON.stringify([...next]))
  const hide = (id: string) => saveHidden(new Set(hidden).add(id))

  const allClients = useMemo(() => full
    ? [...full.clients.map(c => ({ clientId: c.clientId, client: c.client, delivered: c.delivered })),
       ...full.quiet.map(q => ({ ...q, delivered: 0 }))]
    : [], [full])
  // Only ids that are in this month's report count as hidden.
  const hiddenHere = allClients.filter(c => hidden.has(c.clientId)).length
  const report = useMemo(() => full && withoutClients(full, hidden), [full, hidden])
  const shareOpts = useMemo(() => ({ showTeam, showDetails }), [showTeam, showDetails])

  const go = (m: string, dept = departmentId) => router.push(`/dashboard/reports/team-work?month=${m}&dept=${dept}`)
  const isCurrent = month === thisMonth
  const max = report ? Math.max(1, ...report.clients.map(x => x.delivered)) : 1

  return (
    <div className="space-y-5 pb-10">
      <Header
        title="Team Work Report"
        subtitle="What each department delivered for every client this month — to share with the team"
      />

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Department"
          value={departmentId}
          onChange={e => go(month, e.target.value)}
          className="h-10 rounded-lg border border-border bg-secondary px-3 text-sm"
        >
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="flex items-center rounded-lg border border-border bg-secondary">
          <button aria-label="Previous month" onClick={() => go(previousMonth(month))} className="h-10 w-10 inline-flex items-center justify-center text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-2 text-sm font-medium min-w-[9rem] text-center">{report?.monthLabel ?? month}</span>
          <button aria-label="Next month" disabled={isCurrent} onClick={() => go(nextMonth(month))} className="h-10 w-10 inline-flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        {report && (
          <>
            <button onClick={() => setPicking(true)} className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-border bg-secondary text-sm">
              <ListChecks className="w-4 h-4 text-muted-foreground" /> Clients
              <span className="text-muted-foreground tabular-nums">{allClients.length - hiddenHere}/{allClients.length}</span>
            </button>
            <Toggle on={showDetails} onChange={setShowDetails} icon={ListTree} label="Details" />
            {full!.people.length > 0 && <Toggle on={showTeam} onChange={setShowTeam} icon={Users} label="Show team" />}
            <button
              onClick={() => setSharing(true)}
              className="sm:ml-auto inline-flex items-center gap-1.5 h-10 px-4 rounded-lg gradient-bg text-white text-sm font-medium"
            >
              <Share2 className="w-4 h-4" /> Share with the team
            </button>
          </>
        )}
      </div>

      {!report ? (
        <p className="text-sm text-muted-foreground">No departments are set up yet (Settings → Departments).</p>
      ) : (
        <>
          {hiddenHere > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
              <EyeOff className="w-4 h-4 text-amber-500" />
              <span>{hiddenHere} client{hiddenHere === 1 ? '' : 's'} left out of this report and the share.</span>
              <button onClick={() => setPicking(true)} className="underline underline-offset-2">Change</button>
              <button onClick={() => saveHidden(new Set())} className="underline underline-offset-2">Show all</button>
            </div>
          )}

          <div>
            <p className="text-base font-medium">{headline(report)}</p>
            {nudge(report) && <p className="text-sm text-muted-foreground mt-1">{nudge(report)}</p>}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat n={report.delivered} label="Delivered" tone="text-violet-400" sub={report.lastMonth ? `${report.lastMonth} in ${report.previousMonthLabel.split(' ')[0]}` : undefined} />
            <Stat n={report.planned} label="Planned on the calendar" />
            <Stat n={report.posted} label="Posted" />
            {report.openKnown
              ? <Stat n={report.open} label="Still open today" sub={report.withClient ? `${report.withClient} with clients` : undefined} />
              : <Stat n={report.quietClients.length} label="Clients with nothing" />}
          </div>

          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">By client</div>
            {report.clients.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">Nothing delivered or planned this month yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {report.clients.map(c => (
                  <div key={c.clientId} className="group px-4 py-3">
                    <div className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[1fr_12rem_auto_auto] items-center gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{c.client}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {c.byService.map(s => `${s.count} ${s.service}`).join(' · ') || 'Nothing delivered yet'}
                        </p>
                      </div>
                      <div className="hidden sm:block h-2 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full gradient-bg" style={{ width: `${(c.delivered / max) * 100}%` }} />
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold tabular-nums">{c.delivered}</p>
                        <p className="text-[11px] text-muted-foreground whitespace-nowrap">
                          {[c.planned ? `${c.planned} planned` : '', c.posted ? `${c.posted} posted` : '', report.openKnown && c.open ? `${c.open} open` : '']
                            .filter(Boolean).join(' · ') || ' '}
                        </p>
                      </div>
                      <RemoveButton name={c.client} onClick={() => hide(c.clientId)} />
                    </div>
                    {showDetails && c.items.length > 0 && (
                      <ul className="mt-2 rounded-lg bg-secondary/50 px-3 py-2 space-y-1">
                        {c.items.map((it, n) => (
                          <li key={n} className="text-xs flex gap-2">
                            <span className="w-12 shrink-0 text-muted-foreground tabular-nums">{shortDate(it.date)}</span>
                            <span className="min-w-0">
                              {it.title}
                              {it.count > 1 && <b className="text-violet-400"> ×{it.count}</b>}
                              {it.title !== it.service && <span className="text-muted-foreground"> · {it.service}</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            {report.quiet.length > 0 && (
              <section className="rounded-2xl border border-border bg-card p-4">
                <p className="text-sm font-semibold">Nothing yet this month · {report.quiet.length}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{report.department} clients with no work delivered, planned or open — tap × to leave one out</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {report.quiet.map(q => (
                    <span key={q.clientId} className="inline-flex items-center gap-1 rounded-full bg-secondary pl-3 pr-1 py-0.5 text-sm">
                      {q.client}
                      <button onClick={() => hide(q.clientId)} aria-label={`Leave ${q.client} out`} className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-background/60">
                        <XIcon className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </section>
            )}
            {showTeam && report.people.length > 0 && (
              <section className="rounded-2xl border border-border bg-card p-4">
                <p className="text-sm font-semibold inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> Team</p>
                <p className="text-xs text-muted-foreground mt-0.5">Pieces each person delivered (shared work counts for everyone on it)</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {report.people.map(p => (
                    <span key={p.cqid} className="rounded-full bg-secondary px-3 py-1 text-sm font-medium">
                      {p.cqid} <span className="text-violet-400 ml-1 tabular-nums">{p.delivered}</span>
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>
        </>
      )}

      {picking && full && (
        <ClientPicker clients={allClients} hidden={hidden} onSave={next => { saveHidden(next); setPicking(false) }} onClose={() => setPicking(false)} />
      )}
      {sharing && report && <ShareReport report={report} opts={shareOpts} onClose={() => setSharing(false)} />}
    </div>
  )
}

function Toggle({ on, onChange, icon: Icon, label }: { on: boolean; onChange: (v: boolean) => void; icon: typeof Users; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border text-sm transition-colors ${on ? 'border-violet-500/50 bg-violet-500/15 text-foreground' : 'border-border bg-secondary text-muted-foreground hover:text-foreground'}`}
    >
      <Icon className="w-4 h-4" /> {label}
    </button>
  )
}

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label={`Leave ${name} out of the report`} title="Leave out of the report"
      className="p-1.5 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-secondary sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
      <XIcon className="w-4 h-4" />
    </button>
  )
}

/** Tick the clients to include; the rest are left out of the page and the share. */
function ClientPicker({ clients, hidden, onSave, onClose }: {
  clients: { clientId: string; client: string; delivered: number }[]
  hidden: ReadonlySet<string>
  onSave: (hidden: Set<string>) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(() => new Set(hidden))
  const [q, setQ] = useState('')
  const shown = clients.filter(c => c.client.toLowerCase().includes(q.trim().toLowerCase()))
  const toggle = (id: string) => setDraft(d => { const n = new Set(d); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const included = clients.filter(c => !draft.has(c.clientId)).length
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col min-h-0 max-h-[85dvh]">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="font-semibold">Clients in this report</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{included} of {clients.length} included · unticked ones are left out of the share</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"><XIcon className="w-4 h-4" /></button>
        </div>
        <div className="px-5 pt-3 flex gap-2 shrink-0">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search clients" className="flex-1 h-9 rounded-lg border border-border bg-secondary px-3 text-sm" />
          <button onClick={() => setDraft(new Set())} className="h-9 px-3 rounded-lg border border-border bg-secondary text-sm">All</button>
          <button onClick={() => setDraft(new Set(clients.map(c => c.clientId)))} className="h-9 px-3 rounded-lg border border-border bg-secondary text-sm">None</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
          {shown.map(c => (
            <label key={c.clientId} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-secondary/60 cursor-pointer">
              <input type="checkbox" checked={!draft.has(c.clientId)} onChange={() => toggle(c.clientId)} className="w-4 h-4 accent-violet-500" />
              <span className="flex-1 text-sm truncate">{c.client}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{c.delivered ? `${c.delivered} done` : 'nothing yet'}</span>
            </label>
          ))}
          {!shown.length && <p className="px-2 py-4 text-sm text-muted-foreground">No client matches “{q}”.</p>}
        </div>
        <div className="px-5 py-4 border-t border-border shrink-0 flex justify-end gap-2">
          <button onClick={onClose} className="h-10 px-4 rounded-lg border border-border bg-secondary text-sm">Cancel</button>
          <button onClick={() => onSave(draft)} disabled={!included} className="h-10 px-4 rounded-lg gradient-bg text-white text-sm font-medium disabled:opacity-50">Use these clients</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function Stat({ n, label, sub, tone = '' }: { n: number; label: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className={`text-3xl font-bold tabular-nums ${tone}`}>{n}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      {sub && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{sub}</p>}
    </div>
  )
}

/** Image card or text list, to a WhatsApp group — the same routes as My Work's Share. */
function ShareReport({ report, opts, onClose }: { report: TeamWorkReport; opts: ShareOptions; onClose: () => void }) {
  const text = useMemo(() => teamWorkText(report, opts), [report, opts])
  const fileName = `${report.department.replace(/[^\w-]+/g, '-')}-${report.month}.png`
  const [tab, setTab] = useState<'image' | 'text'>('image')
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  useEffect(() => {
    let alive = true, url = ''
    renderPendingCard(teamWorkCardHtml(report, opts), TEAM_CARD_WIDTH)
      .then(blob => { if (!alive) return; url = URL.createObjectURL(blob); setImage({ blob, url }) })
      .catch(() => { if (alive) setError('Could not create the image. The text version still works.') })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [report, opts])

  const flash = (m: string) => { setDone(m); setTimeout(() => setDone(''), 2200) }
  const canShareFiles = useMemo(() => {
    if (!image || typeof navigator === 'undefined') return false
    if (isNative()) return true
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
    try { return !!nav.canShare?.({ files: [new File([image.blob], fileName, { type: 'image/png' })] }) } catch { return false }
  }, [image, fileName])

  async function shareImage() {
    if (!image) return
    setBusy(true)
    try {
      if (isNative()) {
        const uri = await saveBase64File(fileName, await blobToBase64(image.blob), 'image/png')
        if (uri && await shareContent({ files: [uri], dialogTitle: 'Share the team report' })) flash('Shared')
      } else {
        await navigator.share({ files: [new File([image.blob], fileName, { type: 'image/png' })], title: `${report.department} — ${report.monthLabel}` })
        flash('Shared')
      }
    } catch { /* cancelled */ } finally { setBusy(false) }
  }
  async function copyImage() {
    if (!image) return
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })]); flash('Image copied — paste it into the WhatsApp group') }
    catch { flash('Copying images is not supported here — use Download') }
  }
  function download() {
    if (!image) return
    const a = document.createElement('a'); a.href = image.url; a.download = fileName
    document.body.appendChild(a); a.click(); a.remove(); flash('Downloaded')
  }

  const btn = 'inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-50'
  const wa = `${btn} bg-[#25D366] text-white hover:bg-[#1fb257]`
  const secondary = `${btn} border border-border bg-secondary hover:bg-secondary/70`

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col min-h-0 max-h-[90dvh]">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="font-semibold">Share with the team</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{report.department} · {report.monthLabel} · counts only, no amounts{opts.showDetails ? ' · with details' : ''}{opts.showTeam ? ' · with team' : ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"><XIcon className="w-4 h-4" /></button>
        </div>
        <div className="px-5 pt-3 shrink-0">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary p-1 w-fit">
            {([['image', 'Image', ImageIcon], ['text', 'List', MessageCircle]] as const).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTab(k)} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm ${tab === k ? 'gradient-bg text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {tab === 'image' ? (
            image
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={image.url} alt={`${report.department} report`} className="w-full rounded-xl border border-border" />
              : error ? <p className="text-sm text-red-400">{error}</p>
              : <div className="h-48 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Creating image…</div>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed rounded-xl border border-border bg-secondary/50 p-3 font-sans">{text}</pre>
          )}
        </div>
        <div className="px-5 pb-5 pt-1 shrink-0 space-y-2">
          {done && <p className="text-xs text-green-500 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {done}</p>}
          {tab === 'image' ? (
            <div className="grid grid-cols-2 gap-2">
              {canShareFiles
                ? <button className={`${wa} col-span-2`} disabled={!image || busy} onClick={shareImage}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />} Share image to WhatsApp…</button>
                : <button className={`${btn} gradient-bg text-white col-span-2`} disabled={!image} onClick={copyImage}><Copy className="w-4 h-4" /> Copy image — paste in WhatsApp</button>}
              <button className={secondary} disabled={!image} onClick={download}><Download className="w-4 h-4" /> Download</button>
              <button className={secondary} onClick={() => setTab('text')}><MessageCircle className="w-4 h-4" /> Send as list</button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button className={wa} onClick={() => window.open(whatsappUrl(text), '_blank', 'noopener,noreferrer')}><MessageCircle className="w-4 h-4" /> Open WhatsApp</button>
              <button className={secondary} onClick={async () => { if (await writeClipboard(text)) flash('Text copied') }}><Copy className="w-4 h-4" /> Copy text</button>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">WhatsApp then asks which group or chat to send it to.</p>
        </div>
      </div>
    </ModalOverlay>
  )
}
