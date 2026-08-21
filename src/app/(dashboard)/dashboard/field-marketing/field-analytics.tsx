'use client'

/**
 * Daily Field Report (§14) — end-of-day summary computed from today's visits.
 * Personal productivity + management view: visits, outcomes, prospects, contacts,
 * follow-ups, distance travelled, and coverage of the areas worked today. Reads
 * via getDailyReport; area coverage is derived from the places already in memory.
 */
import { useEffect, useMemo, useState } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { X, Loader2, ClipboardCheck } from 'lucide-react'
import { formatDistance } from '@/lib/field/geo'
import { type FieldPlace, type FieldTerritory } from '@/lib/field/types'
import { buildHierarchy } from './field-panels'
import { getDailyReport, type DailyReportVisit } from './actions'

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className={`text-2xl font-semibold ${tone ?? 'text-foreground'}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

export function DailyReportPanel({ places, territories, onClose }: {
  places: FieldPlace[]; territories: FieldTerritory[]; onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Awaited<ReturnType<typeof getDailyReport>>['data'] | null>(null)

  useEffect(() => {
    let alive = true
    getDailyReport().then(res => { if (alive) { setData(res.ok ? res.data ?? null : null); setLoading(false) } })
    return () => { alive = false }
  }, [])

  const H = useMemo(() => buildHierarchy(territories), [territories])
  const derived = useMemo(() => {
    const v: DailyReportVisit[] = data?.visits ?? []
    const outcomes: Record<string, number> = {}
    let interested = 0, hot = 0, warm = 0, converted = 0
    const areaSet = new Set<string>()
    for (const x of v) {
      if (x.outcome) outcomes[x.outcome] = (outcomes[x.outcome] || 0) + 1
      if (x.status === 'interested' || x.status === 'negotiating') interested++
      if (x.status === 'converted') converted++
      if (x.likelihood === 'hot') hot++
      if (x.likelihood === 'warm') warm++
      if (x.area) areaSet.add(x.area)
    }
    // Coverage % of the areas (localities) worked today, from all places in memory.
    const touchedLocalities = new Map<string, { name: string; total: number; covered: number }>()
    const visitedPlaceIds = new Set(v.map(x => x.placeId))
    const localityOfVisited = new Set<string>()
    for (const p of places) if (visitedPlaceIds.has(p.id) && p.territory_id) localityOfVisited.add(p.territory_id)
    for (const p of places) {
      if (!p.territory_id || !localityOfVisited.has(p.territory_id)) continue
      const name = H.chainFor(p.territory_id).locality ?? '—'
      const e = touchedLocalities.get(p.territory_id) ?? { name, total: 0, covered: 0 }
      e.total++; if (p.status !== 'not_visited') e.covered++
      touchedLocalities.set(p.territory_id, e)
    }
    return { outcomes, interested, hot, warm, converted, areas: [...areaSet], localities: [...touchedLocalities.values()] }
  }, [data, places, H])

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile zIndex="z-[60]">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:w-[460px] max-h-[90dvh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2"><ClipboardCheck className="w-5 h-5 text-primary" />Today’s Field Report</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-4">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground text-sm inline-flex items-center gap-2 w-full justify-center"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
          ) : !data || data.visits.length === 0 ? (
            <div className="py-8"><EmptyState icon={ClipboardCheck} title="No visits logged today" body="Log some visits and your daily summary — visits, outcomes, distance and coverage — will appear here." /></div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Visits" value={data.visits.length} tone="text-primary" />
                <Stat label="New prospects" value={data.newProspects} />
                <Stat label="Converted" value={derived.converted} tone={derived.converted ? 'text-green-400' : undefined} />
                <Stat label="Interested" value={derived.interested} />
                <Stat label="Hot / Warm" value={`${derived.hot}/${derived.warm}`} />
                <Stat label="Follow-ups" value={data.followupsCreated} />
                <Stat label="Contacts" value={data.contactsCollected} />
                <Stat label="Distance" value={formatDistance(data.distanceM)} />
                <Stat label="Areas" value={derived.areas.length} />
              </div>

              {Object.keys(derived.outcomes).length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Outcomes</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(derived.outcomes).sort((a, b) => b[1] - a[1]).map(([o, n]) => (
                      <span key={o} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-secondary text-xs text-foreground">{o} <span className="text-muted-foreground">· {n}</span></span>
                    ))}
                  </div>
                </div>
              )}

              {derived.localities.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Coverage of areas worked today</div>
                  <div className="space-y-1.5">
                    {derived.localities.map(l => {
                      const pct = l.total ? Math.round((l.covered / l.total) * 100) : 0
                      return (
                        <div key={l.name} className="flex items-center gap-2">
                          <div className="w-24 shrink-0 text-xs text-muted-foreground truncate">{l.name}</div>
                          <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} /></div>
                          <div className="w-10 text-right text-[11px] text-foreground">{pct}%</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Places visited</div>
                <div className="space-y-1">
                  {data.visits.map((v, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-border/50 last:border-0">
                      <span className="text-foreground truncate">{v.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{v.outcome ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="p-3 border-t border-border">
          <Button variant="secondary" className="w-full" onClick={onClose}>Close</Button>
        </div>
      </div>
    </ModalOverlay>
  )
}
