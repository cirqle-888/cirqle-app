'use client'

/**
 * Field Marketing — the interactive client. Reads arrive as plain props from the
 * server page; every write goes through actions.ts. The Leaflet canvas is loaded
 * lazily (ssr:false) so it never enters the server bundle. Rep names render via
 * <EmployeeName> so the CQID privacy rule (build lint) is respected.
 */

import { useEffect, useMemo, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { EmployeeName } from '@/components/ui/employee-name'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { formatDistanceToNow, format } from 'date-fns'
import {
  MapPin, Search, Plus, Crosshair, Navigation, Phone, Mail, X, Trash2, Loader2,
  CheckCircle2, Clock, Building2, LocateFixed, Map as MapIcon, ClipboardList,
} from 'lucide-react'
import {
  FIELD_STATUSES, FIELD_CATEGORIES, FIELD_LIKELIHOODS,
  STATUS_LABEL, STATUS_CHIP, STATUS_COLOR, CATEGORY_LABEL, LIKELIHOOD_LABEL, LIKELIHOOD_CHIP,
  type FieldPlace, type FieldStatus, type FieldCategory, type FieldLikelihood,
  type FieldContact, type FieldVisit, type FieldTerritory,
} from '@/lib/field/types'
import { distanceMeters, bearingDegrees, compassPoint, formatDistance, nearestWithin, buildNavigationUrl, detectPlatform } from '@/lib/field/geo'
import { getMapProvider } from '@/lib/field/map-provider'
import {
  createPlace, updatePlace, updatePlaceStatus, assignPlace, setFollowup,
  addContact, deleteContact, logVisit, getPlaceDetail, deletePlace,
  convertPlaceToClient, saveTerritory, deleteTerritory,
} from './actions'

const PlaceMap = dynamic(() => import('./place-map'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground bg-secondary/40">
      <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading map…</span>
    </div>
  ),
})

interface EmployeeRow { id: string; cqid: string | null; name: string | null }
interface UserLoc { latitude: number; longitude: number; accuracy?: number }

const inputCls = 'w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

function rel(dateStr: string | null): string {
  if (!dateStr) return '—'
  try { return formatDistanceToNow(new Date(dateStr), { addSuffix: true }) } catch { return '—' }
}

export default function FieldClient({
  places: initialPlaces, territories: initialTerritories, employees, canManage, meEmployeeId,
}: {
  places: FieldPlace[]
  territories: FieldTerritory[]
  employees: EmployeeRow[]
  canManage: boolean
  meEmployeeId: string | null
}) {
  const toast = useToast()
  const [, startTransition] = useTransition()

  const [places, setPlaces] = useState<FieldPlace[]>(initialPlaces)
  const [territories, setTerritories] = useState<FieldTerritory[]>(initialTerritories)

  // Filters
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [assigned, setAssigned] = useState('')
  const [territory, setTerritory] = useState('')
  const [dueOnly, setDueOnly] = useState(false)
  const [q, setQ] = useState('')

  // Map / selection / GPS
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [userLoc, setUserLoc] = useState<UserLoc | null>(null)
  const [geoDenied, setGeoDenied] = useState(false)
  const [fitSignal, setFitSignal] = useState(0)
  const [flyTo, setFlyTo] = useState<{ latitude: number; longitude: number; zoom?: number; nonce: number } | null>(null)

  // Add-place flow
  const [addMode, setAddMode] = useState(false)
  const [draft, setDraft] = useState<{ latitude: number; longitude: number; address?: string } | null>(null)

  // Modals
  const [showTerritories, setShowTerritories] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<FieldPlace | null>(null)

  const empMap = useMemo(() => {
    const m = new Map<string, EmployeeRow>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])
  const terrMap = useMemo(() => {
    const m = new Map<string, FieldTerritory>()
    for (const t of territories) m.set(t.id, t)
    return m
  }, [territories])

  // ── Live GPS (watchPosition works in browser + Capacitor WebView) ────────────
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (pos) => setUserLoc({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => { if (err.code === err.PERMISSION_DENIED) setGeoDenied(true) },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  // Snapshot "now" once at mount (a pure initializer) — used to flag due
  // follow-ups. Refreshed every minute so the "due" badge stays honest.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const isDue = (p: FieldPlace) => !!p.next_followup_at && new Date(p.next_followup_at).getTime() <= nowMs && p.status !== 'converted'

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return places.filter((p) => {
      if (status && p.status !== status) return false
      if (category && p.category !== category) return false
      if (assigned === 'unassigned' && p.assigned_to) return false
      else if (assigned && assigned !== 'unassigned' && p.assigned_to !== assigned) return false
      if (territory === 'none' && p.territory_id) return false
      else if (territory && territory !== 'none' && p.territory_id !== territory) return false
      if (dueOnly && !isDue(p)) return false
      if (needle) {
        const hay = `${p.name} ${p.address ?? ''} ${p.area ?? ''} ${p.notes ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, status, category, assigned, territory, dueOnly, q, nowMs])

  // Sort the list by distance when we have a position, else newest first.
  const listed = useMemo(() => {
    const arr = [...filtered]
    if (userLoc) {
      arr.sort((a, b) => distanceMeters(userLoc, a) - distanceMeters(userLoc, b))
    }
    return arr
  }, [filtered, userLoc])

  const kpis = useMemo(() => {
    let covered = 0, interested = 0, converted = 0, due = 0
    for (const p of places) {
      if (p.status !== 'not_visited') covered++
      if (p.status === 'interested' || p.status === 'negotiating') interested++
      if (p.status === 'converted') converted++
      if (isDue(p)) due++
    }
    return { total: places.length, covered, interested, converted, due }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, nowMs])

  const selected = selectedId ? places.find((p) => p.id === selectedId) ?? null : null

  // ── optimistic patch ─────────────────────────────────────────────────────────
  function patch(id: string, p: Partial<FieldPlace>) {
    setPlaces((prev) => prev.map((x) => (x.id === id ? { ...x, ...p } : x)))
  }

  function onStatus(p: FieldPlace, next: FieldStatus) {
    patch(p.id, { status: next })
    startTransition(async () => {
      const res = await updatePlaceStatus(p.id, next)
      if (!res.ok) { toast.error('Could not update status', res.error); patch(p.id, { status: p.status }) }
    })
  }
  function onLikelihood(p: FieldPlace, next: FieldLikelihood | null) {
    patch(p.id, { likelihood: next })
    startTransition(async () => {
      const res = await updatePlace(p.id, { likelihood: next })
      if (!res.ok) { toast.error('Could not update', res.error); patch(p.id, { likelihood: p.likelihood }) }
    })
  }
  function onAssign(p: FieldPlace, employeeId: string | null) {
    patch(p.id, { assigned_to: employeeId })
    startTransition(async () => {
      const res = await assignPlace(p.id, employeeId)
      if (!res.ok) { toast.error('Could not assign', res.error); patch(p.id, { assigned_to: p.assigned_to }) }
    })
  }

  // ── Navigate handoff (the ONLY external maps open) ───────────────────────────
  function navigateTo(p: FieldPlace) {
    const url = buildNavigationUrl(p, { platform: detectPlatform(), label: p.name })
    const a = document.createElement('a')
    a.href = url; a.target = '_blank'; a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
  }

  function locateMe() {
    if (userLoc) { setFlyTo({ latitude: userLoc.latitude, longitude: userLoc.longitude, zoom: 16, nonce: Date.now() }) }
    else toast.info('Location not available yet', geoDenied ? 'Enable location access to use this.' : 'Waiting for a GPS fix…')
  }

  // ── Add-place: enter map-pick mode ───────────────────────────────────────────
  function beginAdd() {
    setSelectedId(null)
    setAddMode(true)
    toast.info('Pick the location', 'Tap the map where the place is, or use “Use my location”.')
  }
  function cancelAdd() { setAddMode(false); setDraft(null) }

  async function onMapClick(lat: number, lng: number) {
    setDraft({ latitude: lat, longitude: lng })
    // Reverse geocode in the background to prefill the address.
    const addr = await getMapProvider().reverseGeocode(lat, lng).catch(() => null)
    setDraft((d) => (d ? { ...d, address: addr ?? undefined } : d))
  }
  function useMyLocationForDraft() {
    if (!userLoc) { toast.info('Location not available yet'); return }
    void onMapClick(userLoc.latitude, userLoc.longitude)
  }

  return (
    <>
      <Header
        title="Field Marketing"
        subtitle="Direct marketing on the map — visits, follow-ups and coverage"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={locateMe}><LocateFixed className="w-4 h-4 mr-1.5" />Locate me</Button>
            {canManage && (
              <Button size="sm" onClick={addMode ? cancelAdd : beginAdd}>
                {addMode ? <><X className="w-4 h-4 mr-1.5" />Cancel</> : <><Plus className="w-4 h-4 mr-1.5" />Add place</>}
              </Button>
            )}
          </div>
        }
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1500px] mx-auto w-full">
        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mb-4">
          <KpiTile label="Places" value={kpis.total} icon={MapPin} />
          <KpiTile label="Covered" value={kpis.covered} icon={CheckCircle2} />
          <KpiTile label="In play" sub="interested/negotiating" value={kpis.interested} icon={ClipboardList} />
          <KpiTile label="Converted" value={kpis.converted} icon={Building2} />
          <KpiTile label="Follow-ups due" value={kpis.due} icon={Clock} highlight={kpis.due > 0} />
        </div>

        {geoDenied && (
          <div className="mb-3 text-xs rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-500 px-3 py-2">
            Location access is off, so “you are here” and distances are unavailable. Enable location for this site to use GPS.
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, address, area, notes…"
              className="w-full h-9 pl-8 pr-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <AppSelect value={status} onChange={(e) => setStatus(e.target.value)} wrapperClassName="w-auto">
            <option value="">All statuses</option>
            {FIELD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </AppSelect>
          <AppSelect value={category} onChange={(e) => setCategory(e.target.value)} wrapperClassName="w-auto">
            <option value="">All types</option>
            {FIELD_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </AppSelect>
          <AppSelect value={assigned} onChange={(e) => setAssigned(e.target.value)} wrapperClassName="w-auto">
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
          </AppSelect>
          {territories.length > 0 && (
            <AppSelect value={territory} onChange={(e) => setTerritory(e.target.value)} wrapperClassName="w-auto">
              <option value="">All areas</option>
              <option value="none">No territory</option>
              {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </AppSelect>
          )}
          <button onClick={() => setDueOnly((v) => !v)}
            className={`h-9 px-3 rounded-lg text-sm border transition-colors ${dueOnly ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'}`}>
            <Clock className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />Due
          </button>
          <button onClick={() => setFitSignal((n) => n + 1)} title="Fit map to results"
            className="h-9 px-3 rounded-lg text-sm border bg-secondary border-border text-muted-foreground hover:text-foreground">
            <MapIcon className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />Fit
          </button>
          {canManage && (
            <button onClick={() => setShowTerritories(true)}
              className="h-9 px-3 rounded-lg text-sm border bg-secondary border-border text-muted-foreground hover:text-foreground">
              Territories
            </button>
          )}
        </div>

        {/* Map + list */}
        <div className="grid lg:grid-cols-[minmax(0,1fr)_400px] gap-4">
          {/* `isolate` traps Leaflet's internal z-indexes (panes 400, controls
              1000) inside this card's own stacking context — without it they
              leak into the page root and paint OVER modal overlays (z-50/60),
              hiding drawer/modal bodies that overlap the map. */}
          <div className="relative isolate rounded-xl overflow-hidden border border-border h-[52vh] lg:h-[72vh] bg-secondary/30">
            <PlaceMap
              places={filtered}
              selectedId={selectedId}
              userLocation={userLoc}
              addMode={addMode}
              draftPin={draft}
              onSelect={(id) => setSelectedId(id)}
              onMapClick={onMapClick}
              fitSignal={fitSignal}
              flyTo={flyTo}
              className="absolute inset-0"
            />
            {addMode && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[500] flex items-center gap-2 rounded-full bg-background/95 border border-border shadow-lg px-3 py-1.5 text-xs">
                <Crosshair className="w-3.5 h-3.5 text-primary" />
                <span>Tap the map to place it</span>
                <button onClick={useMyLocationForDraft} className="text-primary font-medium hover:underline">Use my location</button>
                <button onClick={cancelAdd} className="text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            )}
          </div>

          {/* List */}
          <div className="lg:h-[72vh] lg:overflow-y-auto rounded-xl">
            {listed.length === 0 ? (
              <Card><CardContent className="p-0">
                <EmptyState
                  icon={MapPin}
                  title={places.length === 0 ? 'No places yet' : 'No places match'}
                  body={places.length === 0
                    ? 'Add the supermarkets, shops and business centres you visit. They appear as pins here and on the map, so you can see what’s covered and plan follow-ups.'
                    : 'Adjust the filters above to see more places.'}
                  action={canManage && places.length === 0 ? { label: 'Add place', onClick: beginAdd } : undefined}
                />
              </CardContent></Card>
            ) : (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground px-1">{listed.length} place{listed.length === 1 ? '' : 's'}{userLoc ? ' · nearest first' : ''}</div>
                {listed.map((p) => (
                  <PlaceRow
                    key={p.id}
                    place={p}
                    dist={userLoc ? distanceMeters(userLoc, p) : null}
                    selected={p.id === selectedId}
                    territory={p.territory_id ? terrMap.get(p.territory_id) ?? null : null}
                    onOpen={() => setSelectedId(p.id)}
                    due={isDue(p)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Detail drawer */}
      {selected && (
        <PlaceDrawer
          place={selected}
          employees={employees}
          empMap={empMap}
          userLoc={userLoc}
          canManage={canManage}
          onClose={() => setSelectedId(null)}
          onStatus={(s) => onStatus(selected, s)}
          onLikelihood={(l) => onLikelihood(selected, l)}
          onAssign={(id) => onAssign(selected, id)}
          onNavigate={() => navigateTo(selected)}
          onPatch={(pp) => patch(selected.id, pp)}
          onDelete={() => setConfirmDelete(selected)}
          toast={toast}
        />
      )}

      {/* Add-place modal (opens once a location is picked) */}
      {draft && canManage && (
        <AddPlaceModal
          draft={draft}
          places={places}
          employees={employees}
          territories={territories}
          meEmployeeId={meEmployeeId}
          onClose={cancelAdd}
          onCreate={(input) => new Promise<boolean>((resolve) => {
            startTransition(async () => {
              const res = await createPlace(input)
              if (!res.ok || !res.data) { toast.error('Could not add place', res.error); resolve(false); return }
              const newPlace: FieldPlace = {
                id: res.data.id, name: input.name, category: (input.category ?? 'shop') as FieldCategory,
                status: 'not_visited', likelihood: input.likelihood ?? null,
                latitude: input.latitude, longitude: input.longitude,
                address: input.address ?? null, area: input.area ?? null, google_place_id: null,
                assigned_to: input.assignedTo ?? null, territory_id: input.territoryId ?? null,
                last_visit_at: null, next_followup_at: null, notes: input.notes ?? null,
                converted_client_id: null, converted_lead_id: null,
                created_by: meEmployeeId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              }
              setPlaces((prev) => [newPlace, ...prev])
              setAddMode(false); setDraft(null); setSelectedId(newPlace.id)
              toast.success('Place added')
              resolve(true)
            })
          })}
        />
      )}

      {/* Territories manager */}
      {showTerritories && canManage && (
        <TerritoriesModal
          territories={territories}
          employees={employees}
          empMap={empMap}
          onClose={() => setShowTerritories(false)}
          onSave={(input) => new Promise<boolean>((resolve) => {
            startTransition(async () => {
              const res = await saveTerritory(input)
              if (!res.ok || !res.data) { toast.error('Could not save', res.error); resolve(false); return }
              setTerritories((prev) => {
                const existing = prev.find((t) => t.id === res.data!.id)
                const row: FieldTerritory = {
                  id: res.data!.id, name: input.name, color: input.color || '#6366f1',
                  assigned_to: input.assignedTo ?? null, geojson: null,
                  created_at: existing?.created_at ?? new Date().toISOString(),
                }
                return existing ? prev.map((t) => (t.id === row.id ? row : t)) : [...prev, row]
              })
              resolve(true)
            })
          })}
          onDelete={(id) => {
            setTerritories((prev) => prev.filter((t) => t.id !== id))
            startTransition(async () => { const res = await deleteTerritory(id); if (!res.ok) toast.error('Could not delete', res.error) })
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this place?"
          body={`“${confirmDelete.name}” and its visit history will be removed. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const id = confirmDelete.id
            setConfirmDelete(null)
            startTransition(async () => {
              const res = await deletePlace(id)
              if (!res.ok) toast.error('Could not delete', res.error)
              else { setPlaces((prev) => prev.filter((p) => p.id !== id)); setSelectedId(null); toast.success('Place deleted') }
            })
          }}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

// ── KPI tile ──────────────────────────────────────────────────────────────────

function KpiTile({ label, value, sub, icon: Icon, highlight }: {
  label: string; value: number | string; sub?: string; icon?: typeof MapPin; highlight?: boolean
}) {
  return (
    <div className={`rounded-xl border p-3 ${highlight ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="w-3.5 h-3.5" />}{label}
      </div>
      <div className="text-xl font-semibold text-foreground mt-1">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

// ── List row ────────────────────────────────────────────────────────────────────

function PlaceRow({ place, dist, selected, territory, due, onOpen }: {
  place: FieldPlace; dist: number | null; selected: boolean; territory: FieldTerritory | null; due: boolean; onOpen: () => void
}) {
  return (
    <button onClick={onOpen}
      className={`w-full text-left rounded-lg border p-3 transition-colors ${selected ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-secondary/50'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-foreground truncate flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_COLOR[place.status] }} />
            {place.name}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {CATEGORY_LABEL[place.category]}{place.area ? ` · ${place.area}` : place.address ? ` · ${place.address}` : ''}
          </div>
        </div>
        <div className="text-right shrink-0">
          {dist != null && <div className="text-xs font-medium text-foreground">{formatDistance(dist)}</div>}
          {place.last_visit_at
            ? <div className="text-[10px] text-muted-foreground">visited {rel(place.last_visit_at)}</div>
            : <div className="text-[10px] text-muted-foreground">not visited</div>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-medium ${STATUS_CHIP[place.status]}`}>{STATUS_LABEL[place.status]}</span>
        {place.likelihood && <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-medium ${LIKELIHOOD_CHIP[place.likelihood]}`}>{LIKELIHOOD_LABEL[place.likelihood]}</span>}
        {territory && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-muted-foreground border border-border"><span className="w-2 h-2 rounded-full" style={{ background: territory.color }} />{territory.name}</span>}
        {due && <span className="inline-flex px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-500">Follow-up due</span>}
      </div>
    </button>
  )
}

// ── Detail drawer ────────────────────────────────────────────────────────────────

function PlaceDrawer({
  place, employees, empMap, userLoc, canManage,
  onClose, onStatus, onLikelihood, onAssign, onNavigate, onPatch, onDelete, toast,
}: {
  place: FieldPlace
  employees: EmployeeRow[]
  empMap: Map<string, EmployeeRow>
  userLoc: UserLoc | null
  canManage: boolean
  onClose: () => void
  onStatus: (s: FieldStatus) => void
  onLikelihood: (l: FieldLikelihood | null) => void
  onAssign: (id: string | null) => void
  onNavigate: () => void
  onPatch: (p: Partial<FieldPlace>) => void
  onDelete: () => void
  toast: ReturnType<typeof useToast>
}) {
  const [, startTransition] = useTransition()
  // Keyed by placeId so switching places shows a fresh load without a
  // synchronous setState in the effect (which the React lint forbids).
  const [detail, setDetail] = useState<{ placeId: string; contacts: FieldContact[]; visits: FieldVisit[] } | null>(null)
  const [showVisit, setShowVisit] = useState(false)
  const [contactDraft, setContactDraft] = useState<{ name: string; phone: string; role: string } | null>(null)
  const [converting, setConverting] = useState(false)

  const loadingDetail = detail?.placeId !== place.id
  const contacts = loadingDetail ? [] : detail!.contacts
  const visits = loadingDetail ? [] : detail!.visits

  useEffect(() => {
    let alive = true
    getPlaceDetail(place.id).then((res) => {
      if (!alive) return
      setDetail({
        placeId: place.id,
        contacts: res.ok && res.data ? res.data.contacts : [],
        visits: res.ok && res.data ? res.data.visits : [],
      })
    })
    return () => { alive = false }
  }, [place.id])

  const dist = userLoc ? distanceMeters(userLoc, place) : null
  const dir = userLoc ? compassPoint(bearingDegrees(userLoc, place)) : null

  function saveFollowup(value: string) {
    const iso = value ? new Date(value).toISOString() : null
    onPatch({ next_followup_at: iso })
    startTransition(async () => { const res = await setFollowup(place.id, iso); if (!res.ok) toast.error('Could not set follow-up', res.error) })
  }

  function submitContact() {
    if (!contactDraft) return
    const input = { name: contactDraft.name, phone: contactDraft.phone, role: contactDraft.role }
    startTransition(async () => {
      const res = await addContact(place.id, input)
      if (!res.ok || !res.data) { toast.error('Could not add contact', res.error); return }
      setDetail((d) => (d ? { ...d, contacts: [...d.contacts, res.data!] } : d))
      setContactDraft(null)
    })
  }

  function removeContact(id: string) {
    setDetail((d) => (d ? { ...d, contacts: d.contacts.filter((c) => c.id !== id) } : d))
    startTransition(async () => { const res = await deleteContact(id); if (!res.ok) toast.error('Could not remove', res.error) })
  }

  function convert() {
    setConverting(true)
    startTransition(async () => {
      const res = await convertPlaceToClient(place.id)
      setConverting(false)
      if (!res.ok || !res.data) { toast.error('Could not convert', res.error); return }
      onPatch({ status: 'converted', converted_client_id: res.data.clientId })
      toast.success('Converted to client', 'A client record was created and linked.')
    })
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[440px] max-h-[90dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 p-4 border-b border-border">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_COLOR[place.status] }} />
              <h2 className="text-base font-semibold text-foreground truncate">{place.name}</h2>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {CATEGORY_LABEL[place.category]}{place.address ? ` · ${place.address}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4">
          {/* Distance + navigate */}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onNavigate} className="flex-1"><Navigation className="w-4 h-4 mr-1.5" />Navigate</Button>
            {dist != null && (
              <div className="text-xs text-muted-foreground whitespace-nowrap">{formatDistance(dist)}{dir ? ` · ${dir}` : ''} from you</div>
            )}
          </div>

          {place.converted_client_id && (
            <div className="text-xs rounded-lg border border-green-500/30 bg-green-500/10 text-green-500 px-3 py-2">
              Converted to a client. <Link href="/dashboard/clients" className="underline">Open Clients</Link>
            </div>
          )}

          {/* Status + likelihood */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Status</label>
              {canManage ? (
                <AppSelect value={place.status} onChange={(e) => onStatus(e.target.value as FieldStatus)}>
                  {FIELD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </AppSelect>
              ) : <span className={`inline-flex px-2 py-1 rounded-md text-xs font-medium ${STATUS_CHIP[place.status]}`}>{STATUS_LABEL[place.status]}</span>}
            </div>
            <div>
              <label className={labelCls}>Chance of converting</label>
              {canManage ? (
                <AppSelect value={place.likelihood ?? ''} onChange={(e) => onLikelihood((e.target.value || null) as FieldLikelihood | null)}>
                  <option value="">Unset</option>
                  {FIELD_LIKELIHOODS.map((l) => <option key={l} value={l}>{LIKELIHOOD_LABEL[l]}</option>)}
                </AppSelect>
              ) : place.likelihood ? <span className={`inline-flex px-2 py-1 rounded-md text-xs font-medium ${LIKELIHOOD_CHIP[place.likelihood]}`}>{LIKELIHOOD_LABEL[place.likelihood]}</span> : <span className="text-xs text-muted-foreground">—</span>}
            </div>
          </div>

          {/* Owner + follow-up */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Owner</label>
              {canManage ? (
                <AppSelect value={place.assigned_to ?? ''} onChange={(e) => onAssign(e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
                </AppSelect>
              ) : place.assigned_to ? <EmployeeName emp={empMap.get(place.assigned_to)} className="text-sm" /> : <span className="text-xs text-muted-foreground">—</span>}
            </div>
            <div>
              <label className={labelCls}>Next follow-up</label>
              {canManage ? (
                <input type="datetime-local" className={inputCls}
                  value={place.next_followup_at ? format(new Date(place.next_followup_at), "yyyy-MM-dd'T'HH:mm") : ''}
                  onChange={(e) => saveFollowup(e.target.value)} />
              ) : <span className="text-sm text-foreground">{place.next_followup_at ? format(new Date(place.next_followup_at), 'PPp') : '—'}</span>}
            </div>
          </div>

          {place.notes && <div className="text-sm text-foreground whitespace-pre-wrap rounded-lg bg-secondary/50 p-2.5">{place.notes}</div>}

          {/* Contacts */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className={labelCls + ' !mb-0'}>Contacts</label>
              {canManage && !contactDraft && (
                <button onClick={() => setContactDraft({ name: '', phone: '', role: '' })} className="text-xs text-primary hover:underline">+ Add contact</button>
              )}
            </div>
            <div className="space-y-1.5">
              {loadingDetail && <div className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Loading…</div>}
              {contacts.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
                  <div className="min-w-0">
                    <div className="text-sm text-foreground truncate">{c.name || 'Contact'}{c.role ? <span className="text-muted-foreground"> · {c.role}</span> : null}</div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      {c.phone && <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 hover:text-foreground"><Phone className="w-3 h-3" />{c.phone}</a>}
                      {c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 hover:text-foreground"><Mail className="w-3 h-3" />{c.email}</a>}
                    </div>
                  </div>
                  {canManage && <button onClick={() => removeContact(c.id)} className="text-muted-foreground hover:text-red-400 p-1"><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              ))}
              {!loadingDetail && contacts.length === 0 && !contactDraft && <div className="text-xs text-muted-foreground">No contacts yet.</div>}
              {contactDraft && (
                <div className="rounded-lg border border-border p-2 space-y-2">
                  <input autoFocus placeholder="Name" className={inputCls} value={contactDraft.name} onChange={(e) => setContactDraft({ ...contactDraft, name: e.target.value })} />
                  <div className="grid grid-cols-2 gap-2">
                    <input placeholder="Phone" className={inputCls} value={contactDraft.phone} onChange={(e) => setContactDraft({ ...contactDraft, phone: e.target.value })} />
                    <input placeholder="Role (Owner…)" className={inputCls} value={contactDraft.role} onChange={(e) => setContactDraft({ ...contactDraft, role: e.target.value })} />
                  </div>
                  <div className="flex items-center gap-2 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setContactDraft(null)}>Cancel</Button>
                    <Button size="sm" onClick={submitContact}>Save</Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Visits */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className={labelCls + ' !mb-0'}>Visit history</label>
              {canManage && <button onClick={() => setShowVisit(true)} className="text-xs text-primary hover:underline">+ Log visit</button>}
            </div>
            <div className="space-y-1.5">
              {visits.map((v) => (
                <div key={v.id} className="rounded-lg border border-border p-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground font-medium">{v.visited_by ? <EmployeeName emp={empMap.get(v.visited_by)} /> : 'Someone'}</span>
                    <span className="text-muted-foreground">{rel(v.visited_at)}</span>
                  </div>
                  {v.outcome && <span className={`inline-flex mt-1 px-2 py-0.5 rounded-md text-[11px] font-medium ${STATUS_CHIP[v.outcome as FieldStatus] ?? 'bg-secondary'}`}>{STATUS_LABEL[v.outcome as FieldStatus] ?? v.outcome}</span>}
                  {v.notes && <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{v.notes}</div>}
                </div>
              ))}
              {!loadingDetail && visits.length === 0 && <div className="text-xs text-muted-foreground">No visits logged yet.</div>}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        {canManage && (
          <div className="border-t border-border p-3 flex items-center gap-2">
            <Button size="sm" variant="secondary" className="flex-1" onClick={() => setShowVisit(true)}><ClipboardList className="w-4 h-4 mr-1.5" />Log visit</Button>
            {!place.converted_client_id && (
              <Button size="sm" variant="secondary" className="flex-1" onClick={convert} loading={converting}><Building2 className="w-4 h-4 mr-1.5" />Convert</Button>
            )}
            <button onClick={onDelete} className="text-muted-foreground hover:text-red-400 p-2"><Trash2 className="w-4 h-4" /></button>
          </div>
        )}
      </div>

      {showVisit && (
        <LogVisitModal
          placeName={place.name}
          userLoc={userLoc}
          currentStatus={place.status}
          onClose={() => setShowVisit(false)}
          onSubmit={(input) => new Promise<boolean>((resolve) => {
            startTransition(async () => {
              const res = await logVisit(place.id, input)
              if (!res.ok || !res.data) { toast.error('Could not log visit', res.error); resolve(false); return }
              const d = res.data
              onPatch({ last_visit_at: d.last_visit_at, ...(d.status ? { status: d.status } : {}), next_followup_at: d.next_followup_at })
              setDetail((cur) => (cur ? { ...cur, visits: [d.visit, ...cur.visits] } : cur))
              setShowVisit(false)
              toast.success('Visit logged')
              resolve(true)
            })
          })}
        />
      )}
    </ModalOverlay>
  )
}

// ── Log-visit modal ──────────────────────────────────────────────────────────────

function LogVisitModal({ placeName, userLoc, currentStatus, onClose, onSubmit }: {
  placeName: string
  userLoc: UserLoc | null
  currentStatus: FieldStatus
  onClose: () => void
  onSubmit: (input: { outcome?: FieldStatus | null; notes?: string | null; latitude?: number | null; longitude?: number | null; nextFollowupAt?: string | null }) => Promise<boolean>
}) {
  const [outcome, setOutcome] = useState<FieldStatus>(currentStatus === 'not_visited' ? 'visited' : currentStatus)
  const [notes, setNotes] = useState('')
  const [followup, setFollowup] = useState('')
  const [saving, setSaving] = useState(false)

  return (
    <ModalOverlay onClose={onClose} zIndex="z-[60]">
      <div className="bg-card border border-border rounded-2xl w-[min(92vw,400px)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">Log visit</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="text-xs text-muted-foreground">{placeName}{userLoc ? ' · your GPS position will be recorded' : ''}</div>
        <div>
          <label className={labelCls}>Outcome (new status)</label>
          <AppSelect value={outcome} onChange={(e) => setOutcome(e.target.value as FieldStatus)}>
            {FIELD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </AppSelect>
        </div>
        <div>
          <label className={labelCls}>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
            placeholder="What happened, who you met, next steps…"
            className="w-full px-3 py-2 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
        </div>
        <div>
          <label className={labelCls}>Schedule next follow-up (optional)</label>
          <input type="datetime-local" className={inputCls} value={followup} onChange={(e) => setFollowup(e.target.value)} />
        </div>
        <div className="flex items-center gap-2 justify-end pt-1">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={async () => {
            setSaving(true)
            const ok = await onSubmit({
              outcome, notes,
              latitude: userLoc?.latitude ?? null, longitude: userLoc?.longitude ?? null,
              nextFollowupAt: followup ? new Date(followup).toISOString() : null,
            })
            if (!ok) setSaving(false)
          }}>Save visit</Button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Add-place modal ──────────────────────────────────────────────────────────────

function AddPlaceModal({ draft, places, employees, territories, meEmployeeId, onClose, onCreate }: {
  draft: { latitude: number; longitude: number; address?: string }
  places: FieldPlace[]
  employees: EmployeeRow[]
  territories: FieldTerritory[]
  meEmployeeId: string | null
  onClose: () => void
  onCreate: (input: {
    name: string; category?: FieldCategory; latitude: number; longitude: number
    address?: string | null; area?: string | null; likelihood?: FieldLikelihood | null; notes?: string | null
    assignedTo?: string | null; territoryId?: string | null; contactName?: string | null; contactPhone?: string | null
  }) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState<FieldCategory>('supermarket')
  const [likelihood, setLikelihood] = useState<FieldLikelihood | ''>('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [assignedTo, setAssignedTo] = useState<string>(meEmployeeId ?? '')
  const [territoryId, setTerritoryId] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  // Duplicate warning: any existing place within ~50 m of the dropped pin?
  const nearby = useMemo(() => nearestWithin(draft, places, 60), [draft, places])

  return (
    <ModalOverlay onClose={onClose} zIndex="z-[60]" sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[440px] max-h-[90dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-base font-semibold text-foreground">Add place</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3">
          <div className="text-xs text-muted-foreground rounded-lg bg-secondary/50 p-2 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            {draft.address || `${draft.latitude.toFixed(5)}, ${draft.longitude.toFixed(5)}`}
          </div>

          {nearby && (
            <div className="text-xs rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-500 px-3 py-2">
              A place already exists {formatDistance(nearby.meters)} away (“{nearby.place.name}”). It may already be covered — check before adding a duplicate.
            </div>
          )}

          <div>
            <label className={labelCls}>Name *</label>
            <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SuperMart, MG Road" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Type</label>
              <AppSelect value={category} onChange={(e) => setCategory(e.target.value as FieldCategory)}>
                {FIELD_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className={labelCls}>Chance of converting</label>
              <AppSelect value={likelihood} onChange={(e) => setLikelihood(e.target.value as FieldLikelihood | '')}>
                <option value="">Unset</option>
                {FIELD_LIKELIHOODS.map((l) => <option key={l} value={l}>{LIKELIHOOD_LABEL[l]}</option>)}
              </AppSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Contact name</label>
              <input className={inputCls} value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Contact phone</label>
              <input className={inputCls} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} inputMode="tel" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Assign to</label>
              <AppSelect value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className={labelCls}>Territory</label>
              <AppSelect value={territoryId} onChange={(e) => setTerritoryId(e.target.value)}>
                <option value="">None</option>
                {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </AppSelect>
            </div>
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full px-3 py-2 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
          </div>
        </div>
        <div className="border-t border-border p-3 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={async () => {
            if (!name.trim()) return
            setSaving(true)
            const ok = await onCreate({
              name: name.trim(), category, latitude: draft.latitude, longitude: draft.longitude,
              address: draft.address ?? null, likelihood: likelihood || null, notes,
              assignedTo: assignedTo || null, territoryId: territoryId || null,
              contactName: contactName || null, contactPhone: contactPhone || null,
            })
            if (!ok) setSaving(false)
          }}>Add place</Button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Territories modal ────────────────────────────────────────────────────────────

function TerritoriesModal({ territories, employees, empMap, onClose, onSave, onDelete }: {
  territories: FieldTerritory[]
  employees: EmployeeRow[]
  empMap: Map<string, EmployeeRow>
  onClose: () => void
  onSave: (input: { id?: string | null; name: string; color?: string; assignedTo?: string | null }) => Promise<boolean>
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6366f1')
  const [assignedTo, setAssignedTo] = useState('')
  const [saving, setSaving] = useState(false)

  return (
    <ModalOverlay onClose={onClose} zIndex="z-[60]">
      <div className="bg-card border border-border rounded-2xl w-[min(92vw,420px)] max-h-[90dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-base font-semibold text-foreground">Territories</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3">
          {territories.length > 0 && (
            <div className="space-y-1.5">
              {territories.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ background: t.color }} />
                    <span className="text-sm text-foreground truncate">{t.name}</span>
                    {t.assigned_to && <span className="text-xs text-muted-foreground truncate"><EmployeeName emp={empMap.get(t.assigned_to)} /></span>}
                  </div>
                  <button onClick={() => onDelete(t.id)} className="text-muted-foreground hover:text-red-400 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">New territory</div>
            <input className={inputCls} placeholder="Name (e.g. North Zone)" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center gap-2">
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded border border-border bg-secondary" />
                <span className="text-xs text-muted-foreground">Colour</span>
              </div>
              <AppSelect value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
              </AppSelect>
            </div>
            <div className="flex justify-end">
              <Button size="sm" loading={saving} onClick={async () => {
                if (!name.trim()) return
                setSaving(true)
                const ok = await onSave({ name: name.trim(), color, assignedTo: assignedTo || null })
                setSaving(false)
                if (ok) { setName(''); setAssignedTo('') }
              }}>Add</Button>
            </div>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
