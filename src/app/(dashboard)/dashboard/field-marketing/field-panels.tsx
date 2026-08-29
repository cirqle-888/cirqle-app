'use client'

/**
 * Phase-1 field-productivity panels for Field Marketing (§2,3,4,6,7,19):
 *   NearbyPanel      — "Nearby Uncovered": what's near me to visit (radius picker)
 *   FollowupsCenter  — Overdue/Today/Tomorrow/This week/Later buckets
 *   CoveragePanel    — coverage % per Region → Area → Locality
 *   QuickVisitSheet  — one-tap visit logging with smart outcomes
 *
 * All reuse the shared UI kit, geo helpers and the quickVisit/setFollowup server
 * actions. Presented as bottom-sheets (ModalOverlay sheetOnMobile) for one-hand
 * outdoor use. Nothing here reads the DB directly — data arrives as props from
 * field-client; writes go through the existing actions.
 */

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDistanceToNow, isToday, isTomorrow, startOfDay, addDays } from 'date-fns'
import {
  Navigation, X, MapPin, Clock, Zap, ChevronRight, Compass, CheckCircle2,
  Target, Route as RouteIcon, CornerUpRight,
} from 'lucide-react'
import {
  FIELD_OUTCOMES, OUTCOME_BY_VALUE, STATUS_LABEL, STATUS_CHIP, STATUS_COLOR,
  LIKELIHOOD_LABEL, FIELD_LIKELIHOODS, PRIORITY_LABEL, PRIORITY_CHIP,
  type FieldPlace, type FieldStatus, type FieldLikelihood, type FieldTerritory,
} from '@/lib/field/types'
import { distanceMeters, compassPoint, bearingDegrees, formatDistance } from '@/lib/field/geo'
import { quickVisit, type QuickVisitInput } from './actions'

export interface UserLoc { latitude: number; longitude: number; accuracy?: number }
const inputCls = 'w-full h-10 px-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

const isUncovered = (p: FieldPlace) => p.status === 'not_visited'
function rel(d: string | null) { if (!d) return '—'; try { return formatDistanceToNow(new Date(d), { addSuffix: true }) } catch { return '—' } }

// ── Follow-up bucketing ───────────────────────────────────────────────────────
export type FollowBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later'
export function followBucket(iso: string | null, now = new Date()): FollowBucket | null {
  if (!iso) return null
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return null
  const sod = startOfDay(now)
  if (d < sod) return 'overdue'
  if (isToday(d)) return 'today'
  if (isTomorrow(d)) return 'tomorrow'
  if (d < addDays(sod, 7)) return 'week'
  return 'later'
}
export const isFollowupDue = (p: FieldPlace, now = Date.now()) =>
  !!p.next_followup_at && new Date(p.next_followup_at).getTime() <= now && p.status !== 'converted'

// ── Territory hierarchy helpers ───────────────────────────────────────────────
export interface Hierarchy {
  localityName: (id: string | null) => string | null
  chainFor: (territoryId: string | null) => { region?: string; area?: string; locality?: string }
}
export function buildHierarchy(territories: FieldTerritory[]): Hierarchy {
  const byId = new Map(territories.map(t => [t.id, t]))
  const chainFor = (territoryId: string | null) => {
    const out: { region?: string; area?: string; locality?: string } = {}
    let cur = territoryId ? byId.get(territoryId) : undefined
    let guard = 0
    while (cur && guard++ < 6) {
      if (cur.kind === 'locality' || cur.kind === 'route') out.locality = cur.name
      else if (cur.kind === 'area') out.area = cur.name
      else if (cur.kind === 'region') out.region = cur.name
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return out
  }
  return { localityName: (id) => (id ? byId.get(id)?.name ?? null : null), chainFor }
}

// ── Shared compact place row ──────────────────────────────────────────────────
function PlaceRowMini({ place, dist, dir, onOpen, onNavigate, onQuick, faded }: {
  place: FieldPlace; dist: number | null; dir: string | null
  onOpen: () => void; onNavigate: () => void; onQuick: () => void; faded?: boolean
}) {
  return (
    <div className={`rounded-xl border p-3 ${faded ? 'border-border/60 opacity-60' : 'border-border'} bg-card`}>
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="min-w-0 text-left flex-1">
          <div className="font-medium text-foreground truncate flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_COLOR[place.status] }} />
            {place.name}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CHIP[place.status]}`}>{STATUS_LABEL[place.status]}</span>
            {place.priority && <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${PRIORITY_CHIP[place.priority]}`}>{PRIORITY_LABEL[place.priority]}</span>}
            {place.area && <span className="text-[10px] text-muted-foreground truncate">{place.area}</span>}
          </div>
        </button>
        <div className="text-right shrink-0">
          {dist != null && <div className="text-sm font-semibold text-foreground">{formatDistance(dist)}</div>}
          {dir && <div className="text-[10px] text-muted-foreground">{dir}</div>}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5">
        <Button size="sm" variant="secondary" className="flex-1 h-9" onClick={onNavigate}><Navigation className="w-3.5 h-3.5 mr-1" />Go</Button>
        <Button size="sm" className="flex-1 h-9" onClick={onQuick}><Zap className="w-3.5 h-3.5 mr-1" />Quick Visit</Button>
      </div>
    </div>
  )
}

// ── Nearby Uncovered (§2) ─────────────────────────────────────────────────────
const RADII = [500, 1000, 2000, 5000]
export function NearbyPanel({ places, userLoc, onClose, onOpen, onNavigate, onQuick }: {
  places: FieldPlace[]; userLoc: UserLoc | null; onClose: () => void
  onOpen: (p: FieldPlace) => void; onNavigate: (p: FieldPlace) => void; onQuick: (p: FieldPlace) => void
}) {
  const [radius, setRadius] = useState(1000)
  const [showCovered, setShowCovered] = useState(false)

  const rows = useMemo(() => {
    if (!userLoc) return []
    return places
      .map(p => ({ p, d: distanceMeters(userLoc, p) }))
      .filter(x => x.d <= radius)
      .filter(x => showCovered || isUncovered(x.p) || isFollowupDue(x.p))
      .sort((a, b) => {
        // §2 priority: not-visited → follow-up due → hot → warm → distance
        const rank = (p: FieldPlace) => isUncovered(p) ? 0 : isFollowupDue(p) ? 1 : p.likelihood === 'hot' ? 2 : p.likelihood === 'warm' ? 3 : 5
        return (rank(a.p) - rank(b.p)) || (a.d - b.d)
      })
  }, [places, userLoc, radius, showCovered])

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[440px] max-h-[88dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><Compass className="w-5 h-5 text-primary" />Nearby Uncovered</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        {!userLoc ? (
          <div className="p-4"><EmptyState icon={MapPin} title="Location needed" body="Enable location for this site so Cirqle can show the unvisited shops around you." /></div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <div className="flex gap-1">
                {RADII.map(r => (
                  <button key={r} onClick={() => setRadius(r)}
                    className={`px-2.5 h-8 rounded-lg text-xs font-medium border ${radius === r ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border text-muted-foreground'}`}>
                    {r < 1000 ? `${r} m` : `${r / 1000} km`}
                  </button>
                ))}
              </div>
              <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={showCovered} onChange={e => setShowCovered(e.target.checked)} />Covered
              </label>
            </div>
            <div className="overflow-y-auto p-3 space-y-2">
              {rows.length === 0
                ? <div className="text-sm text-muted-foreground text-center py-8">No {showCovered ? '' : 'uncovered '}places within {radius < 1000 ? `${radius} m` : `${radius / 1000} km`}.</div>
                : rows.map(({ p, d }) => (
                  <PlaceRowMini key={p.id} place={p} dist={d} dir={userLoc ? compassPoint(bearingDegrees(userLoc, p)) : null}
                    faded={!isUncovered(p) && !isFollowupDue(p)}
                    onOpen={() => onOpen(p)} onNavigate={() => onNavigate(p)} onQuick={() => onQuick(p)} />
                ))}
            </div>
          </>
        )}
      </div>
    </ModalOverlay>
  )
}

// ── Follow-up Center (§7) ─────────────────────────────────────────────────────
const BUCKET_META: Record<FollowBucket, { label: string; cls: string }> = {
  overdue: { label: 'Overdue', cls: 'text-red-400' },
  today: { label: 'Today', cls: 'text-amber-400' },
  tomorrow: { label: 'Tomorrow', cls: 'text-blue-400' },
  week: { label: 'This week', cls: 'text-foreground' },
  later: { label: 'Later', cls: 'text-muted-foreground' },
}
export function FollowupsCenter({ places, userLoc, onClose, onOpen, onNavigate, onQuick, onReschedule }: {
  places: FieldPlace[]; userLoc: UserLoc | null; onClose: () => void
  onOpen: (p: FieldPlace) => void; onNavigate: (p: FieldPlace) => void; onQuick: (p: FieldPlace) => void
  onReschedule: (p: FieldPlace, iso: string) => void
}) {
  const groups = useMemo(() => {
    const now = new Date()
    const g: Record<FollowBucket, FieldPlace[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [] }
    for (const p of places) {
      const b = followBucket(p.next_followup_at, now)
      if (b && p.status !== 'converted') g[b].push(p)
    }
    const hotFirst = (a: FieldPlace, b: FieldPlace) => {
      const r = (p: FieldPlace) => p.likelihood === 'hot' ? 0 : p.likelihood === 'warm' ? 1 : 2
      return (r(a) - r(b)) || (new Date(a.next_followup_at!).getTime() - new Date(b.next_followup_at!).getTime())
    }
    for (const k of Object.keys(g) as FollowBucket[]) g[k].sort(hotFirst)
    return g
  }, [places])

  const total = (Object.values(groups) as FieldPlace[][]).reduce((n, a) => n + a.length, 0)

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[460px] max-h-[88dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><Clock className="w-5 h-5 text-primary" />Follow-ups</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-3 space-y-4">
          {total === 0 && <div className="py-8"><EmptyState icon={CheckCircle2} title="All caught up" body="No follow-ups scheduled. Log a visit and set a follow-up date to see it here." /></div>}
          {(['overdue', 'today', 'tomorrow', 'week', 'later'] as FollowBucket[]).map(bucket => groups[bucket].length > 0 && (
            <div key={bucket}>
              <div className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${BUCKET_META[bucket].cls}`}>{BUCKET_META[bucket].label} · {groups[bucket].length}</div>
              <div className="space-y-2">
                {groups[bucket].map(p => (
                  <div key={p.id} className="rounded-xl border border-border bg-card p-3">
                    <button onClick={() => onOpen(p)} className="w-full text-left">
                      <div className="font-medium text-foreground truncate flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_COLOR[p.status] }} />{p.name}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap text-[10px] text-muted-foreground">
                        {p.area && <span>{p.area}</span>}
                        <span className={`px-1.5 py-0.5 rounded ${STATUS_CHIP[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                        {p.likelihood && <span>{LIKELIHOOD_LABEL[p.likelihood]}</span>}
                        <span>· due {rel(p.next_followup_at)}</span>
                        {userLoc && <span>· {formatDistance(distanceMeters(userLoc, p))}</span>}
                      </div>
                    </button>
                    <div className="flex items-center gap-1.5 mt-2.5">
                      <Button size="sm" variant="secondary" className="h-8 px-2" onClick={() => onNavigate(p)}><Navigation className="w-3.5 h-3.5" /></Button>
                      <Button size="sm" className="flex-1 h-8" onClick={() => onQuick(p)}><Zap className="w-3.5 h-3.5 mr-1" />Quick Visit</Button>
                      <AppSelect wrapperClassName="w-[116px]" className="h-8" value=""
                        onChange={e => { const v = e.target.value; if (v) onReschedule(p, v) }}>
                        <option value="">Reschedule…</option>
                        <option value={addDays(startOfDay(new Date()), 1).toISOString()}>Tomorrow</option>
                        <option value={addDays(startOfDay(new Date()), 3).toISOString()}>In 3 days</option>
                        <option value={addDays(startOfDay(new Date()), 7).toISOString()}>Next week</option>
                      </AppSelect>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Coverage (§6) ─────────────────────────────────────────────────────────────
interface CovAgg { total: number; covered: number; interested: number; converted: number }
function emptyAgg(): CovAgg { return { total: 0, covered: 0, interested: 0, converted: 0 } }
function addTo(a: CovAgg, p: FieldPlace) {
  a.total++
  if (p.status !== 'not_visited') a.covered++
  if (p.status === 'interested' || p.status === 'negotiating') a.interested++
  if (p.status === 'converted') a.converted++
}
export function CoveragePanel({ places, territories, onClose, onPickLocality }: {
  places: FieldPlace[]; territories: FieldTerritory[]; onClose: () => void
  onPickLocality: (territoryId: string) => void
}) {
  const H = useMemo(() => buildHierarchy(territories), [territories])
  const tree = useMemo(() => {
    // area name → { agg, localities: Map<localityId, {name, agg}> }
    const areas = new Map<string, { agg: CovAgg; localities: Map<string, { name: string; id: string; agg: CovAgg }> }>()
    const unassigned = emptyAgg()
    for (const p of places) {
      const chain = H.chainFor(p.territory_id)
      if (!chain.area || !p.territory_id) { addTo(unassigned, p); continue }
      const areaKey = `${chain.region ?? ''} › ${chain.area}`
      if (!areas.has(areaKey)) areas.set(areaKey, { agg: emptyAgg(), localities: new Map() })
      const A = areas.get(areaKey)!
      addTo(A.agg, p)
      const locName = chain.locality ?? '—'
      if (!A.localities.has(p.territory_id)) A.localities.set(p.territory_id, { name: locName, id: p.territory_id, agg: emptyAgg() })
      addTo(A.localities.get(p.territory_id)!.agg, p)
    }
    return { areas: [...areas.entries()].sort(), unassigned }
  }, [places, H])

  const pct = (a: CovAgg) => a.total ? Math.round((a.covered / a.total) * 100) : 0
  const Bar = ({ v }: { v: number }) => (
    <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-green-500" style={{ width: `${v}%` }} /></div>
  )

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[460px] max-h-[88dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><MapPin className="w-5 h-5 text-primary" />Area Coverage</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-4">
          {tree.areas.map(([areaKey, A]) => (
            <div key={areaKey}>
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-semibold text-foreground">{areaKey.replace(/^ › /, '')}</div>
                <div className="text-xs text-muted-foreground">{A.agg.covered}/{A.agg.total} · <span className="text-foreground font-medium">{pct(A.agg)}%</span></div>
              </div>
              <Bar v={pct(A.agg)} />
              <div className="mt-2 space-y-1.5 pl-2">
                {[...A.localities.values()].sort((x, y) => pct(x.agg) - pct(y.agg)).map(L => (
                  <button key={L.id} onClick={() => onPickLocality(L.id)} className="w-full flex items-center gap-2 text-left group">
                    <div className="w-24 shrink-0 text-xs text-muted-foreground group-hover:text-foreground truncate">{L.name}</div>
                    <div className="flex-1"><Bar v={pct(L.agg)} /></div>
                    <div className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">{L.agg.total - L.agg.covered} left</div>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          ))}
          {tree.unassigned.total > 0 && (
            <div className="text-xs text-muted-foreground">{tree.unassigned.total} place(s) not yet in a locality.</div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Quick Visit (§3, §4) ──────────────────────────────────────────────────────
function toneCls(tone: string, active: boolean) {
  if (active) return tone === 'positive' ? 'bg-green-500 text-white border-green-500'
    : tone === 'negative' ? 'bg-red-500 text-white border-red-500' : 'bg-primary text-primary-foreground border-primary'
  return 'bg-secondary border-border text-foreground'
}
export function QuickVisitSheet({ place, userLoc, onClose, onSaved }: {
  place: FieldPlace; userLoc: UserLoc | null; onClose: () => void
  onSaved: (placeId: string, data: NonNullable<Awaited<ReturnType<typeof quickVisit>>['data']>) => void
}) {
  const [outcome, setOutcome] = useState<string | null>(null)
  const [likelihood, setLikelihood] = useState<FieldLikelihood | null>(place.likelihood)
  const [likelihoodTouched, setLikelihoodTouched] = useState(false)
  const [follow, setFollow] = useState<'none' | 'today' | 'tomorrow' | 'custom'>('none')
  const [followTouched, setFollowTouched] = useState(false)
  const [customDate, setCustomDate] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<FieldStatus>(place.status === 'not_visited' ? 'visited' : place.status)

  function pickOutcome(v: string) {
    setOutcome(v)
    const o = OUTCOME_BY_VALUE[v]
    if (!o) return
    setStatus(o.status)                                   // outcome always drives status suggestion
    if (o.likelihood && !likelihoodTouched) setLikelihood(o.likelihood)  // never overwrite an explicit choice (§4)
    if (!followTouched) setFollow(o.followup ? 'tomorrow' : 'none')
  }

  function followIso(): string | null {
    const base = startOfDay(new Date())
    if (follow === 'today') return new Date(base.getTime() + 17 * 3600_000).toISOString()      // today 5pm
    if (follow === 'tomorrow') return new Date(addDays(base, 1).getTime() + 10 * 3600_000).toISOString() // tmrw 10am
    if (follow === 'custom' && customDate) return new Date(customDate).toISOString()
    return null
  }

  async function save() {
    setSaving(true)
    const input: QuickVisitInput = {
      outcome: outcome ? (OUTCOME_BY_VALUE[outcome]?.label ?? outcome) : 'Visited',
      status, likelihood, notes,
      latitude: userLoc?.latitude ?? null, longitude: userLoc?.longitude ?? null,
      nextFollowupAt: follow === 'none' ? null : followIso(),
      contactPhone: phone || null,
    }
    const res = await quickVisit(place.id, input)
    if (!res.ok || !res.data) { setSaving(false); return }
    onSaved(place.id, res.data)
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[70]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[460px] max-h-[92dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">{place.name}</h2>
            <div className="text-[11px] text-muted-foreground">{userLoc ? 'GPS will be recorded' : 'No GPS — location won’t be recorded'}</div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-4">
          <div>
            <label className={labelCls}>Outcome</label>
            <div className="grid grid-cols-2 gap-2">
              {FIELD_OUTCOMES.map(o => (
                <button key={o.value} onClick={() => pickOutcome(o.value)}
                  className={`h-11 px-2 rounded-xl border text-[13px] font-medium transition-colors ${toneCls(o.tone, outcome === o.value)}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={labelCls}>Likelihood</label>
            <div className="flex gap-2">
              {FIELD_LIKELIHOODS.map(l => (
                <button key={l} onClick={() => { setLikelihood(likelihood === l ? null : l); setLikelihoodTouched(true) }}
                  className={`flex-1 h-10 rounded-xl border text-sm font-medium ${likelihood === l ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border text-foreground'}`}>
                  {LIKELIHOOD_LABEL[l]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={labelCls}>Follow-up</label>
            <div className="flex gap-2">
              {(['none', 'today', 'tomorrow', 'custom'] as const).map(f => (
                <button key={f} onClick={() => { setFollow(f); setFollowTouched(true) }}
                  className={`flex-1 h-10 rounded-xl border text-sm font-medium capitalize ${follow === f ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border text-foreground'}`}>
                  {f === 'none' ? 'None' : f}
                </button>
              ))}
            </div>
            {follow === 'custom' && <input type="datetime-local" className={`${inputCls} mt-2`} value={customDate} onChange={e => setCustomDate(e.target.value)} />}
          </div>
          <div className="grid grid-cols-1 gap-2">
            <input className={inputCls} placeholder="Add phone (optional)" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} />
            <textarea className="w-full px-3 py-2 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-none" rows={2} placeholder="Notes (optional)" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>
        <div className="p-3 border-t border-border">
          <Button className="w-full h-12 text-base" loading={saving} onClick={save}>
            {saving ? 'Saving…' : <><CheckCircle2 className="w-5 h-5 mr-1.5" />Save Visit</>}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Quick Visit launcher — pick a shop when opened from the bottom bar ─────────
export function QuickVisitPicker({ places, userLoc, onClose, onPick }: {
  places: FieldPlace[]; userLoc: UserLoc | null; onClose: () => void; onPick: (p: FieldPlace) => void
}) {
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let arr = places
    if (needle) arr = arr.filter(p => `${p.name} ${p.area ?? ''}`.toLowerCase().includes(needle))
    else if (userLoc) arr = [...arr].sort((a, b) => distanceMeters(userLoc, a) - distanceMeters(userLoc, b))
    return arr.slice(0, 40)
  }, [places, q, userLoc])

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[440px] max-h-[88dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><Zap className="w-5 h-5 text-primary" />Quick Visit — pick a shop</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-3 border-b border-border">
          <input autoFocus className={inputCls} placeholder={userLoc ? 'Search, or pick the nearest below…' : 'Search shop…'} value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="overflow-y-auto p-2">
          {rows.map(p => (
            <button key={p.id} onClick={() => onPick(p)} className="w-full flex items-center justify-between gap-2 p-3 rounded-lg hover:bg-secondary text-left">
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_COLOR[p.status] }} />{p.name}</div>
                <div className="text-[11px] text-muted-foreground truncate">{STATUS_LABEL[p.status]}{p.area ? ` · ${p.area}` : ''}</div>
              </div>
              {userLoc && <div className="text-sm font-medium text-foreground shrink-0">{formatDistance(distanceMeters(userLoc, p))}</div>}
            </button>
          ))}
          {rows.length === 0 && <div className="text-sm text-muted-foreground text-center py-8">No shops found.</div>}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Mobile bottom action bar (§19) ────────────────────────────────────────────
export interface FieldActions {
  onNearby: () => void; onNextBest: () => void; onPlan: () => void; onOnTheWay: () => void; onQuick: () => void
}
function BottomBarItem({ icon: Icon, label, onClick }: { icon: typeof Zap; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] text-muted-foreground hover:text-foreground active:scale-95 transition-transform">
      <Icon className="w-5 h-5" />{label}
    </button>
  )
}
// Mobile bottom bar — the five primary field actions (§19).
export function FieldBottomBar({ onNearby, onNextBest, onPlan, onOnTheWay, onQuick }: FieldActions) {
  return (
    <div className="fixed bottom-[var(--bottom-nav-h,0px)] inset-x-0 z-40 lg:hidden bg-card/95 backdrop-blur border-t border-border pb-[var(--bottom-safe-pb,env(safe-area-inset-bottom))]">
      <div className="flex items-stretch max-w-lg mx-auto">
        <BottomBarItem icon={Compass} label="Nearby" onClick={onNearby} />
        <BottomBarItem icon={Target} label="Next Best" onClick={onNextBest} />
        <BottomBarItem icon={RouteIcon} label="Plan" onClick={onPlan} />
        <BottomBarItem icon={CornerUpRight} label="On The Way" onClick={onOnTheWay} />
        <BottomBarItem icon={Zap} label="Quick Visit" onClick={onQuick} />
      </div>
    </div>
  )
}

// Desktop toolbar — the five primary actions (shown ≥ lg where the bottom bar hides).
export function FieldToolbar({ onNearby, onNextBest, onPlan, onOnTheWay, onQuick }: FieldActions) {
  return (
    <div className="hidden lg:flex items-center gap-1.5">
      <Button size="sm" variant="secondary" onClick={onNearby}><Compass className="w-4 h-4 mr-1.5" />Nearby</Button>
      <Button size="sm" variant="secondary" onClick={onNextBest}><Target className="w-4 h-4 mr-1.5" />Next Best</Button>
      <Button size="sm" variant="secondary" onClick={onPlan}><RouteIcon className="w-4 h-4 mr-1.5" />Plan</Button>
      <Button size="sm" variant="secondary" onClick={onOnTheWay}><CornerUpRight className="w-4 h-4 mr-1.5" />On The Way</Button>
      <Button size="sm" onClick={onQuick}><Zap className="w-4 h-4 mr-1.5" />Quick Visit</Button>
    </div>
  )
}
