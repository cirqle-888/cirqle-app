'use client'

import { useState, useMemo, useEffect } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import Header from '@/components/layout/header'
import { usePrivacy } from '@/contexts/privacy-context'
import { calculatePerformanceScore, getQualityBand } from '@/lib/calculations/commission'
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from 'recharts'
import { cn, ROW_INTERACTIVE_CLASS, BRANDED_PILL_BASE_CLASS, BRANDED_PILL_SELECTED_CLASS, BRANDED_PILL_ACTIVE_CLASS } from '@/lib/utils'
import { DateFilter, matchesDateFilter, getDateFilterLabel } from '@/components/ui/date-filter'
import type { ContribWithDate } from './_skills/SkillsTab'
import type { Param, Group } from '@/lib/analytics/performance'

const SkillsTab = dynamic(() => import('./_skills/SkillsTab'), {
  ssr: false,
  loading: () => (
    <div className="space-y-4">
      {[1, 2].map(i => (
        <div key={i} className="h-48 rounded-xl bg-secondary/30 animate-pulse" />
      ))}
    </div>
  ),
})

// ─── Recharts is lazy-loaded — only fetched when a chart is rendered. ──────
// Saves ~95 KB on initial bundle and TTI for routes that never view a chart.
const ChartSkeleton = ({ h = 180 }: { h?: number }) => (
  <div className="w-full bg-secondary/30 rounded animate-pulse" style={{ height: h }} />
)
const MonthlyEarningsBar = dynamic(
  () => import('./_charts').then(m => m.MonthlyEarningsBar),
  { ssr: false, loading: () => <ChartSkeleton h={176} /> },
)
const ScoreTrendLine = dynamic(
  () => import('./_charts').then(m => m.ScoreTrendLine),
  { ssr: false, loading: () => <ChartSkeleton h={176} /> },
)
const TeamEarningsBar = dynamic(
  () => import('./_charts').then(m => m.TeamEarningsBar),
  { ssr: false, loading: () => <ChartSkeleton h={200} /> },
)
const TeamScoreBar = dynamic(
  () => import('./_charts').then(m => m.TeamScoreBar),
  { ssr: false, loading: () => <ChartSkeleton h={180} /> },
)
import type { DateFilterValue } from '@/components/ui/date-filter'
import { TrendingUp, TrendingDown, Award, Target, ChevronDown, ChevronUp, ExternalLink, Download, Printer } from 'lucide-react'

interface Employee { id: string; cqid: string; name?: string; performance_rating: number }
interface Score {
  id: string
  employee_id: string
  task_id: string
  score_percentage: number
  earnings_inr: number
  calculated_at: string
  task?: {
    id: string
    title: string
    task_date: string
    billing_amount_inr: number
    service_id: string
    quantity?: number
    client?: { id: string; name: string }
  }
}
interface Task {
  id: string; title: string; task_date: string; status: string
  billing_amount_inr: number; service_id: string
  quantity?: number
  client?: { id: string; name: string } | null
}

interface Props {
  employees:     Employee[]
  scores:        Score[]
  tasks:         Task[]
  contributions: ContribWithDate[]
  parameters:    Param[]
  groups:        Group[]
}

const BAND_COLORS: Record<string, string> = {
  '100':   '#34d399',
  '76-99': '#60a5fa',
  '51-75': '#a78bfa',
  '26-50': '#fbbf24',
  '0-25':  '#f87171',
}
const BAND_ORDER = ['100', '76-99', '51-75', '26-50', '0-25']
const EMP_COLORS = ['#7c3aed', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#c084fc']

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmt(n: number) {
  if (n >= 100000) return `₹${(n/100000).toFixed(2)}L`
  if (n >= 1000)   return `₹${(n/1000).toFixed(1)}K`
  return `₹${Math.round(n)}`
}

export default function ReportsClient({
  employees, scores, tasks, contributions, parameters, groups,
}: Props) {
  const { dn, isUnlocked } = usePrivacy()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [selectedEmp, setSelectedEmp] = useState<string>(searchParams.get('emp') || employees[0]?.id || '')
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(() => {
    const d = searchParams.get('date')
    try { return d ? JSON.parse(d) : null } catch { return null }
  })
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [taskSortKey, setTaskSortKey] = useState<'date' | 'earnings' | 'score'>((searchParams.get('sortKey') as any) || 'date')
  const [taskSortDir, setTaskSortDir] = useState<'desc' | 'asc'>((searchParams.get('sortDir') as any) || 'desc')
  const [activeTab, setActiveTab] = useState<'overview' | 'tasks' | 'monthly' | 'team' | 'clients' | 'skills'>((searchParams.get('tab') as any) || 'overview')
  const [showAllMonths, setShowAllMonths] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    
    if (selectedEmp && selectedEmp !== (employees[0]?.id || '')) params.set('emp', selectedEmp); else params.delete('emp')
    if (dateFilter) params.set('date', JSON.stringify(dateFilter)); else params.delete('date')
    if (taskSortKey && taskSortKey !== 'date') params.set('sortKey', taskSortKey); else params.delete('sortKey')
    if (taskSortDir && taskSortDir !== 'desc') params.set('sortDir', taskSortDir); else params.delete('sortDir')
    if (activeTab && activeTab !== 'overview') params.set('tab', activeTab); else params.delete('tab')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [selectedEmp, dateFilter, taskSortKey, taskSortDir, activeTab, pathname, router, searchParams, employees])
  const MONTHS_PREVIEW = 6

  const hasNoScores = scores.length === 0

  // ── Filter scores by date ──────────────────────────────────────────────────
  const filteredScores = useMemo(() => {
    if (!dateFilter) return scores
    return scores.filter(s => matchesDateFilter(s.task?.task_date, dateFilter))
  }, [scores, dateFilter])

  // ── Per-employee filtered scores ───────────────────────────────────────────
  const empScores = useMemo(
    () => filteredScores.filter(s => s.employee_id === selectedEmp),
    [filteredScores, selectedEmp]
  )

  // ── Summary stats ──────────────────────────────────────────────────────────
  // Creatives credited = Σ (task.quantity × score% / 100). Mirrors how earnings
  // are split. Inherits all group/parameter/tool weighting via the score_percentage
  // already calculated by commission.ts.
  const taskCount    = empScores.length
  const totalEarnings = empScores.reduce((s, e) => s + (e.earnings_inr || 0), 0)
  const avgScore      = taskCount ? empScores.reduce((s, e) => s + (e.score_percentage || 0), 0) / taskCount : 0
  const totalCreatives = empScores.reduce((acc, s) => {
    const qty   = Number(s.task?.quantity ?? 1)
    const share = (s.score_percentage ?? 0) / 100
    return acc + qty * share
  }, 0)
  const avgCreativesPerTask = taskCount > 0 ? totalCreatives / taskCount : 0

  // ── Production totals across all employees in the period ────────────────────
  // Independent of contribution scores — counts the canonical task list.
  const productionTotals = useMemo(() => {
    const src = dateFilter ? tasks.filter(t => matchesDateFilter(t.task_date, dateFilter)) : tasks
    let creatives = 0
    for (const t of src) creatives += Number(t.quantity ?? 1)
    return { tasks: src.length, creatives }
  }, [tasks, dateFilter])

  // ── Creatives per client (top 10 by output volume) ──────────────────────────
  const creativesByClient = useMemo(() => {
    const src = dateFilter ? tasks.filter(t => matchesDateFilter(t.task_date, dateFilter)) : tasks
    const map = new Map<string, { name: string; tasks: number; creatives: number }>()
    for (const t of src) {
      const cid = t.client?.id ?? '__unknown'
      const name = t.client?.name ?? 'Unknown'
      const row = map.get(cid) ?? { name, tasks: 0, creatives: 0 }
      row.tasks    += 1
      row.creatives += Number(t.quantity ?? 1)
      map.set(cid, row)
    }
    return [...map.values()].sort((a, b) => b.creatives - a.creatives).slice(0, 10)
  }, [tasks, dateFilter])

  // ── Quality band breakdown ─────────────────────────────────────────────────
  const bandBreakdown = useMemo(() => {
    const counts: Record<string, number> = { '100': 0, '76-99': 0, '51-75': 0, '26-50': 0, '0-25': 0 }
    const earn:   Record<string, number> = { '100': 0, '76-99': 0, '51-75': 0, '26-50': 0, '0-25': 0 }
    empScores.forEach(s => {
      const band = getQualityBand(s.score_percentage)
      counts[band]++
      earn[band] += s.earnings_inr || 0
    })
    return BAND_ORDER.map(band => ({ band, count: counts[band], earnings: earn[band] }))
  }, [empScores])

  // ── Band breakdown with company vs employee split ─────────────────────────
  const bandSplitData = useMemo(() => {
    const data: Record<string, { count: number; empEarnings: number; compEarnings: number }> = {
      '100':   { count: 0, empEarnings: 0, compEarnings: 0 },
      '76-99': { count: 0, empEarnings: 0, compEarnings: 0 },
      '51-75': { count: 0, empEarnings: 0, compEarnings: 0 },
      '26-50': { count: 0, empEarnings: 0, compEarnings: 0 },
      '0-25':  { count: 0, empEarnings: 0, compEarnings: 0 },
    }
    // Build task-level total employee earnings map
    const taskEmpEarnings: Record<string, number> = {}
    scores.forEach(s => {
      if (!s.task_id) return
      taskEmpEarnings[s.task_id] = (taskEmpEarnings[s.task_id] || 0) + (s.earnings_inr || 0)
    })
    empScores.forEach(s => {
      const band    = getQualityBand(s.score_percentage)
      const billing = s.task?.billing_amount_inr || 0
      const totalEmp = taskEmpEarnings[s.task_id] || 0
      const comp     = Math.max(0, billing - totalEmp)
      data[band].count++
      data[band].empEarnings  += s.earnings_inr || 0
      data[band].compEarnings += comp
    })
    return BAND_ORDER.map(band => ({ band, ...data[band] }))
  }, [empScores, scores])

  // ── Solo tasks (this employee is the only scorer) ──────────────────────────
  const soloTaskCount = useMemo(() => {
    const taskUnique: Record<string, Set<string>> = {}
    scores.forEach(s => {
      if (!s.task_id) return
      if (!taskUnique[s.task_id]) taskUnique[s.task_id] = new Set()
      taskUnique[s.task_id].add(s.employee_id)
    })
    return empScores.filter(s => s.task_id && taskUnique[s.task_id]?.size === 1 && taskUnique[s.task_id].has(selectedEmp)).length
  }, [empScores, scores, selectedEmp])

  // ── Client-wise breakdown (all employees, all filtered scores) ───────────
  const clientBreakdown = useMemo(() => {
    const clientMap: Record<string, {
      name: string; tasks: Set<string>; totalBilling: number
      empEarnings: number; compEarnings: number; soloTasks: number
    }> = {}
    // Build task-level totals
    const taskEmpTotal: Record<string, number> = {}
    filteredScores.forEach(s => { if (s.task_id) taskEmpTotal[s.task_id] = (taskEmpTotal[s.task_id] || 0) + (s.earnings_inr || 0) })
    const taskUnique: Record<string, Set<string>> = {}
    filteredScores.forEach(s => {
      if (!s.task_id) return
      if (!taskUnique[s.task_id]) taskUnique[s.task_id] = new Set()
      taskUnique[s.task_id].add(s.employee_id)
    })
    filteredScores.forEach(s => {
      const cid   = s.task?.client?.id || 'unknown'
      const cname = s.task?.client?.name || 'Unknown Client'
      if (!clientMap[cid]) clientMap[cid] = { name: cname, tasks: new Set(), totalBilling: 0, empEarnings: 0, compEarnings: 0, soloTasks: 0 }
      const entry = clientMap[cid]
      if (s.task_id && !entry.tasks.has(s.task_id)) {
        entry.tasks.add(s.task_id)
        const billing    = s.task?.billing_amount_inr || 0
        const totalEmp   = taskEmpTotal[s.task_id] || 0
        const comp       = Math.max(0, billing - totalEmp)
        entry.totalBilling += billing
        entry.compEarnings += comp
        if (taskUnique[s.task_id]?.size === 1) entry.soloTasks++
      }
      entry.empEarnings += s.earnings_inr || 0
    })
    return Object.values(clientMap).sort((a, b) => b.totalBilling - a.totalBilling)
  }, [filteredScores])

  // ── Monthly earnings chart ─────────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    const map: Record<string, { earnings: number; tasks: number; avgScore: number; scoreSum: number }> = {}
    empScores.forEach(s => {
      const key = (s.task?.task_date || '').slice(0, 7)
      if (!key) return
      if (!map[key]) map[key] = { earnings: 0, tasks: 0, avgScore: 0, scoreSum: 0 }
      map[key].earnings  += s.earnings_inr || 0
      map[key].tasks     += 1
      map[key].scoreSum  += s.score_percentage || 0
    })
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, d]) => ({
        month: month.slice(2).replace('-', '/'),
        fullMonth: month,
        earnings: Math.round(d.earnings),
        tasks: d.tasks,
        avgScore: Math.round(d.scoreSum / d.tasks),
      }))
  }, [empScores])

  // ── Score trend (last 20 tasks) ────────────────────────────────────────────
  const scoreTrend = useMemo(() => {
    return [...empScores]
      .filter(s => s.task?.task_date)
      .sort((a, b) => (a.task!.task_date > b.task!.task_date ? 1 : -1))
      .slice(-20)
      .map((s, i) => ({
        i: i + 1,
        score: Math.round(s.score_percentage || 0),
        date: s.task!.task_date.slice(5),
      }))
  }, [empScores])

  // ── Task list ──────────────────────────────────────────────────────────────
  const sortedTasks = useMemo(() => {
    const list = [...empScores].filter(s => s.task)
    list.sort((a, b) => {
      let va = 0, vb = 0
      if (taskSortKey === 'date')     { va = a.task!.task_date < b.task!.task_date ? -1 : 1; return taskSortDir === 'desc' ? -va : va }
      if (taskSortKey === 'earnings') { va = a.earnings_inr; vb = b.earnings_inr }
      if (taskSortKey === 'score')    { va = a.score_percentage; vb = b.score_percentage }
      return taskSortDir === 'desc' ? vb - va : va - vb
    })
    return list
  }, [empScores, taskSortKey, taskSortDir])

  function toggleSort(key: typeof taskSortKey) {
    if (taskSortKey === key) setTaskSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setTaskSortKey(key); setTaskSortDir('desc') }
  }

  // ── Month-wise team table ──────────────────────────────────────────────────
  type MonthRow = { month: string; label: string; total: number; [empId: string]: number | string }
  const monthWiseTable = useMemo((): MonthRow[] => {
    const months = new Set<string>()
    filteredScores.forEach(s => {
      const key = (s.task?.task_date || '').slice(0, 7)
      if (key) months.add(key)
    })
    const sortedMonths = [...months].sort((a, b) => b.localeCompare(a))

    return sortedMonths.map(month => {
      const row: MonthRow = { month, label: '', total: 0 }
      employees.forEach(emp => {
        const earn = filteredScores
          .filter(s => s.employee_id === emp.id && (s.task?.task_date || '').startsWith(month))
          .reduce((sum, s) => sum + (s.earnings_inr || 0), 0)
        row[emp.id] = earn
        row.total  += earn
      })
      const [y, m] = month.split('-')
      row.label = `${MONTH_NAMES[parseInt(m) - 1]} ${y}`
      return row
    })
  }, [filteredScores, employees])

  // ── Team comparison ────────────────────────────────────────────────────────
  const teamComparison = useMemo(() => {
    return employees.map((emp, i) => {
      const empS = filteredScores.filter(s => s.employee_id === emp.id)
      const avg   = empS.length ? empS.reduce((s, e) => s + e.score_percentage, 0) / empS.length : 0
      const total = empS.reduce((s, e) => s + e.earnings_inr, 0)
      return { name: emp.cqid, avgScore: Math.round(avg), totalEarnings: Math.round(total), tasks: empS.length, color: EMP_COLORS[i % EMP_COLORS.length] }
    })
  }, [employees, filteredScores])

  const perfResult = calculatePerformanceScore({
    avgScore, activeDays: taskCount, totalWorkingDays: 22,
    totalCreatives: taskCount, prevMonthCreatives: Math.max(taskCount - 2, 1),
  })

  const emp = employees.find(e => e.id === selectedEmp)

  // ── Totals row for monthly table ───────────────────────────────────────────
  const monthTotals = useMemo(() => {
    const row: Record<string, number> = { total: 0 }
    employees.forEach(emp => {
      row[emp.id] = monthWiseTable.reduce((s, r) => s + (r[emp.id] as number || 0), 0)
      row.total  += row[emp.id]
    })
    return row
  }, [monthWiseTable, employees])

  // ── CSV export helpers ─────────────────────────────────────────────────────
  function downloadCSV(rows: string[][], filename: string) {
    const csv = rows.map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function exportTasksCSV() {
    const empName = emp ? dn(emp) : 'employee'
    const rows: string[][] = [
      ['Date', 'Task', 'Client', 'Score %', 'Earnings (₹)', 'Quality Band'],
      ...sortedTasks.map(s => [
        s.task?.task_date || '',
        s.task?.title || '',
        s.task?.client?.name || '',
        String(Math.round(s.score_percentage || 0)),
        String(Math.round(s.earnings_inr || 0)),
        getQualityBand(s.score_percentage),
      ]),
    ]
    downloadCSV(rows, `${empName}_tasks_${new Date().toISOString().split('T')[0]}.csv`)
  }

  function exportMonthlyCSV() {
    const headerRow = ['Month', ...employees.map(e => dn(e)), 'Total (₹)']
    const dataRows = monthWiseTable.map(row => [
      row.label,
      ...employees.map(e => String(Math.round((row[e.id] as number) || 0))),
      String(Math.round(row.total || 0)),
    ])
    const totalRow = ['TOTAL', ...employees.map(e => String(Math.round(monthTotals[e.id] || 0))), String(Math.round(monthTotals.total || 0))]
    downloadCSV([headerRow, ...dataRows, totalRow], `month_wise_earnings_${new Date().toISOString().split('T')[0]}.csv`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div>
      <Header title="Reports & Performance" subtitle="Employee analytics & earnings breakdown" />

      <div className="p-6 space-y-5">

        {/* ── Top bar: date filter + employee pills ── */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {employees.map((e, i) => {
              const eCount = filteredScores.filter(s => s.employee_id === e.id).length
              const active = selectedEmp === e.id
              return (
                <button key={e.id} onClick={() => setSelectedEmp(e.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                    active ? 'gradient-bg text-white shadow-md' : 'bg-card border border-border text-muted-foreground hover:text-foreground hover:border-border/80'
                  }`}>
                  <span className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold ${active ? 'bg-foreground/20' : 'bg-secondary'}`}
                    style={active ? {} : { color: EMP_COLORS[i % EMP_COLORS.length] }}>
                    {e.cqid.replace('CQID', '')}
                  </span>
                  {dn(e)}
                  {eCount > 0 && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${active ? 'bg-foreground/25 text-white' : 'bg-primary/15 text-primary'}`}>
                      {eCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <DateFilter value={dateFilter} onChange={setDateFilter} />
            <div className="relative group">
              <button className="flex items-center gap-1.5 bg-card border border-border text-sm font-medium px-3 py-2 rounded-lg hover:border-border/80 transition-colors text-muted-foreground hover:text-foreground">
                <Download className="w-3.5 h-3.5" /> Export
              </button>
              <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-xl shadow-2xl shadow-black/40 py-1 min-w-[180px] hidden group-hover:block">
                <button onClick={exportTasksCSV}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-secondary transition-colors flex items-center gap-2">
                  <Download className="w-3.5 h-3.5 text-muted-foreground" />
                  Task list CSV
                </button>
                <button onClick={exportMonthlyCSV}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-secondary transition-colors flex items-center gap-2">
                  <Download className="w-3.5 h-3.5 text-muted-foreground" />
                  Month-wise CSV
                </button>
                <div className="border-t border-border my-1" />
                <button onClick={() => window.print()}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-secondary transition-colors flex items-center gap-2">
                  <Printer className="w-3.5 h-3.5 text-muted-foreground" />
                  Print / Save PDF
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── No scores banner ── */}
        {hasNoScores && (
          <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl px-5 py-4 flex items-start gap-3">
            <span className="text-xl mt-0.5">📊</span>
            <div>
              <p className="font-semibold text-sm text-amber-400 mb-1">No contribution scores saved yet</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                You have <strong className="text-foreground">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</strong> in the system but no scores saved.
                Go to <a href="/dashboard/contributions" className="text-primary underline underline-offset-2">Contributions</a>,
                open each task, enter the breakdown, then click <strong className="text-foreground">Save & Mark Done</strong>.
              </p>
            </div>
          </div>
        )}

        {emp && !hasNoScores && (
          <>
            {/* ── Tab bar ── */}
            <div className="flex items-center gap-1 bg-secondary/60 rounded-xl p-1 w-fit flex-wrap">
              {(['overview', 'tasks', 'monthly', 'team', 'clients', 'skills'] as const).map(t => (
                <button key={t} onClick={() => setActiveTab(t)}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                    activeTab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}>
                  {t === 'monthly' ? 'Month-wise'
                   : t === 'skills'  ? '✦ Skills'
                   : t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {/* ══════════════════════════════════════════
                TAB: OVERVIEW
            ══════════════════════════════════════════ */}
            {activeTab === 'overview' && (
              <div className="space-y-5">
                {/* Performance stats (employee-specific) */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { label: 'Tasks Scored',  value: taskCount, sub: dateFilter ? getDateFilterLabel(dateFilter) : 'All time' },
                    { label: 'Avg Score',     value: `${avgScore.toFixed(1)}%`, sub: `Perf. rating ${emp.performance_rating}%`, highlight: avgScore >= 75 ? 'green' : avgScore >= 50 ? 'yellow' : 'red' },
                    { label: 'Total Earnings',value: fmt(totalEarnings), sub: `₹${Math.round(totalEarnings).toLocaleString('en-IN')}` },
                    { label: 'Solo Tasks',    value: soloTaskCount, sub: '100% solo contribution', highlight: soloTaskCount > 0 ? 'purple' : undefined },
                  ].map(s => (
                    <div key={s.label} className="bg-card border border-border rounded-xl p-4">
                      <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                      <p className={`text-2xl font-bold mb-1 ${
                        s.highlight === 'green' ? 'text-green-400' :
                        s.highlight === 'yellow' ? 'text-yellow-400' :
                        s.highlight === 'red' ? 'text-red-400' :
                        s.highlight === 'purple' ? 'gradient-text' : ''
                      }`}>{s.value}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{s.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Production stats (creative output — distinct from financial) */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { label: 'My Creatives',       value: totalCreatives.toLocaleString('en-IN', { maximumFractionDigits: 1 }), sub: 'pages/posts credited (qty × share)', highlight: 'teal' as const },
                    { label: 'Avg Creatives/Task', value: avgCreativesPerTask.toLocaleString('en-IN', { maximumFractionDigits: 1 }), sub: 'production density per task' },
                    { label: 'Studio Tasks',       value: productionTotals.tasks.toLocaleString('en-IN'), sub: 'all tasks in period (whole studio)' },
                    { label: 'Studio Creatives',   value: productionTotals.creatives.toLocaleString('en-IN'), sub: 'total output (qty sum, whole studio)' },
                  ].map(s => (
                    <div key={s.label} className="bg-card border border-border rounded-xl p-4">
                      <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                      <p className={`text-2xl font-bold mb-1 ${s.highlight === 'teal' ? 'text-teal-400' : ''}`}>{s.value}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{s.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Creatives by Client (top 10 by output volume) */}
                {creativesByClient.length > 0 && (
                  <div className="bg-card border border-border rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold">Top Clients by Production Volume</h3>
                      <p className="text-[11px] text-muted-foreground">Output, not revenue — separate signal</p>
                    </div>
                    <div className="grid grid-cols-[1fr_80px_80px_80px] gap-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pb-2 border-b border-border/40">
                      <span>Client</span>
                      <span className="text-right">Tasks</span>
                      <span className="text-right">Creatives</span>
                      <span className="text-right">Per Task</span>
                    </div>
                    <div className="divide-y divide-border/40">
                      {creativesByClient.map((c, i) => (
                        <div key={c.name + i} className="grid grid-cols-[1fr_80px_80px_80px] gap-2 py-2 text-xs">
                          <span className="truncate">{c.name}</span>
                          <span className="text-right tabular-nums">{c.tasks}</span>
                          <span className="text-right tabular-nums text-teal-400 font-medium">{c.creatives}</span>
                          <span className="text-right tabular-nums text-muted-foreground">{(c.creatives / Math.max(1, c.tasks)).toFixed(1)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Quality band breakdown with company vs employee split */}
                <div className="bg-card border border-border rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold">Contribution Range Breakdown</h3>
                    <p className="text-[11px] text-muted-foreground">Employee vs Company earnings per band</p>
                  </div>
                  {taskCount === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-4">No scored tasks {dateFilter ? `for ${getDateFilterLabel(dateFilter)}` : ''}</p>
                  ) : (
                    <div className="space-y-3">
                      {/* Header */}
                      <div className="grid grid-cols-[80px_1fr_90px_90px_90px] gap-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pb-1 border-b border-border/40">
                        <span>Band</span>
                        <span>Tasks (progress)</span>
                        <span className="text-right">Tasks</span>
                        <span className="text-right text-green-400">Employee</span>
                        <span className="text-right text-blue-400">Company</span>
                      </div>
                      {bandSplitData.map(b => {
                        const pct = taskCount ? (b.count / taskCount) * 100 : 0
                        const totalBilling = b.empEarnings + b.compEarnings
                        const empPct = totalBilling > 0 ? (b.empEarnings / totalBilling) * 100 : 0
                        return (
                          <div key={b.band} className="grid grid-cols-[80px_1fr_90px_90px_90px] gap-2 items-center">
                            <span className="text-xs font-mono font-bold" style={{ color: BAND_COLORS[b.band] }}>{b.band}%</span>
                            <div className="flex flex-col gap-1">
                              {/* Overall tasks bar */}
                              <div className="bg-secondary rounded-full h-2 overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-500"
                                  style={{ width: `${pct}%`, backgroundColor: BAND_COLORS[b.band] }} />
                              </div>
                              {/* Split bar: emp vs company */}
                              {b.count > 0 && (
                                <div className="bg-secondary rounded-full h-1.5 overflow-hidden flex">
                                  <div className="h-full bg-green-500/70 transition-all" style={{ width: `${empPct}%` }} />
                                  <div className="h-full bg-blue-500/40 flex-1" />
                                </div>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground text-right">{b.count}</span>
                            <span className="text-xs font-semibold text-green-400 text-right">{b.count > 0 ? fmt(b.empEarnings) : '—'}</span>
                            <span className="text-xs font-semibold text-blue-400 text-right">{b.count > 0 ? fmt(b.compEarnings) : '—'}</span>
                          </div>
                        )
                      })}
                      {/* Total row */}
                      <div className="grid grid-cols-[80px_1fr_90px_90px_90px] gap-2 items-center pt-2 border-t border-border/40">
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase">Total</span>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/70" />Employee</span>
                          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500/40" />Company</span>
                        </div>
                        <span className="text-xs font-semibold text-right">{taskCount}</span>
                        <span className="text-xs font-bold text-green-400 text-right">{fmt(totalEarnings)}</span>
                        <span className="text-xs font-bold text-blue-400 text-right">
                          {fmt(bandSplitData.reduce((s, b) => s + b.compEarnings, 0))}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Charts row */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  {/* Monthly earnings */}
                  <div className="bg-card border border-border rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4">Monthly Earnings</h3>
                    {monthlyData.length === 0
                      ? <div className="h-44 flex items-center justify-center text-sm text-muted-foreground">No data</div>
                      : (
                        <MonthlyEarningsBar
                          data={monthlyData}
                          color={EMP_COLORS[employees.findIndex(e => e.id === selectedEmp) % EMP_COLORS.length]}
                        />
                      )}
                  </div>

                  {/* Score trend */}
                  <div className="bg-card border border-border rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4">Score Trend <span className="text-xs text-muted-foreground font-normal">(last 20 tasks)</span></h3>
                    {scoreTrend.length === 0
                      ? <div className="h-44 flex items-center justify-center text-sm text-muted-foreground">No data</div>
                      : (
                        <ScoreTrendLine data={scoreTrend} />
                      )}
                  </div>
                </div>

                {/* Performance suggestion */}
                <div className="bg-primary/10 border border-primary/20 rounded-xl px-5 py-4 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center shrink-0 mt-0.5">
                    <Target className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-primary mb-0.5">Performance Insight</p>
                    <p className="text-sm text-foreground">{perfResult.suggestion}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Performance rating: {emp.performance_rating}% · {taskCount} scored task{taskCount !== 1 ? 's' : ''}
                      {dateFilter ? ` · ${getDateFilterLabel(dateFilter)}` : ' · All time'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════
                TAB: TASKS
            ══════════════════════════════════════════ */}
            {activeTab === 'tasks' && (
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-sm font-semibold">
                    {emp.cqid} — Task List
                    <span className="ml-2 text-xs text-muted-foreground font-normal">
                      {sortedTasks.length} task{sortedTasks.length !== 1 ? 's' : ''}
                      {dateFilter ? ` · ${getDateFilterLabel(dateFilter)}` : ''}
                    </span>
                  </p>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Sort:
                    {(['date', 'earnings', 'score'] as const).map(k => (
                      <button key={k} onClick={() => toggleSort(k)}
                        className={`flex items-center gap-0.5 px-2 py-1 rounded-lg capitalize transition-colors ${
                          taskSortKey === k ? 'bg-primary/15 text-primary font-semibold' : 'hover:bg-secondary'
                        }`}>
                        {k}
                        {taskSortKey === k && (taskSortDir === 'desc' ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
                      </button>
                    ))}
                  </div>
                </div>

                {sortedTasks.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    No scored tasks{dateFilter ? ` for ${getDateFilterLabel(dateFilter)}` : ''}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {/* Header */}
                    <div className="grid grid-cols-[1fr_120px_80px_80px_80px] gap-2 px-5 py-2 bg-secondary/40 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <span>Task</span>
                      <span className="text-right">Billing</span>
                      <span className="text-right">Score</span>
                      <span className="text-right">Earnings</span>
                      <span className="text-right">Band</span>
                    </div>
                    {sortedTasks.map(s => {
                      const band = getQualityBand(s.score_percentage)
                      const isExpanded = expandedTask === s.id
                      return (
                        <div key={s.id}>
                          <button
                            onClick={() => setExpandedTask(isExpanded ? null : s.id)}
                            className="hover-gradient-row w-full grid grid-cols-[1fr_120px_80px_80px_80px] gap-2 px-5 py-3 text-left items-center">
                            <div className="min-w-0 flex flex-col items-start">
                              <p className="text-sm font-medium truncate w-full text-foreground">{s.task?.title || '—'}</p>
                              <p className="text-xs text-muted-foreground w-full truncate">
                                {s.task?.client?.name || '—'} · {s.task?.task_date || '—'}
                              </p>
                            </div>
                            <p className="text-sm text-right text-muted-foreground">
                              {s.task?.billing_amount_inr ? fmt(s.task.billing_amount_inr) : '—'}
                            </p>
                            <p className="text-sm text-right font-semibold" style={{ color: BAND_COLORS[band] }}>
                              {Math.round(s.score_percentage)}%
                            </p>
                            <p className="text-sm text-right font-bold text-foreground">
                              {fmt(s.earnings_inr)}
                            </p>
                            <div className="flex justify-end">
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                                style={{ backgroundColor: `${BAND_COLORS[band]}20`, color: BAND_COLORS[band] }}>
                                {band}
                              </span>
                            </div>
                          </button>
                          {isExpanded && (
                            <div className="px-5 py-3 bg-secondary/20 border-t border-border/50 grid grid-cols-3 gap-4 text-xs">
                              <div>
                                <p className="text-muted-foreground mb-0.5">Client</p>
                                <p className="font-medium">{s.task?.client?.name || '—'}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground mb-0.5">Date</p>
                                <p className="font-medium">{s.task?.task_date || '—'}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground mb-0.5">Billing × Commission</p>
                                <p className="font-medium">{s.task?.billing_amount_inr ? fmt(s.task.billing_amount_inr) : '—'} → {fmt(s.earnings_inr)}</p>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {/* Totals footer */}
                    <div className="grid grid-cols-[1fr_120px_80px_80px_80px] gap-2 px-5 py-3 bg-secondary/60 border-t-2 border-border text-sm font-bold">
                      <span className="text-muted-foreground text-xs uppercase tracking-wider">Total · {sortedTasks.length} tasks</span>
                      <span className="text-right text-muted-foreground">—</span>
                      <span className="text-right" style={{ color: BAND_COLORS[getQualityBand(avgScore)] }}>
                        {avgScore.toFixed(1)}%
                      </span>
                      <span className="text-right gradient-text">{fmt(totalEarnings)}</span>
                      <span />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════════════════════════════
                TAB: MONTH-WISE
            ══════════════════════════════════════════ */}
            {activeTab === 'monthly' && (
              <div className="space-y-5">
                {/* Month-wise earnings table (like Google Sheets) */}
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-border">
                    <h3 className="text-sm font-semibold">Month-wise Earnings</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">Earnings per employee per month</p>
                  </div>
                  {monthWiseTable.length === 0 ? (
                    <div className="py-10 text-center text-sm text-muted-foreground">No data for the selected period</div>
                  ) : (
                    <div className="overflow-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="bg-secondary/70 border-b border-border">
                            <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground sticky left-0 bg-secondary/70 min-w-[110px]">Month</th>
                            {employees.map((e, i) => (
                              <th key={e.id} className="px-4 py-3 text-right text-xs font-semibold min-w-[100px]"
                                style={{ color: EMP_COLORS[i % EMP_COLORS.length] }}>
                                {e.cqid}
                              </th>
                            ))}
                            <th className="px-4 py-3 text-right text-xs font-semibold text-foreground min-w-[100px]">Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {(showAllMonths ? monthWiseTable : monthWiseTable.slice(0, MONTHS_PREVIEW)).map(row => (
                            <tr key={row.month} className={cn(ROW_INTERACTIVE_CLASS)}>
                              <td className="px-4 py-3 font-medium sticky left-0 bg-card text-sm">{row.label}</td>
                              {employees.map(e => (
                                <td key={e.id} className={`px-4 py-3 text-right text-sm ${(row[e.id] as number) > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground/40'}`}>
                                  {(row[e.id] as number) > 0 ? fmt(row[e.id] as number) : '—'}
                                </td>
                              ))}
                              <td className="px-4 py-3 text-right font-bold text-sm">
                                {(row.total as number) > 0 ? fmt(row.total as number) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-secondary/50 border-t-2 border-border font-bold">
                            <td className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase sticky left-0 bg-secondary/50">Total</td>
                            {employees.map(e => (
                              <td key={e.id} className="px-4 py-3 text-right text-sm gradient-text">
                                {monthTotals[e.id] > 0 ? fmt(monthTotals[e.id]) : '—'}
                              </td>
                            ))}
                            <td className="px-4 py-3 text-right text-sm gradient-text">{fmt(monthTotals.total)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                  {/* Show more / less */}
                  {monthWiseTable.length > MONTHS_PREVIEW && (
                    <button
                      onClick={() => setShowAllMonths(v => !v)}
                      className="w-full py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground border-t border-border/40 transition-colors flex items-center justify-center gap-1.5">
                      {showAllMonths
                        ? <><ChevronUp className="w-3.5 h-3.5" /> Show less (last {MONTHS_PREVIEW} months)</>
                        : <><ChevronDown className="w-3.5 h-3.5" /> Show all {monthWiseTable.length} months</>}
                    </button>
                  )}
                </div>

                {/* Monthly bar chart for selected employee */}
                <div className="bg-card border border-border rounded-xl p-5">
                  <h3 className="text-sm font-semibold mb-1">{emp.cqid} — Monthly Earnings Chart</h3>
                  <p className="text-xs text-muted-foreground mb-4">Tasks and earnings per month</p>
                  {monthlyData.length === 0
                    ? <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">No data</div>
                    : (
                      <MonthlyEarningsBar data={monthlyData} color="#7c3aed" height={200} barSize={20} />
                    )}
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════
                TAB: TEAM
            ══════════════════════════════════════════ */}
            {activeTab === 'team' && (
              <div className="space-y-5">
                {/* Team comparison table */}
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-border">
                    <h3 className="text-sm font-semibold">Team Overview</h3>
                    {dateFilter && <p className="text-xs text-muted-foreground mt-0.5">{getDateFilterLabel(dateFilter)}</p>}
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-secondary/40">
                        <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Employee</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Tasks</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Avg Score</th>
                        <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Earnings</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {[...teamComparison].sort((a, b) => b.totalEarnings - a.totalEarnings).map((row, i) => (
                        <tr key={row.name} className="hover:bg-secondary/20 cursor-pointer"
                          onClick={() => { setSelectedEmp(employees.find(e => e.cqid === row.name)?.id || ''); setActiveTab('overview') }}>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold text-white"
                                style={{ backgroundColor: row.color }}>
                                {row.name.replace('CQID', '')}
                              </div>
                              <span className="font-semibold">{isUnlocked ? (employees.find(e => e.cqid === row.name)?.name || row.name) : row.name}</span>
                              {i === 0 && row.totalEarnings > 0 && (
                                <span className="text-[10px] bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 px-1.5 py-0.5 rounded font-semibold">TOP</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3.5 text-right text-muted-foreground">{row.tasks}</td>
                          <td className="px-4 py-3.5 text-right">
                            <span className="font-semibold" style={{ color: BAND_COLORS[getQualityBand(row.avgScore)] }}>
                              {row.avgScore}%
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-right font-bold">{row.totalEarnings > 0 ? fmt(row.totalEarnings) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-border bg-secondary/40">
                        <td className="px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Team Total</td>
                        <td className="px-4 py-3 text-right font-semibold">{teamComparison.reduce((s, r) => s + r.tasks, 0)}</td>
                        <td className="px-4 py-3 text-right font-semibold">
                          {teamComparison.length ? Math.round(teamComparison.reduce((s, r) => s + r.avgScore, 0) / teamComparison.filter(r => r.tasks > 0).length || 0) : 0}%
                        </td>
                        <td className="px-5 py-3 text-right font-bold gradient-text">
                          {fmt(teamComparison.reduce((s, r) => s + r.totalEarnings, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Team earnings bar chart */}
                <div className="bg-card border border-border rounded-xl p-5">
                  <h3 className="text-sm font-semibold mb-4">Earnings Comparison</h3>
                  <TeamEarningsBar data={teamComparison} />
                </div>

                {/* Score comparison */}
                <div className="bg-card border border-border rounded-xl p-5">
                  <h3 className="text-sm font-semibold mb-4">Avg Score Comparison</h3>
                  <TeamScoreBar data={teamComparison} bandColorFor={avg => BAND_COLORS[getQualityBand(avg)]} />
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════
                TAB: CLIENTS
            ══════════════════════════════════════════ */}
            {activeTab === 'clients' && (
              <div className="space-y-5">
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-border">
                    <h3 className="text-sm font-semibold">Client-wise Breakdown</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Revenue, employee vs company earnings, and solo tasks — all employees combined{dateFilter ? ` · ${getDateFilterLabel(dateFilter)}` : ''}
                    </p>
                  </div>
                  {clientBreakdown.length === 0 ? (
                    <div className="py-10 text-center text-sm text-muted-foreground">No data for the selected period</div>
                  ) : (
                    <div className="overflow-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="bg-secondary/60 border-b border-border">
                            <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground min-w-[160px]">Client</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Tasks</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Billing</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-green-500">Employee</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-blue-400">Company</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Split</th>
                            <th className="text-right px-5 py-3 text-xs font-medium text-purple-400">Solo Tasks</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {clientBreakdown.map((c, i) => {
                            const totalBillingKnown = c.empEarnings + c.compEarnings
                            const empPct = totalBillingKnown > 0 ? Math.round((c.empEarnings / totalBillingKnown) * 100) : 0
                            return (
                              <tr key={i} className="hover:bg-secondary/20">
                                <td className="px-5 py-3.5">
                                  <p className="font-semibold text-sm">{c.name}</p>
                                  <p className="text-[11px] text-muted-foreground">{c.tasks.size} task{c.tasks.size !== 1 ? 's' : ''}</p>
                                </td>
                                <td className="px-4 py-3.5 text-right text-muted-foreground">{c.tasks.size}</td>
                                <td className="px-4 py-3.5 text-right font-semibold">
                                  {c.totalBilling > 0 ? fmt(c.totalBilling) : '—'}
                                </td>
                                <td className="px-4 py-3.5 text-right text-green-400 font-semibold">
                                  {c.empEarnings > 0 ? fmt(c.empEarnings) : '—'}
                                </td>
                                <td className="px-4 py-3.5 text-right text-blue-400 font-semibold">
                                  {c.compEarnings > 0 ? fmt(c.compEarnings) : '—'}
                                </td>
                                <td className="px-4 py-3.5 text-right">
                                  <div className="flex items-center gap-1.5 justify-end">
                                    <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden flex">
                                      <div className="h-full bg-green-500/70" style={{ width: `${empPct}%` }} />
                                      <div className="h-full bg-blue-500/40 flex-1" />
                                    </div>
                                    <span className="text-[10px] text-muted-foreground">{empPct}%</span>
                                  </div>
                                </td>
                                <td className="px-5 py-3.5 text-right">
                                  {c.soloTasks > 0
                                    ? <span className="text-xs font-semibold text-purple-400">{c.soloTasks}</span>
                                    : <span className="text-xs text-muted-foreground/40">—</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-border bg-secondary/40 font-bold">
                            <td className="px-5 py-3 text-xs text-muted-foreground uppercase font-semibold">
                              {clientBreakdown.length} clients
                            </td>
                            <td className="px-4 py-3 text-right text-sm">
                              {clientBreakdown.reduce((s, c) => s + c.tasks.size, 0)}
                            </td>
                            <td className="px-4 py-3 text-right text-sm gradient-text">
                              {fmt(clientBreakdown.reduce((s, c) => s + c.totalBilling, 0))}
                            </td>
                            <td className="px-4 py-3 text-right text-sm text-green-400">
                              {fmt(clientBreakdown.reduce((s, c) => s + c.empEarnings, 0))}
                            </td>
                            <td className="px-4 py-3 text-right text-sm text-blue-400">
                              {fmt(clientBreakdown.reduce((s, c) => s + c.compEarnings, 0))}
                            </td>
                            <td />
                            <td className="px-5 py-3 text-right text-sm text-purple-400">
                              {clientBreakdown.reduce((s, c) => s + c.soloTasks, 0)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                  <div className="px-5 py-2.5 border-t border-border/40 flex gap-4 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-green-500/70" />Employee earnings (sum of commission across employees)</span>
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-blue-500/40" />Company earnings (billing − all employee costs)</span>
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-purple-400" />Solo = task done by one employee alone</span>
                  </div>
                </div>
              </div>
            )}
            {/* ══════════════════════════════════════════
                TAB: SKILLS & PERFORMANCE
            ══════════════════════════════════════════ */}
            {activeTab === 'skills' && (
              <SkillsTab
                employees={employees}
                contributions={contributions}
                parameters={parameters}
                groups={groups}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
