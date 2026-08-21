'use client'

/**
 * Routing-intelligence UI for Field Marketing (§5, §8-13):
 *   NextBestCard  — the single best place to visit next (priority × proximity)
 *   PlanDaySheet  — build an efficient ordered day route
 *   OnTheWaySheet — return-route opportunities with smart detour (§9-12)
 *   RouteSession  — step-through a route stop by stop (§13)
 *
 * Road distance/time come from the swappable routing provider (routing-provider.ts,
 * OSRM default + straight-line fallback). Corridor/detour shortlisting is pure geo
 * (no API) so only the final preview hits the router — keeping request volume low.
 * Never lists already-covered places as new opportunities.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Navigation, X, Zap, Target, Route as RouteIcon, Home, Building2, Search, Loader2,
  SkipForward, Flag, Star, Trash2, CornerUpRight,
} from 'lucide-react'
import {
  STATUS_LABEL, STATUS_CHIP, STATUS_COLOR, PRIORITY_LABEL, PRIORITY_CHIP, PRIORITY_WEIGHT,
  LIKELIHOOD_LABEL, type FieldPlace, type FieldTerritory,
} from '@/lib/field/types'
import { distanceMeters, distanceToPathMeters, formatDistance, formatDuration, compassPoint, bearingDegrees, type LatLng } from '@/lib/field/geo'
import { getRoutingProvider, estimateStraightRoute, type RouteResult } from '@/lib/field/routing-provider'
import { getMapProvider } from '@/lib/field/map-provider'
import { useSavedDestinations, type DestinationKind } from '@/lib/field/destinations'
import { isFollowupDue, type UserLoc } from './field-panels'

const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'
const inputCls = 'w-full h-10 px-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'

// ── Actionability + scoring (§5) ──────────────────────────────────────────────
export function isActionable(p: FieldPlace, now = Date.now()): boolean {
  if (p.status === 'converted' || p.status === 'not_interested') return false
  return p.status === 'not_visited' || p.status === 'revisit' || isFollowupDue(p, now)
}
// Higher = visit sooner. Balances sales priority against geographic distance so a
// slightly farther high-value shop can outrank a nearer low-value one (§5).
export function nextBestScore(p: FieldPlace, userLoc: LatLng | null, now = Date.now()): number {
  let s = 0
  s += (PRIORITY_WEIGHT[p.priority ?? ''] ?? 0) * 30          // A=90 B=60 C=30
  s += p.likelihood === 'hot' ? 45 : p.likelihood === 'warm' ? 22 : 0
  if (p.status === 'not_visited') s += 30
  if (p.status === 'revisit') s += 18
  if (isFollowupDue(p, now)) s += 55
  if (userLoc) s -= (distanceMeters(userLoc, p) / 1000) * 7   // efficiency penalty per km
  return s
}
function orderNearestNeighbour(start: LatLng, places: FieldPlace[]): FieldPlace[] {
  const remaining = [...places]; const out: FieldPlace[] = []; let cur: LatLng = start
  while (remaining.length) {
    let bi = 0, bd = Infinity
    for (let i = 0; i < remaining.length; i++) { const d = distanceMeters(cur, remaining[i]); if (d < bd) { bd = d; bi = i } }
    const nx = remaining.splice(bi, 1)[0]; out.push(nx); cur = nx
  }
  return out
}

// ── Compact stop card ─────────────────────────────────────────────────────────
function StopCard({ place, sub, onOpen, onNavigate, onQuick, right }: {
  place: FieldPlace; sub?: string; onOpen?: () => void; onNavigate?: () => void; onQuick?: () => void; right?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="min-w-0 text-left flex-1">
          <div className="font-medium text-foreground truncate flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_COLOR[place.status] }} />{place.name}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CHIP[place.status]}`}>{STATUS_LABEL[place.status]}</span>
            {place.priority && <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${PRIORITY_CHIP[place.priority]}`}>{PRIORITY_LABEL[place.priority]}</span>}
            {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
          </div>
        </button>
        {right}
      </div>
      {(onNavigate || onQuick) && (
        <div className="flex items-center gap-2 mt-2.5">
          {onNavigate && <Button size="sm" variant="secondary" className="flex-1 h-9" onClick={onNavigate}><Navigation className="w-3.5 h-3.5 mr-1" />Go</Button>}
          {onQuick && <Button size="sm" className="flex-1 h-9" onClick={onQuick}><Zap className="w-3.5 h-3.5 mr-1" />Quick Visit</Button>}
        </div>
      )}
    </div>
  )
}

// ── Next Best Visit (§5) ──────────────────────────────────────────────────────
export function NextBestCard({ places, userLoc, onClose, onOpen, onNavigate, onQuick }: {
  places: FieldPlace[]; userLoc: UserLoc | null; onClose: () => void
  onOpen: (p: FieldPlace) => void; onNavigate: (p: FieldPlace) => void; onQuick: (p: FieldPlace) => void
}) {
  const [now] = useState(() => Date.now())
  const ranked = useMemo(() => {
    return places.filter(p => isActionable(p, now))
      .map(p => ({ p, score: nextBestScore(p, userLoc, now), d: userLoc ? distanceMeters(userLoc, p) : null }))
      .sort((a, b) => b.score - a.score)
  }, [places, userLoc, now])
  const best = ranked[0]

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[440px] max-h-[88dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><Target className="w-5 h-5 text-primary" />Next Best Visit</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3">
          {!best ? <div className="py-8"><EmptyState icon={Flag} title="Nothing pending" body="No unvisited, revisit or follow-up-due places right now. Add places or check back later." /></div> : (
            <>
              <div className="rounded-2xl border border-primary/40 bg-primary/5 p-4">
                <div className="text-[11px] uppercase tracking-wide text-primary font-semibold mb-1">🎯 Recommended</div>
                <div className="text-lg font-semibold text-foreground">{best.p.name}</div>
                <div className="flex items-center gap-2 mt-1 flex-wrap text-xs text-muted-foreground">
                  {best.d != null && <span className="text-foreground font-medium">{formatDistance(best.d)}{userLoc ? ` · ${compassPoint(bearingDegrees(userLoc, best.p))}` : ''}</span>}
                  <span className={`px-1.5 py-0.5 rounded ${STATUS_CHIP[best.p.status]}`}>{STATUS_LABEL[best.p.status]}</span>
                  {best.p.priority && <span className={`px-1.5 py-0.5 rounded ${PRIORITY_CHIP[best.p.priority]}`}>{PRIORITY_LABEL[best.p.priority]}</span>}
                  {best.p.likelihood && <span>{LIKELIHOOD_LABEL[best.p.likelihood]}</span>}
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <Button size="sm" variant="secondary" className="flex-1 h-10" onClick={() => onNavigate(best.p)}><Navigation className="w-4 h-4 mr-1.5" />Navigate</Button>
                  <Button size="sm" className="flex-1 h-10" onClick={() => onQuick(best.p)}><Zap className="w-4 h-4 mr-1.5" />Quick Visit</Button>
                </div>
              </div>
              {ranked.length > 1 && <div className="text-xs text-muted-foreground pt-1">Then consider</div>}
              {ranked.slice(1, 6).map(({ p, d }) => (
                <StopCard key={p.id} place={p} sub={d != null ? formatDistance(d) : undefined} onOpen={() => onOpen(p)} onNavigate={() => onNavigate(p)} onQuick={() => onQuick(p)} />
              ))}
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Plan My Day (§8) ──────────────────────────────────────────────────────────
export function PlanDaySheet({ places, userLoc, localities, onClose, onStartRoute }: {
  places: FieldPlace[]; userLoc: UserLoc | null; localities: FieldTerritory[]
  onClose: () => void; onStartRoute: (orderedIds: string[]) => void
}) {
  const [localityId, setLocalityId] = useState('')
  const [maxVisits, setMaxVisits] = useState(10)
  const [route, setRoute] = useState<FieldPlace[]>([])
  const [metrics, setMetrics] = useState<RouteResult | null>(null)
  const [computing, setComputing] = useState(false)
  const [now] = useState(() => Date.now())

  const start: LatLng | null = userLoc

  function generate() {
    let pool = places.filter(p => isActionable(p, now))
    if (localityId) pool = pool.filter(p => p.territory_id === localityId)
    pool = pool.sort((a, b) => nextBestScore(b, start, now) - nextBestScore(a, start, now)).slice(0, maxVisits)
    const ordered = start ? orderNearestNeighbour(start, pool) : pool
    setRoute(ordered)
    setMetrics(null)
    if (ordered.length && start) computeMetrics(ordered)
  }
  async function computeMetrics(stops: FieldPlace[]) {
    if (!start) return
    setComputing(true)
    const res = await getRoutingProvider().route([start, ...stops]).catch(() => estimateStraightRoute([start, ...stops]))
    setMetrics(res); setComputing(false)
  }
  function removeStop(id: string) {
    const next = route.filter(p => p.id !== id); setRoute(next); if (next.length && start) computeMetrics(next); else setMetrics(null)
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[460px] max-h-[90dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><RouteIcon className="w-5 h-5 text-primary" />Plan My Day</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3">
          {!userLoc && <div className="text-xs rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-500 px-3 py-2">No GPS — the route can’t start from your location or estimate travel. Enable location for best results.</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Working area</label>
              <AppSelect value={localityId} onChange={e => setLocalityId(e.target.value)}>
                <option value="">All areas</option>
                {localities.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className={labelCls}>Max visits</label>
              <AppSelect value={String(maxVisits)} onChange={e => setMaxVisits(Number(e.target.value))}>
                {[5, 8, 10, 15, 20].map(n => <option key={n} value={n}>{n}</option>)}
              </AppSelect>
            </div>
          </div>
          <Button className="w-full" onClick={generate}><RouteIcon className="w-4 h-4 mr-1.5" />Generate route</Button>

          {route.length > 0 && (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
                <span>{route.length} stops{metrics ? ` · ${formatDistance(metrics.distanceM)} · ${formatDuration(metrics.durationS)}` : ''}</span>
                {computing && <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />routing…</span>}
                {metrics?.approximate && <span>≈ straight-line</span>}
              </div>
              <div className="space-y-2">
                {route.map((p, i) => (
                  <StopCard key={p.id} place={p}
                    sub={userLoc ? formatDistance(distanceMeters(userLoc, p)) : undefined}
                    right={<div className="flex items-center gap-1"><span className="w-5 h-5 rounded-full bg-secondary text-[11px] grid place-items-center text-muted-foreground">{i + 1}</span><button onClick={() => removeStop(p.id)} className="text-muted-foreground hover:text-red-400 p-1"><Trash2 className="w-3.5 h-3.5" /></button></div>} />
                ))}
              </div>
            </>
          )}
        </div>
        {route.length > 0 && (
          <div className="p-3 border-t border-border">
            <Button className="w-full h-11" onClick={() => onStartRoute(route.map(p => p.id))}><Flag className="w-4 h-4 mr-1.5" />Start Route</Button>
          </div>
        )}
      </div>
    </ModalOverlay>
  )
}

// ── On The Way / Return Route (§9-12) ─────────────────────────────────────────
const CORRIDORS = [500, 1000, 2000]
export function OnTheWaySheet({ places, userLoc, onClose, onStartRoute, toast }: {
  places: FieldPlace[]; userLoc: UserLoc | null; onClose: () => void
  onStartRoute: (orderedIds: string[], destination: { label: string; latitude: number; longitude: number }) => void
  toast: { error: (t: string, b?: string) => void; success: (t: string, b?: string) => void }
}) {
  const dest = useSavedDestinations()
  const [destination, setDestination] = useState<{ label: string; latitude: number; longitude: number } | null>(null)
  const [maxDetour, setMaxDetour] = useState(1000)  // corridor width AND detour budget (m)
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<{ label: string; latitude: number; longitude: number }[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{ base: RouteResult; full: RouteResult } | null>(null)
  const [computing, setComputing] = useState(false)
  const [now] = useState(() => Date.now())

  // Candidates: actionable places inside the corridor around the straight line
  // current → destination, ranked by detour (cheap straight-line estimate).
  const candidates = useMemo(() => {
    if (!userLoc || !destination) return []
    const path = [userLoc, destination]
    const baseD = distanceMeters(userLoc, destination)
    return places.filter(p => isActionable(p, now))
      .map(p => {
        const off = distanceToPathMeters(p, path)
        const detour = (distanceMeters(userLoc, p) + distanceMeters(p, destination)) - baseD
        return { p, off, detour }
      })
      .filter(x => x.off <= maxDetour && x.detour <= maxDetour * 2)
      .sort((a, b) => (nextBestScore(b.p, userLoc, now) - a.detour / 100) - (nextBestScore(a.p, userLoc, now) - b.detour / 100))
      .slice(0, 15)
  }, [places, userLoc, destination, maxDetour, now])

  // Default-select the top candidates whenever the candidate set changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setChosen(new Set(candidates.slice(0, 5).map(c => c.p.id))); setPreview(null) }, [candidates])

  const chosenPlaces = useMemo(() => candidates.filter(c => chosen.has(c.p.id)).map(c => c.p), [candidates, chosen])

  async function runPreview() {
    if (!userLoc || !destination) return
    setComputing(true)
    const ordered = orderNearestNeighbour(userLoc, chosenPlaces)
    const rp = getRoutingProvider()
    const [base, full] = await Promise.all([
      rp.route([userLoc, destination]).catch(() => estimateStraightRoute([userLoc, destination])),
      rp.route([userLoc, ...ordered, destination]).catch(() => estimateStraightRoute([userLoc, ...ordered, destination])),
    ])
    setPreview({ base, full }); setComputing(false)
  }

  async function doSearch() {
    if (search.trim().length < 3) return
    setSearching(true)
    const rows = await getMapProvider().geocode(search, { near: userLoc ?? undefined }).catch(() => [])
    setResults(rows.map(r => ({ label: r.label, latitude: r.latitude, longitude: r.longitude })))
    setSearching(false)
  }

  const orderedChosen = userLoc ? orderNearestNeighbour(userLoc, chosenPlaces) : chosenPlaces

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[470px] max-h-[92dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><CornerUpRight className="w-5 h-5 text-primary" />On The Way</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-4">
          {!userLoc && <div className="text-xs rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-500 px-3 py-2">Enable location — “On The Way” needs your current position to find shops along your route.</div>}

          {/* Destination picker (§11) */}
          <div>
            <label className={labelCls}>Destination</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {dest.list.map(d => (
                <button key={d.id} onClick={() => setDestination(d)}
                  className={`inline-flex items-center gap-1.5 px-2.5 h-9 rounded-lg border text-sm ${destination?.label === d.label ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border'}`}>
                  {d.kind === 'home' ? <Home className="w-3.5 h-3.5" /> : d.kind === 'office' ? <Building2 className="w-3.5 h-3.5" /> : <Star className="w-3.5 h-3.5" />}{d.label}
                  <Trash2 className="w-3 h-3 opacity-60 hover:opacity-100" onClick={(e) => { e.stopPropagation(); dest.remove(d.id) }} />
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input className={inputCls} placeholder="Search a destination…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') doSearch() }} />
              <Button variant="secondary" onClick={doSearch} loading={searching} className="h-10"><Search className="w-4 h-4" /></Button>
            </div>
            {results.length > 0 && (
              <div className="mt-2 space-y-1">
                {results.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
                    <button onClick={() => { setDestination(r); setResults([]) }} className="min-w-0 text-left text-xs text-foreground truncate flex-1">{r.label}</button>
                    <div className="flex gap-1 shrink-0">
                      {(['home', 'office', 'custom'] as DestinationKind[]).map(k => (
                        <button key={k} title={`Save as ${k}`} onClick={() => { dest.add({ label: k === 'custom' ? r.label.split(',')[0] : k[0].toUpperCase() + k.slice(1), kind: k, latitude: r.latitude, longitude: r.longitude }); toast.success('Destination saved') }}
                          className="px-1.5 h-7 rounded border border-border text-[10px] text-muted-foreground hover:text-foreground capitalize">{k === 'custom' ? '+save' : k}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {destination && <div className="mt-2 text-xs text-muted-foreground">→ {destination.label}</div>}
          </div>

          {/* Detour budget (§10) */}
          {destination && (
            <div>
              <label className={labelCls}>Max detour off route</label>
              <div className="flex gap-2">
                {CORRIDORS.map(c => (
                  <button key={c} onClick={() => setMaxDetour(c)} className={`flex-1 h-9 rounded-lg border text-sm font-medium ${maxDetour === c ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border'}`}>{c < 1000 ? `${c} m` : `${c / 1000} km`}</button>
                ))}
              </div>
            </div>
          )}

          {/* Candidates */}
          {destination && (
            candidates.length === 0
              ? <div className="text-sm text-muted-foreground text-center py-4">No unvisited shops within {maxDetour < 1000 ? `${maxDetour} m` : `${maxDetour / 1000} km`} of this route.</div>
              : (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">{candidates.length} on the way · {chosen.size} selected</div>
                  {candidates.map(({ p, detour }) => (
                    <label key={p.id} className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3 cursor-pointer">
                      <input type="checkbox" checked={chosen.has(p.id)} onChange={e => setChosen(prev => { const n = new Set(prev); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n })} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-foreground truncate flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_COLOR[p.status] }} />{p.name}</div>
                        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
                          <span className={`px-1.5 py-0.5 rounded ${STATUS_CHIP[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                          {p.priority && <span className={`px-1.5 py-0.5 rounded ${PRIORITY_CHIP[p.priority]}`}>{PRIORITY_LABEL[p.priority]}</span>}
                          <span>+{formatDistance(Math.max(0, detour))} detour</span>
                        </div>
                      </div>
                    </label>
                  ))}
                  <Button variant="secondary" className="w-full" onClick={runPreview} loading={computing}><RouteIcon className="w-4 h-4 mr-1.5" />Preview route</Button>
                </div>
              )
          )}

          {/* Route preview (§12) */}
          {preview && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
              <div className="font-medium text-foreground mb-1">Route preview</div>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>Direct: {formatDistance(preview.base.distanceM)} · {formatDuration(preview.base.durationS)}</div>
                <div className="text-foreground">With {chosen.size} stop{chosen.size === 1 ? '' : 's'}: {formatDistance(preview.full.distanceM)} · {formatDuration(preview.full.durationS)}</div>
                <div className="text-primary">+{formatDistance(Math.max(0, preview.full.distanceM - preview.base.distanceM))} · +{formatDuration(Math.max(0, preview.full.durationS - preview.base.durationS))} · {chosen.size} shops covered</div>
                {(preview.base.approximate || preview.full.approximate) && <div>≈ straight-line estimate (routing unavailable)</div>}
              </div>
            </div>
          )}
        </div>
        {destination && chosen.size > 0 && (
          <div className="p-3 border-t border-border">
            <Button className="w-full h-11" onClick={() => onStartRoute(orderedChosen.map(p => p.id), destination)}><Flag className="w-4 h-4 mr-1.5" />Start Route ({chosen.size})</Button>
          </div>
        )}
      </div>
    </ModalOverlay>
  )
}

// ── Route Session (§13) ───────────────────────────────────────────────────────
export function RouteSessionBar({ stops, index, destination, onOpen, onNavigate, onQuick, onSkip, onExit }: {
  stops: FieldPlace[]; index: number; destination: { label: string; latitude: number; longitude: number } | null
  onOpen: (p: FieldPlace) => void; onNavigate: (p: FieldPlace) => void; onQuick: (p: FieldPlace) => void
  onSkip: () => void; onExit: () => void
}) {
  const current = stops[index]
  const next = stops[index + 1]
  const done = index >= stops.length
  return (
    <div className="fixed bottom-16 lg:bottom-4 inset-x-0 z-40 px-3 pointer-events-none">
      <div className="max-w-md mx-auto rounded-2xl border border-primary/40 bg-card shadow-2xl overflow-hidden pointer-events-auto">
        <div className="flex items-center justify-between px-3 py-1.5 bg-primary/10 border-b border-primary/20">
          <span className="text-xs font-semibold text-primary flex items-center gap-1.5"><RouteIcon className="w-3.5 h-3.5" />Field Route · {Math.min(index, stops.length)}/{stops.length}</span>
          <button onClick={onExit} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        {done ? (
          <div className="p-3 text-center">
            <div className="text-sm font-medium text-foreground">Route complete 🎉</div>
            {destination && <div className="text-xs text-muted-foreground mt-0.5">Head to {destination.label}</div>}
            <Button size="sm" className="mt-2" onClick={onExit}>Done</Button>
          </div>
        ) : (
          <div className="p-3">
            <button onClick={() => onOpen(current)} className="block text-left w-full">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Current stop</div>
              <div className="font-semibold text-foreground truncate">{current.name}</div>
            </button>
            {next && <div className="text-xs text-muted-foreground mt-0.5 truncate">Next: {next.name}</div>}
            <div className="flex items-center gap-2 mt-2">
              <Button size="sm" variant="secondary" className="h-9 px-2" onClick={() => onNavigate(current)}><Navigation className="w-4 h-4" /></Button>
              <Button size="sm" className="flex-1 h-9" onClick={() => onQuick(current)}><Zap className="w-3.5 h-3.5 mr-1" />Quick Visit</Button>
              <Button size="sm" variant="ghost" className="h-9 px-2" onClick={onSkip}><SkipForward className="w-4 h-4" /></Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
