'use client'

import { useState, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  aggregateEmployeeByParameter,
  aggregateEmployeeByGroup,
  teamCoverageReport,
  parameterTrend,
  bandStrength,
  employeeSummary,
  MIN_TASKS_FOR_BAND,
} from '@/lib/analytics/performance'
import type { ContribRow, Param, Group, StrengthBand } from '@/lib/analytics/performance'
import type { RadarSeries, TrendPoint } from './_skillcharts'

// ── Lazy chart imports ────────────────────────────────────────────────────────
const ChartSkeleton = ({ h = 250 }: { h?: number }) => (
  <div className="w-full bg-secondary/30 rounded animate-pulse" style={{ height: h }} />
)
const GroupRadarChart = dynamic(
  () => import('./_skillcharts').then(m => m.GroupRadarChart),
  { ssr: false, loading: () => <ChartSkeleton h={250} /> },
)
const StrengthTrendChart = dynamic(
  () => import('./_skillcharts').then(m => m.StrengthTrendChart),
  { ssr: false, loading: () => <ChartSkeleton h={200} /> },
)

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ContribWithDate extends ContribRow {
  task_date: string
}

interface Employee {
  id: string
  cqid: string
  name?: string
  performance_rating: number
}

interface Props {
  employees:     Employee[]
  contributions: ContribWithDate[]
  parameters:    Param[]
  groups:        Group[]
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BAND_COLORS: Record<StrengthBand, { bg: string; text: string; dot: string }> = {
  Expert:       { bg: 'bg-emerald-500/20', text: 'text-emerald-300', dot: '#34d399' },
  Strong:       { bg: 'bg-blue-500/20',    text: 'text-blue-300',    dot: '#60a5fa' },
  Developing:   { bg: 'bg-amber-500/20',   text: 'text-amber-300',   dot: '#fbbf24' },
  Learning:     { bg: 'bg-red-500/15',     text: 'text-red-300',     dot: '#f87171' },
  Insufficient: { bg: 'bg-secondary/40',   text: 'text-muted-foreground', dot: '#4b5563' },
}

const EMP_PALETTE = [
  '#7c3aed', '#60a5fa', '#34d399', '#fbbf24',
  '#f87171', '#c084fc', '#fb923c', '#22d3ee',
]

const SUBTABS = ['heatmap', 'radar', 'coverage', 'trend'] as const
type Subtab = typeof SUBTABS[number]

const SUBTAB_LABELS: Record<Subtab, string> = {
  heatmap:  'Skill Heatmap',
  radar:    'Group Radar',
  coverage: 'Team Coverage',
  trend:    'Strength Trend',
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function SkillsTab({ employees, contributions, parameters, groups }: Props) {
  const { dn } = usePrivacy()
  const [subtab,        setSubtab]        = useState<Subtab>('heatmap')
  const [radarEmpIds,   setRadarEmpIds]   = useState<string[]>(employees.slice(0, 2).map(e => e.id))
  const [trendEmpId,    setTrendEmpId]    = useState<string>(employees[0]?.id || '')
  const [trendParamId,  setTrendParamId]  = useState<string>(parameters[0]?.id || '')
  const [hoveredCell,   setHoveredCell]   = useState<{ empId: string; paramId: string } | null>(null)

  const hasContribs = contributions.length > 0

  // ── Core aggregations (memoised — pure functions) ──────────────────────────
  const byParam = useMemo(
    () => aggregateEmployeeByParameter(contributions, parameters),
    [contributions, parameters],
  )
  const byGroup = useMemo(
    () => aggregateEmployeeByGroup(contributions, parameters, groups),
    [contributions, parameters, groups],
  )
  const coverage = useMemo(
    () => teamCoverageReport(byParam, parameters),
    [byParam, parameters],
  )

  // ── Parameter trend data ───────────────────────────────────────────────────
  const trendData = useMemo((): TrendPoint[] => {
    if (!trendEmpId || !trendParamId) return []
    const raw = parameterTrend(trendEmpId, trendParamId, contributions)
    return raw.map(({ month, score, taskCount }) => {
      const [y, m] = month.split('-')
      const label = new Date(Number(y), Number(m) - 1, 1)
        .toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
      return { month, label, score, taskCount }
    })
  }, [trendEmpId, trendParamId, contributions])

  // ── Radar series ───────────────────────────────────────────────────────────
  const radarSeries = useMemo((): RadarSeries[] => {
    return radarEmpIds.map((empId, i) => {
      const emp = employees.find(e => e.id === empId)
      const groupMap = byGroup[empId] ?? {}
      const data = groups.map(g => ({
        group: g.name,
        score: Math.round((groupMap[g.id]?.score ?? 0) * 100),
      }))
      return {
        employeeId: empId,
        label:      dn(emp ?? null),
        color:      EMP_PALETTE[i % EMP_PALETTE.length],
        data,
      }
    })
  }, [radarEmpIds, byGroup, groups, employees])

  // ── Groups ordered for heatmap header ─────────────────────────────────────
  const paramsByGroup = useMemo(() => {
    const sorted = [...groups].sort((a, b) => b.weight - a.weight)
    return sorted.map(g => ({
      group:  g,
      params: parameters.filter(p => p.group_id === g.id),
    })).filter(x => x.params.length > 0)
  }, [groups, parameters])

  const orderedParams = useMemo(
    () => paramsByGroup.flatMap(x => x.params),
    [paramsByGroup],
  )

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!hasContribs) {
    return (
      <div className="space-y-4">
        <SubtabBar active={subtab} onChange={setSubtab} />
        <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl px-5 py-4 flex items-start gap-3">
          <span className="text-xl mt-0.5">📈</span>
          <div>
            <p className="font-semibold text-sm text-amber-400 mb-1">No parameter-level data yet</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Skill analytics require per-parameter contribution breakdowns. Open a task in{' '}
              <a href="/dashboard/contributions" className="text-primary underline underline-offset-2">
                Contributions
              </a>
              , enter values for each parameter, then save. Analytics build up as you score more tasks.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <SubtabBar active={subtab} onChange={setSubtab} />

      {/* ═══════════════════════════════════════════════
          A — SKILL HEATMAP
      ═══════════════════════════════════════════════ */}
      {subtab === 'heatmap' && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h3 className="text-sm font-semibold">Skill Heatmap</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Employee strength per parameter. Each cell = mean share of work when present.
              Needs ≥{MIN_TASKS_FOR_BAND} tasks per parameter for a band rating.
            </p>
          </div>

          {/* Band legend */}
          <div className="flex flex-wrap gap-3 px-5 py-2.5 border-b border-border/40 bg-secondary/20">
            {(Object.entries(BAND_COLORS) as [StrengthBand, (typeof BAND_COLORS)[StrengthBand]][]).map(
              ([band, c]) => (
                <span key={band} className={`text-[10px] font-medium px-2 py-0.5 rounded ${c.bg} ${c.text}`}>
                  {band}
                </span>
              ),
            )}
          </div>

          <div className="overflow-auto">
            <table className="text-xs border-collapse min-w-full">
              <thead>
                {/* Group header row */}
                <tr className="bg-secondary/60">
                  <th className="sticky left-0 z-10 bg-secondary/60 px-4 py-2 text-left text-[10px] text-muted-foreground font-medium min-w-[120px]">
                    Employee
                  </th>
                  {paramsByGroup.map(({ group, params }) => (
                    <th
                      key={group.id}
                      colSpan={params.length}
                      className="px-2 py-2 text-[10px] font-semibold text-muted-foreground border-l border-border/30 text-center"
                    >
                      {group.name.replace(' Group', '')}
                      <span className="ml-1 text-muted-foreground/50 font-normal">{group.weight}%</span>
                    </th>
                  ))}
                </tr>
                {/* Parameter header row */}
                <tr className="border-b border-border">
                  <th className="sticky left-0 z-10 bg-card px-4 py-2" />
                  {orderedParams.map((p, i) => {
                    const isFirstInGroup = i === 0 || p.group_id !== orderedParams[i - 1].group_id
                    return (
                      <th
                        key={p.id}
                        className={`px-2 py-2 text-[10px] font-medium text-muted-foreground whitespace-nowrap
                          ${isFirstInGroup ? 'border-l border-border/30' : ''}`}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span>{p.name}</span>
                          {p.is_master && (
                            <span className="text-[8px] bg-purple-500/15 text-purple-400 border border-purple-500/20 px-1 rounded">
                              MASTER
                            </span>
                          )}
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {employees.map(emp => {
                  const summary = employeeSummary(emp.id, byParam, parameters)
                  return (
                    <tr key={emp.id} className="hover:bg-secondary/20 transition-colors">
                      {/* Employee label */}
                      <td className="sticky left-0 z-10 bg-card hover:bg-secondary/20 px-4 py-2.5 min-w-[120px]">
                        <div className="flex flex-col">
                          <span className="font-semibold text-xs">{dn(emp)}</span>
                          {summary.versatility.active > 0 && (
                            <span className="text-[9px] text-muted-foreground/60 mt-0.5">
                              {summary.versatility.active}/{summary.versatility.total} params
                            </span>
                          )}
                        </div>
                      </td>
                      {/* Cells */}
                      {orderedParams.map((p, i) => {
                        const ps    = byParam[emp.id]?.[p.id]
                        const band  = ps ? bandStrength(ps.score, ps.taskCount) : 'Insufficient'
                        const c     = BAND_COLORS[band]
                        const isHovered = hoveredCell?.empId === emp.id && hoveredCell?.paramId === p.id
                        const isFirstInGroup = i === 0 || p.group_id !== orderedParams[i - 1].group_id

                        return (
                          <td
                            key={p.id}
                            onMouseEnter={() => setHoveredCell({ empId: emp.id, paramId: p.id })}
                            onMouseLeave={() => setHoveredCell(null)}
                            className={`px-2 py-2.5 text-center relative cursor-default
                              ${isFirstInGroup ? 'border-l border-border/30' : ''}
                              ${isHovered ? 'ring-1 ring-inset ring-white/20' : ''}`}
                          >
                            <div className={`inline-flex items-center justify-center w-14 h-8 rounded ${c.bg} transition-all`}>
                              {band === 'Insufficient' ? (
                                <span className="text-[10px] text-muted-foreground/40">
                                  {ps ? `${ps.taskCount}t` : '—'}
                                </span>
                              ) : (
                                <span className={`text-[10px] font-semibold ${c.text}`}>
                                  {Math.round(ps!.score * 100)}%
                                </span>
                              )}
                            </div>
                            {/* Tooltip */}
                            {isHovered && ps && (
                              <div className="absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-2
                                bg-popover border border-border rounded-lg shadow-xl px-3 py-2 text-left
                                whitespace-nowrap pointer-events-none">
                                <p className="font-semibold text-[11px] mb-0.5">{p.name}</p>
                                <p className="text-[10px] text-muted-foreground">
                                  {emp.cqid} · {band}
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                  Score: {Math.round(ps.score * 100)}%
                                  &nbsp;·&nbsp;
                                  {ps.taskCount} task{ps.taskCount !== 1 ? 's' : ''}
                                </p>
                              </div>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Footer legend */}
          <div className="px-5 py-2 border-t border-border/40 text-[10px] text-muted-foreground flex gap-3 flex-wrap">
            <span>Score = mean share of total parameter value when present</span>
            <span className="text-muted-foreground/40">|</span>
            <span>Grey cell = fewer than {MIN_TASKS_FOR_BAND} qualifying tasks</span>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════
          B — GROUP RADAR CHARTS
      ═══════════════════════════════════════════════ */}
      {subtab === 'radar' && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h3 className="text-sm font-semibold">Group Radar</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Strength per contribution group for selected employees. Each axis = a group's
              weighted roll-up of its parameters.
            </p>
          </div>

          {/* Employee multi-select */}
          <div className="px-5 py-3 border-b border-border/40 flex flex-wrap gap-2">
            {employees.map((emp, i) => {
              const active = radarEmpIds.includes(emp.id)
              const color  = active ? EMP_PALETTE[radarEmpIds.indexOf(emp.id) % EMP_PALETTE.length] : undefined
              return (
                <button
                  key={emp.id}
                  onClick={() => {
                    if (active) {
                      setRadarEmpIds(prev => prev.filter(id => id !== emp.id))
                    } else if (radarEmpIds.length < 4) {
                      setRadarEmpIds(prev => [...prev, emp.id])
                    }
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-all
                    ${active
                      ? 'border-transparent text-white'
                      : 'border-border text-muted-foreground hover:text-foreground hover:border-border/60'
                    }`}
                  style={active ? { backgroundColor: color, borderColor: color } : undefined}
                >
                  {emp.cqid}
                </button>
              )
            })}
            <span className="text-[10px] text-muted-foreground self-center">
              (select up to 4)
            </span>
          </div>

          <div className="p-5">
            {radarEmpIds.length === 0 ? (
              <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">
                Select at least one employee above
              </div>
            ) : (
              <GroupRadarChart series={radarSeries} />
            )}
          </div>

          {/* Per-employee group breakdown table */}
          {radarEmpIds.length > 0 && (
            <div className="border-t border-border/40 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="px-4 py-2 text-left text-muted-foreground font-medium">Employee</th>
                    {groups.map(g => (
                      <th key={g.id} className="px-4 py-2 text-right text-muted-foreground font-medium">
                        {g.name.replace(' Group', '')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {radarEmpIds.map(empId => {
                    const emp     = employees.find(e => e.id === empId)
                    const groupMap = byGroup[empId] ?? {}
                    return (
                      <tr key={empId} className="hover:bg-secondary/20">
                        <td className="px-4 py-2 font-semibold">{dn(emp ?? null)}</td>
                        {groups.map(g => {
                          const gs = groupMap[g.id]
                          const band = gs ? bandStrength(gs.score, gs.taskCount) : 'Insufficient'
                          const c    = BAND_COLORS[band]
                          return (
                            <td key={g.id} className="px-4 py-2 text-right">
                              {gs ? (
                                <span className={`text-xs font-semibold ${c.text}`}>
                                  {Math.round(gs.score * 100)}%
                                </span>
                              ) : (
                                <span className="text-muted-foreground/30 text-xs">—</span>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════
          C — TEAM COVERAGE / BUS-FACTOR
      ═══════════════════════════════════════════════ */}
      {subtab === 'coverage' && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h3 className="text-sm font-semibold">Team Coverage</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Bus-factor risk per parameter — how many employees are at Strong+ proficiency.
              Red = only 0–1 strong employee (key-person risk).
            </p>
          </div>

          <div className="divide-y divide-border/40">
            {paramsByGroup.map(({ group, params }) => (
              <div key={group.id}>
                {/* Group header */}
                <div className="px-5 py-2 bg-secondary/30">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    {group.name} · {group.weight}%
                  </span>
                </div>
                {params.map(p => {
                  const cov = coverage.find(c => c.parameterId === p.id)
                  if (!cov) return null
                  const pct = cov.totalCount > 0
                    ? Math.round((cov.strongCount / employees.length) * 100)
                    : 0
                  const riskColors = {
                    high:   { bar: 'bg-red-500/70',   badge: 'bg-red-500/15 text-red-400 border-red-500/20' },
                    medium: { bar: 'bg-amber-500/70',  badge: 'bg-amber-500/15 text-amber-400 border-amber-500/20' },
                    low:    { bar: 'bg-emerald-500/70', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20' },
                  }
                  const rc = riskColors[cov.risk]
                  return (
                    <div key={p.id} className="px-5 py-3 flex items-center gap-4 hover:bg-secondary/20">
                      <div className="w-36 shrink-0">
                        <p className="text-xs font-medium truncate">{p.name}</p>
                        {p.is_master && (
                          <span className="text-[9px] text-purple-400">MASTER</span>
                        )}
                      </div>
                      {/* Bar */}
                      <div className="flex-1 h-3 bg-secondary/60 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${rc.bar}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {/* Counts */}
                      <div className="w-20 shrink-0 text-right">
                        <span className="text-xs text-muted-foreground">
                          {cov.strongCount}/{employees.length} strong
                        </span>
                      </div>
                      {/* Risk badge */}
                      <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border ${rc.badge}`}>
                        {cov.risk.toUpperCase()} RISK
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <div className="px-5 py-2.5 border-t border-border/40 text-[10px] text-muted-foreground">
            Strong+ = employees at Strong or Expert band (score ≥ 50%, ≥{MIN_TASKS_FOR_BAND} tasks).
            High risk = 0–1 strong employee.
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════
          D — STRENGTH TREND LINES
      ═══════════════════════════════════════════════ */}
      {subtab === 'trend' && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h3 className="text-sm font-semibold">Strength Trend</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Monthly share of work on a specific parameter. Rising line = employee doing
              proportionally more of that parameter over time.
            </p>
          </div>

          {/* Selectors */}
          <div className="px-5 py-3 border-b border-border/40 flex flex-wrap gap-3 items-center">
            <div className="flex flex-col gap-0.5">
              <label className="text-[10px] text-muted-foreground uppercase font-medium">Employee</label>
              <select
                value={trendEmpId}
                onChange={e => setTrendEmpId(e.target.value)}
                className="bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs
                  text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                {employees.map(emp => (
                  <option key={emp.id} value={emp.id}>{dn(emp)}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-0.5">
              <label className="text-[10px] text-muted-foreground uppercase font-medium">Parameter</label>
              <select
                value={trendParamId}
                onChange={e => setTrendParamId(e.target.value)}
                className="bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs
                  text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                {paramsByGroup.map(({ group, params }) => (
                  <optgroup key={group.id} label={group.name.replace(' Group', '')}>
                    {params.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.is_master ? ' ★' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {trendData.length > 0 && (
              <div className="ml-auto text-right">
                <p className="text-[10px] text-muted-foreground">Data points</p>
                <p className="text-xl font-bold gradient-text">{trendData.length}</p>
              </div>
            )}
          </div>

          <div className="p-5">
            <StrengthTrendChart
              data={trendData}
              color={EMP_PALETTE[employees.findIndex(e => e.id === trendEmpId) % EMP_PALETTE.length]}
            />
          </div>

          {/* Monthly breakdown table */}
          {trendData.length > 0 && (
            <div className="border-t border-border/40 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="px-4 py-2 text-left text-muted-foreground font-medium">Month</th>
                    <th className="px-4 py-2 text-right text-muted-foreground font-medium">Share</th>
                    <th className="px-4 py-2 text-right text-muted-foreground font-medium">Band</th>
                    <th className="px-4 py-2 text-right text-muted-foreground font-medium">Tasks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {[...trendData].reverse().map(pt => {
                    const band = bandStrength(pt.score, pt.taskCount)
                    const c    = BAND_COLORS[band]
                    return (
                      <tr key={pt.month} className="hover:bg-secondary/20">
                        <td className="px-4 py-2">{pt.label}</td>
                        <td className="px-4 py-2 text-right font-semibold tabular-nums">
                          {Math.round(pt.score * 100)}%
                        </td>
                        <td className="px-4 py-2 text-right">
                          <span className={`text-[10px] font-medium ${c.text}`}>{band}</span>
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                          {pt.taskCount}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Sub-tab bar ───────────────────────────────────────────────────────────────
function SubtabBar({ active, onChange }: { active: Subtab; onChange: (t: Subtab) => void }) {
  return (
    <div className="flex items-center gap-1 bg-secondary/40 rounded-xl p-1 w-fit flex-wrap">
      {SUBTABS.map(t => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            active === t
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {SUBTAB_LABELS[t]}
        </button>
      ))}
    </div>
  )
}
