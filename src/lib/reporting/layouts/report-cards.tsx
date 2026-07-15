/**
 * "Cards" report layout (Satori / next-og JSX) — the branded page system used
 * by every template except Daily/Monthly (performance, executive, marketing,
 * lead_gen, ecommerce, agency). Same visual language as `daily-report.tsx`
 * (brand tokens, hero, header/footer, page chrome from `./shared`) but built
 * from content "cards" instead of a day-by-day table, since these templates
 * carry AI narrative, forecasts, benchmarks, and health scoring instead of
 * (or in addition to) a daily breakdown.
 *
 * Satori notes honoured throughout (see `./shared` for the full list) —
 * notably: no JSX fragments, every element with children sets `display: 'flex'`.
 */

import React from 'react'
import type { RenderData, TemplateConfig } from '../types'
import { computeDailyRows } from './daily-report'
import {
  PURPLE, PURPLE_D, INK, GREY_PILL, RED_PILL, GRADE_COLORS, SAFE_AREA,
  PageChrome, CirqleLogo, MetaLogo, MetaLine, KpiCircle, KpiDivider, Pill, TableRow,
  Card, SectionHeading, StatBlock, StatRow, BulletList, ProgressBar, ConfidentialWatermark,
  type IconName,
  capitalize, longDate, ddmmyyyy, num, money, truncate, computeCampaignMeta,
} from './shared'
import { measureElementHeight, type ReportFont } from './measure'
import { paginateByRealHeight } from './paginate'

export type CardKey =
  | 'executiveSummary' | 'kpiScorecard' | 'campaignHealth' | 'benchmarkComparison'
  | 'forecast' | 'aiInsights' | 'budgetAnalysis' | 'recommendations'

const CANONICAL_ORDER: CardKey[] = [
  'executiveSummary', 'kpiScorecard', 'campaignHealth', 'benchmarkComparison',
  'forecast', 'aiInsights', 'budgetAnalysis', 'recommendations',
]

// ─── Card accent / icon per key — colours drawn from the existing KPI-circle
// gradient family so every card visually belongs to the same palette Daily
// already established. ──────────────────────────────────────────────────────
const CARD_STYLE: Record<CardKey, { accent: string; icon: IconName }> = {
  executiveSummary:    { accent: PURPLE_D,   icon: 'doc' },
  kpiScorecard:        { accent: PURPLE,     icon: 'grid' },
  campaignHealth:       { accent: '#16A34A', icon: 'heart' }, // overridden dynamically per grade at render time
  benchmarkComparison: { accent: '#2563EB',  icon: 'target' },
  forecast:             { accent: '#FB923C', icon: 'trendUp' }, // overridden dynamically per trend
  aiInsights:           { accent: PURPLE,    icon: 'bulb' },
  budgetAnalysis:       { accent: RED_PILL,  icon: 'rupee' },
  recommendations:      { accent: '#22B8F2', icon: 'check' },
}

// ─── Mini table row (Benchmark / Forecast cards) — same visual language as
// the shared `TableRow`, but supports a custom column count and per-cell
// colour override (needed for the vs-benchmark / trend columns' conditional
// green/red colouring, which the fixed 7-column daily table doesn't need). ──
function MiniTableRow({
  s, cells, cellColors, header, zebra, last, flex,
}: { s: number; cells: string[]; cellColors?: (string | undefined)[]; header?: boolean; zebra?: boolean; last?: boolean; flex: number[] }) {
  const bg = header ? PURPLE : zebra ? '#F5F3FF' : '#FFFFFF'
  return (
    <div style={{
      display: 'flex', background: bg, color: header ? '#FFFFFF' : '#374151',
      fontSize: `${(header ? 17 : 18) * s}px`, fontWeight: header ? 700 : 500,
      padding: `${11 * s}px ${14 * s}px`, gap: `${16 * s}px`,
      borderLeft: header ? 'none' : `${1 * s}px solid #EDE9FE`,
      borderRight: header ? 'none' : `${1 * s}px solid #EDE9FE`,
      borderBottom: last ? `${1 * s}px solid #EDE9FE` : 'none',
      borderTopLeftRadius: header ? `${8 * s}px` : 0,
      borderTopRightRadius: header ? `${8 * s}px` : 0,
    }}>
      {cells.map((c, i) => (
        <div key={i} style={{
          display: 'flex',
          // Percentage flexBasis, not `flex: n` — see TableRow in shared.tsx:
          // a zero-basis cell + wordBreak hangs Satori's auto-height measure
          // pass (text wrapping at width 0 never terminates).
          flexGrow: flex[i],
          flexShrink: 1,
          flexBasis: `${(flex[i] / flex.reduce((a, b) => a + b, 0)) * 100}%`,
          minWidth: 0,
          justifyContent: i === 0 ? 'flex-start' : 'flex-end',
          fontWeight: header ? 700 : i === 0 ? 500 : 700,
          color: header ? '#FFFFFF' : (cellColors?.[i] ?? '#374151'),
          // See TableRow in shared.tsx — wordBreak on short fixed header
          // labels caused Yoga to mis-measure adjacent columns' flex-basis.
          wordBreak: header ? 'normal' : 'break-word',
        }}>
          {c}
        </div>
      ))}
    </div>
  )
}

// ─── 1. Executive Summary ─────────────────────────────────────────────────────

export function buildExecutiveSummaryCard(data: RenderData, s: number) {
  return (
    <Card s={s} accent={CARD_STYLE.executiveSummary.accent}>
      <SectionHeading s={s} icon={CARD_STYLE.executiveSummary.icon} label="Executive Summary" accent={CARD_STYLE.executiveSummary.accent} />
      <div style={{ display: 'flex', fontSize: `${22 * s}px`, lineHeight: 1.5, color: '#374151', wordBreak: 'break-word' }}>
        {/* Defensive ceiling against a runaway AI response, not normal sizing
            (real summaries are 300-600 chars). 1400 chars ≈ 730px at PDF
            width, which still fits a continuation page WHOLE even when
            extreme wrapped names shrink the page budget. */}
        {truncate(data.ai.executiveSummary, 1400)}
      </div>
    </Card>
  )
}

// ─── 2. KPI Scorecard ─────────────────────────────────────────────────────────

export function buildKpiScorecardCard(data: RenderData, s: number) {
  const p = data.kpi.primary
  const d = data.kpi.derived
  const deltas = data.kpi.deltas
  const stats = [
    { label: 'Total Spend', value: `₹${money(d.actualCost)}`, sub: `${d.budgetUtilisation.toFixed(1)}% of budget` },
    { label: 'Revenue',     value: `₹${money(p.revenue)}`,    sub: `ROAS ${p.roas.toFixed(2)}` },
    { label: 'Impressions', value: num(p.impressions),        sub: `Reach ${num(p.reach)}` },
    { label: 'Clicks',      value: num(p.clicks),             sub: `CTR ${p.ctr.toFixed(2)}%` },
    { label: 'Leads',       value: num(p.leads),              sub: `CPL ₹${p.cpl.toFixed(2)}` },
    { label: 'CPC',         value: `₹${p.cpc.toFixed(2)}`,    sub: `CPM ₹${p.cpm.toFixed(2)}` },
  ]
  const deltaRows: [string, number][] = deltas ? [
    ['Spend', deltas.spendDelta], ['Clicks', deltas.clicksDelta], ['Leads', deltas.leadsDelta],
    ['ROAS', deltas.roasDelta], ['CTR', deltas.ctrDelta], ['CPL', deltas.cplDelta],
  ] : []
  return (
    <Card s={s} accent={CARD_STYLE.kpiScorecard.accent}>
      <SectionHeading s={s} icon={CARD_STYLE.kpiScorecard.icon} label="Key Performance Indicators" accent={CARD_STYLE.kpiScorecard.accent} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${16 * s}px` }}>
        {stats.map(st => <StatBlock key={st.label} s={s} label={st.label} value={st.value} sub={st.sub} />)}
      </div>
      {deltaRows.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${10 * s}px`, marginTop: `${14 * s}px` }}>
          {deltaRows.map(([label, v]) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: `${4 * s}px`,
              background: v >= 0 ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
              color: v >= 0 ? '#16A34A' : '#DC2626',
              borderRadius: `${8 * s}px`, padding: `${6 * s}px ${10 * s}px`,
              fontSize: `${14 * s}px`, fontWeight: 600,
            }}>
              {label}: {v >= 0 ? '+' : ''}{v.toFixed(1)}%
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

// ─── 3. Campaign Health ───────────────────────────────────────────────────────

export function buildCampaignHealthCard(data: RenderData, s: number) {
  const h = data.health
  const grade = (h.grade in GRADE_COLORS ? h.grade : 'C') as keyof typeof GRADE_COLORS
  const accent = GRADE_COLORS[grade]
  const comps = h.result.components
  const compRows: [string, number][] = [
    ['Budget', comps.budgetScore], ['Performance', comps.performanceScore],
    ['Benchmark', comps.benchmarkScore], ['Forecast', comps.forecastScore],
  ]
  return (
    <Card s={s} accent={accent}>
      <SectionHeading s={s} icon={CARD_STYLE.campaignHealth.icon} label="Campaign Health" meta={`${h.risk} risk`} accent={accent} />
      <div style={{ display: 'flex', alignItems: 'center', gap: `${16 * s}px`, marginBottom: `${14 * s}px` }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: `${56 * s}px`, height: `${56 * s}px`, borderRadius: `${56 * s}px`,
          background: accent, color: '#FFFFFF', fontSize: `${28 * s}px`, fontWeight: 800,
        }}>
          {h.grade}
        </div>
        <div style={{ display: 'flex', fontSize: `${22 * s}px`, fontWeight: 700, color: INK }}>
          Score {h.score}/100
        </div>
      </div>
      <div style={{ display: 'flex', marginBottom: `${18 * s}px` }}>
        <ProgressBar s={s} pct={h.score} color={accent} />
      </div>
      <div style={{ display: 'flex', marginBottom: `${16 * s}px` }}>
        <BulletList s={s} items={h.result.explanations} bullet="•" color={accent} cap={4} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {compRows.map(([label, v]) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', marginBottom: `${8 * s}px` }}>
            <StatRow s={s} label={label} value={`${Math.round(v)}/100`} valueColor={INK} />
            <ProgressBar s={s} pct={v} color="#9CA3AF" height={6} />
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─── 4. Benchmark Comparison ──────────────────────────────────────────────────

// Green when at/above benchmark for "higher is better" metrics (ROAS, CTR,
// Conversion Rate); green when at/below benchmark for "lower is better" cost
// metrics (CPC, CPL) — an explicit inversion so a cheaper-than-benchmark cost
// still reads as good news.
function benchmarkColor(delta: number, lowerIsBetter: boolean): string {
  const good = lowerIsBetter ? delta <= 0 : delta >= 0
  return good ? '#16A34A' : '#DC2626'
}

export function buildBenchmarkComparisonCard(data: RenderData, s: number) {
  const { benchmarks, kpi } = data
  const p = kpi.primary
  const d = kpi.derived
  const flex = [1.6, 1.1, 1.1, 1.2]
  const rows: { metric: string; your: string; bench: string; delta: string; color?: string }[] = [
    { metric: 'ROAS', your: p.roas.toFixed(2), bench: benchmarks.metrics.roas.toFixed(2), delta: pctStr(benchmarks.roasVsBenchmark), color: benchmarkColor(benchmarks.roasVsBenchmark, false) },
    { metric: 'CTR (%)', your: p.ctr.toFixed(2), bench: benchmarks.metrics.ctr.toFixed(2), delta: pctStr(benchmarks.ctrVsBenchmark), color: benchmarkColor(benchmarks.ctrVsBenchmark, false) },
    { metric: 'CPC (₹)', your: p.cpc.toFixed(2), bench: benchmarks.metrics.cpc.toFixed(2), delta: pctStr(benchmarks.cpcVsBenchmark), color: benchmarkColor(benchmarks.cpcVsBenchmark, true) },
    { metric: 'CPL (₹)', your: p.cpl.toFixed(2), bench: benchmarks.metrics.cpa.toFixed(2), delta: pctStr(benchmarks.cplVsBenchmark), color: benchmarkColor(benchmarks.cplVsBenchmark, true) },
    { metric: 'Conv. Rate (%)', your: d.conversionRate.toFixed(1), bench: benchmarks.metrics.conversion_rate.toFixed(1), delta: '—' },
  ]
  return (
    <Card s={s} accent={CARD_STYLE.benchmarkComparison.accent}>
      <SectionHeading s={s} icon={CARD_STYLE.benchmarkComparison.icon} label="Benchmark Comparison" meta={`Source: ${capitalize(benchmarks.source)}`} accent={CARD_STYLE.benchmarkComparison.accent} />
      <MiniTableRow s={s} flex={flex} header cells={['Metric', 'Your Value', 'Benchmark', 'vs Benchmark']} />
      {rows.map((r, i) => (
        <MiniTableRow
          key={r.metric} s={s} flex={flex} zebra={i % 2 === 1} last={i === rows.length - 1}
          cells={[r.metric, r.your, r.bench, r.delta]}
          cellColors={[undefined, undefined, undefined, r.color]}
        />
      ))}
    </Card>
  )
}

function pctStr(v: number): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}%`
}

// ─── 5. Forecast ───────────────────────────────────────────────────────────────

const TREND_LABEL: Record<'up' | 'down' | 'flat', { text: string; color: string; icon: IconName }> = {
  up:   { text: '↑ Up',   color: '#16A34A', icon: 'trendUp' },
  down: { text: '↓ Down', color: '#DC2626', icon: 'trendDown' },
  flat: { text: '→ Flat', color: '#6B7280', icon: 'flat' },
}

export function buildForecastCard(data: RenderData, s: number) {
  const fc = data.forecasts
  const trendIcon = TREND_LABEL[fc.spend30d.trend].icon
  const flex = [1.1, 1.3, 1.3, 1.1, 1.0]
  const spendRows = [
    ['7 days', fc.spend7d], ['30 days', fc.spend30d], ['90 days', fc.spend90d],
  ] as const
  const leadsRows = [
    ['7 days', fc.leads7d], ['30 days', fc.leads30d],
  ] as const
  return (
    <Card s={s} accent={CARD_STYLE.forecast.accent}>
      <SectionHeading s={s} icon={trendIcon} label="Forecast" accent={CARD_STYLE.forecast.accent} />
      <div style={{ display: 'flex', marginBottom: `${16 * s}px` }}>
        <StatRow s={s} label="30-Day ROAS Forecast" value={`${fc.roas30d.predicted_value.toFixed(2)} (${TREND_LABEL[fc.roas30d.trend].text})`} valueColor={TREND_LABEL[fc.roas30d.trend].color} />
      </div>
      <div style={{ display: 'flex', fontSize: `${16 * s}px`, fontWeight: 700, color: '#6B7280', marginBottom: `${8 * s}px` }}>SPEND FORECAST</div>
      <MiniTableRow s={s} flex={flex} header cells={['Period', 'Predicted', 'Model', 'Confidence', 'Trend']} />
      {spendRows.map(([period, r], i) => (
        <MiniTableRow key={period} s={s} flex={flex} zebra={i % 2 === 1} last={i === spendRows.length - 1}
          cells={[period, `₹${money(r.predicted_value)}`, r.model_used, `${r.confidence}%`, TREND_LABEL[r.trend].text]}
          cellColors={[undefined, undefined, undefined, undefined, TREND_LABEL[r.trend].color]}
        />
      ))}
      <div style={{ display: 'flex', fontSize: `${16 * s}px`, fontWeight: 700, color: '#6B7280', marginTop: `${16 * s}px`, marginBottom: `${8 * s}px` }}>LEADS FORECAST</div>
      <MiniTableRow s={s} flex={flex} header cells={['Period', 'Predicted', 'Model', 'Confidence', 'Trend']} />
      {leadsRows.map(([period, r], i) => (
        <MiniTableRow key={period} s={s} flex={flex} zebra={i % 2 === 1} last={i === leadsRows.length - 1}
          cells={[period, r.predicted_value.toFixed(2), r.model_used, `${r.confidence}%`, TREND_LABEL[r.trend].text]}
          cellColors={[undefined, undefined, undefined, undefined, TREND_LABEL[r.trend].color]}
        />
      ))}
    </Card>
  )
}

// ─── 6. AI Insights ────────────────────────────────────────────────────────────

export function buildAiInsightsCard(data: RenderData, s: number) {
  const ai = data.ai
  const group = (label: string, items: string[], bullet: string, color: string, cap: number) => (
    <div key={label} style={{ display: 'flex', flexDirection: 'column', marginBottom: `${16 * s}px` }}>
      <div style={{ display: 'flex', fontSize: `${15 * s}px`, fontWeight: 700, color: '#9CA3AF', letterSpacing: `${1 * s}px`, textTransform: 'uppercase', marginBottom: `${8 * s}px` }}>
        {label}
      </div>
      <BulletList s={s} items={items} bullet={bullet} color={color} cap={cap} />
    </div>
  )
  return (
    <Card s={s} accent={CARD_STYLE.aiInsights.accent}>
      <SectionHeading s={s} icon={CARD_STYLE.aiInsights.icon} label="AI Insights" accent={CARD_STYLE.aiInsights.accent} />
      {group('Key Insights', ai.keyInsights, '•', '#374151', 4)}
      {group('Risks', ai.risks, '⚠', '#DC2626', 3)}
      {group('Opportunities', ai.opportunities, '↑', '#16A34A', 3)}
    </Card>
  )
}

// ─── 7. Budget Analysis ────────────────────────────────────────────────────────

export function buildBudgetAnalysisCard(data: RenderData, s: number) {
  const d = data.kpi.derived
  return (
    <Card s={s} accent={CARD_STYLE.budgetAnalysis.accent}>
      <SectionHeading s={s} icon={CARD_STYLE.budgetAnalysis.icon} label="Budget Analysis" accent={CARD_STYLE.budgetAnalysis.accent} />
      <div style={{ display: 'flex', gap: `${16 * s}px`, marginBottom: `${18 * s}px`, flexWrap: 'wrap' }}>
        <Pill s={s} bg={RED_PILL} label="Remaining Budget" value={`₹${money(d.remainingAllocation)}`} />
        <Pill s={s} bg={GREY_PILL} label="Budget Utilisation" value={`${d.budgetUtilisation.toFixed(1)}%`} />
      </div>
      <div style={{ display: 'flex', marginBottom: `${18 * s}px` }}>
        <ProgressBar s={s} pct={d.budgetUtilisation} color={PURPLE} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginBottom: `${16 * s}px` }}>
        <StatRow s={s} label="Avg Daily Spend" value={`₹${money(d.avgDailySpend)}`} />
        <StatRow s={s} label="Actual Cost (incl. GST)" value={`₹${money(d.actualCost)}`} />
        <StatRow s={s} label="GST Amount" value={`₹${money(d.gstAmount)}`} />
        <StatRow s={s} label="Remaining Allocation" value={`₹${money(d.remainingAllocation)}`} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', paddingTop: `${12 * s}px`, borderTop: `${1 * s}px solid #EDE9FE` }}>
        <div style={{ display: 'flex', fontSize: `${18 * s}px`, fontWeight: 700, color: PURPLE_D, marginBottom: `${4 * s}px` }}>
          AI Recommendation:
        </div>
        <div style={{ display: 'flex', fontSize: `${18 * s}px`, color: '#374151', lineHeight: 1.4, wordBreak: 'break-word' }}>
          {truncate(data.ai.budgetRecommendations, 300)}
        </div>
      </div>
    </Card>
  )
}

// ─── 8. Recommendations ────────────────────────────────────────────────────────

export function buildRecommendationsCard(data: RenderData, s: number) {
  const actions = data.ai.recommendedActions.slice(0, 5)
  return (
    <Card s={s} accent={CARD_STYLE.recommendations.accent}>
      <SectionHeading s={s} icon={CARD_STYLE.recommendations.icon} label="Recommended Actions" accent={CARD_STYLE.recommendations.accent} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${12 * s}px` }}>
        {actions.map((text, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: `${12 * s}px` }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              width: `${24 * s}px`, height: `${24 * s}px`, borderRadius: `${24 * s}px`,
              background: PURPLE, color: '#FFFFFF', fontSize: `${13 * s}px`, fontWeight: 700,
            }}>
              {i + 1}
            </div>
            <div style={{ display: 'flex', fontSize: `${20 * s}px`, color: '#374151', lineHeight: 1.4, wordBreak: 'break-word' }}>{truncate(text, 220)}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─── Card registry + hand-tuned page-height budgets ────────────────────────────

export const CARD_BUILDERS: Record<CardKey, (data: RenderData, s: number) => React.ReactElement> = {
  executiveSummary: buildExecutiveSummaryCard,
  kpiScorecard: buildKpiScorecardCard,
  campaignHealth: buildCampaignHealthCard,
  benchmarkComparison: buildBenchmarkComparisonCard,
  forecast: buildForecastCard,
  aiInsights: buildAiInsightsCard,
  budgetAnalysis: buildBudgetAnalysisCard,
  recommendations: buildRecommendationsCard,
}

/**
 * Real measured page-chrome height (safe-area padding + header + divider +
 * hero + footer, everything except the cards) for one continuation state.
 * The chrome contains variable user content — client/campaign names in the
 * hero, the agency name in the header/footer — which WRAPS when long, so
 * fixed estimates under-counted and let cards overflow into the footer.
 * Measured by rendering the actual page with no cards and no fixed height
 * (`probe`), so it is exact for this report's real names.
 */
async function measureCardsChromePx(
  data: RenderData,
  opts: { width: number; height: number; fonts: ReportFont[]; continuation: boolean },
): Promise<number> {
  const probe = buildCardsPage(data, {
    width: opts.width, height: opts.height, continuation: opts.continuation, cardKeys: [], probe: true,
  })
  return measureElementHeight(probe, { width: opts.width, fonts: opts.fonts })
}

/**
 * Bins the enabled cards (in canonical order) across pages using each card's
 * REAL measured height at the actual target canvas width — replaces the old
 * hand-tuned `CARD_HEIGHT_BUDGETS` guesses entirely. A card is never split
 * across pages — if it doesn't fit the remaining budget it moves whole to
 * the next page (`paginateByRealHeight` in `./paginate`).
 */
export async function paginateCardsForPDF(
  data: RenderData,
  opts: { width: number; height: number; fonts: ReportFont[] },
): Promise<{ continuation: boolean; keys: CardKey[] }[]> {
  const s = opts.width / 1080
  const safety = 10 * s
  const [chrome1, chromeC] = await Promise.all([
    measureCardsChromePx(data, { ...opts, continuation: false }),
    measureCardsChromePx(data, { ...opts, continuation: true }),
  ])
  const page1Budget = opts.height - chrome1 - safety
  const contBudget = opts.height - chromeC - safety

  const enabled = CANONICAL_ORDER.filter(k => data.template.sections[k])

  const pages = await paginateByRealHeight(enabled, {
    renderItem: key => CARD_BUILDERS[key](data, s),
    width: opts.width,
    firstPageBudget: page1Budget,
    continuationBudget: contBudget,
    fonts: opts.fonts,
  })
  return pages.map(p => ({ continuation: p.continuation, keys: p.items }))
}

// ─── Hero (title + campaign meta + KPI circles + pills), primaryKPI-aware ─────

const KPI_POOL_KEYS = ['reach', 'impressions', 'clicks', 'spend', 'cpr', 'revenue', 'leads'] as const
type KpiPoolKey = typeof KPI_POOL_KEYS[number]

const KPI_POOL: Record<KpiPoolKey, { label: string; value: (d: RenderData) => string; grad: [string, string]; icon: IconName }> = {
  reach:       { label: 'Reach',       value: d => num(d.kpi.primary.reach),              grad: ['#8B5CF6', '#6D28D9'], icon: 'users' },
  impressions: { label: 'Impressions', value: d => num(d.kpi.primary.impressions),        grad: ['#6366F1', '#4F46E5'], icon: 'eye' },
  clicks:      { label: 'Clicks',      value: d => num(d.kpi.primary.clicks),             grad: ['#22B8F2', '#2563EB'], icon: 'cursor' },
  spend:       { label: 'Spend',       value: d => `₹${money(d.kpi.derived.actualCost)}`, grad: ['#A855F7', '#7C3AED'], icon: 'rupee' },
  cpr:         { label: 'CPR',         value: d => `₹${money(d.kpi.derived.costPerResult)}`, grad: ['#FB923C', '#EF4444'], icon: 'percent' },
  revenue:     { label: 'Revenue',     value: d => `₹${money(d.kpi.primary.revenue)}`,    grad: ['#A855F7', '#7C3AED'], icon: 'rupee' },
  leads:       { label: 'Leads',       value: d => num(d.kpi.primary.leads),              grad: ['#8B5CF6', '#6D28D9'], icon: 'users' },
}

const PRIMARY_KPI_CIRCLE: Record<TemplateConfig['primaryKPI'], { label: string; value: (d: RenderData) => string; grad: [string, string]; icon: IconName }> = {
  roas:    { label: 'ROAS', value: d => d.kpi.primary.roas.toFixed(2), grad: ['#22B8F2', '#2563EB'], icon: 'trendUp' },
  leads:   KPI_POOL.leads,
  revenue: KPI_POOL.revenue,
  reach:   KPI_POOL.reach,
  spend:   KPI_POOL.spend,
}

export function buildHeroSection(data: RenderData, s: number, opts: { continuation: boolean }) {
  const { project, template } = data
  const meta = computeCampaignMeta(data)

  if (opts.continuation) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex', justifyContent: 'center', fontSize: `${44 * s}px`, fontWeight: 900,
          color: INK, letterSpacing: `${-1 * s}px`, marginBottom: `${22 * s}px`,
        }}>
          {template.displayName} — continued
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${16 * s}px` }}>
          <MetaLine s={s} pairs={[['Client', project.clientName], ['Campaign', project.campaignName], ['Period', meta.periodLabel]]} />
        </div>
      </div>
    )
  }

  const primary = PRIMARY_KPI_CIRCLE[template.primaryKPI]
  const fallbackKeys = KPI_POOL_KEYS.filter(k => k !== template.primaryKPI).slice(0, 4)

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', justifyContent: 'center', fontSize: `${64 * s}px`, fontWeight: 900,
        color: INK, letterSpacing: `${-1 * s}px`, marginBottom: `${22 * s}px`,
      }}>
        {template.displayName}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${6 * s}px`, marginBottom: `${30 * s}px` }}>
        <MetaLine s={s} pairs={[['Client', project.clientName], ['Campaign', project.campaignName]]} />
        <MetaLine s={s} pairs={[['Campaign Period', meta.periodLabel], ['Campaign Plan', `${meta.budgetPlanDays} Days`]]} />
        <MetaLine s={s} pairs={[['Daily Budget', `₹${money(meta.dailyBudget)}`], ['Expected Budget', `₹${num(meta.expectedBudget)}`]]} />
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', marginBottom: `${30 * s}px` }}>
        <KpiCircle s={s} label={primary.label} value={primary.value(data)} grad={primary.grad} icon={primary.icon} dia={104} />
        {fallbackKeys.flatMap(k => [
          <KpiDivider key={`div-${k}`} s={s} />,
          <KpiCircle key={k} s={s} label={KPI_POOL[k].label} value={KPI_POOL[k].value(data)} grad={KPI_POOL[k].grad} icon={KPI_POOL[k].icon} />,
        ])}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: `${20 * s}px`, marginBottom: `${36 * s}px`, flexWrap: 'wrap' }}>
        <Pill s={s} bg={RED_PILL} label="Total Remaining Amount" value={`₹${money(data.kpi.derived.remainingAllocation)}`} />
        <Pill s={s} bg={GREY_PILL} label="Remaining Days" value={`${meta.remainingDays} Days`} />
      </div>
    </div>
  )
}

// ─── Header / footer (identical visual language to daily-report.tsx) ──────────

function HeaderRow({ s, data }: { s: number; data: RenderData }) {
  const { brand, project } = data
  const platform = (project.platform || 'meta').toLowerCase()
  const isMeta = ['meta', 'facebook', 'instagram'].includes(platform)
  const platformLabel = capitalize(project.platform || 'Meta')
  const reportDate = longDate(data.config.dateTo)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: `${10 * s}px` }}>
      <div style={{ display: 'flex', flexShrink: 0 }}><CirqleLogo s={s} brand={brand} /></div>
      <div style={{ display: 'flex', fontSize: `${30 * s}px`, fontWeight: 700, color: INK, flexShrink: 0 }}>{reportDate}</div>
      {isMeta ? <MetaLogo s={s} /> : (
        <div style={{ display: 'flex', fontSize: `${34 * s}px`, fontWeight: 800, color: PURPLE_D, flexShrink: 0, wordBreak: 'break-word', maxWidth: `${300 * s}px` }}>
          {truncate(platformLabel, 24)}
        </div>
      )}
    </div>
  )
}

function FooterRow({ s, data }: { s: number; data: RenderData }) {
  const { brand } = data
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end',
      marginTop: `${20 * s}px`, paddingTop: `${20 * s}px`, borderTop: `${2 * s}px solid #E5E7EB`,
      fontSize: `${20 * s}px`, color: '#6B7280',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: `${400 * s}px` }}>
        <div style={{ display: 'flex', fontWeight: 800, color: PURPLE, fontSize: `${24 * s}px`, wordBreak: 'break-word' }}>
          {truncate(brand.agencyName, 40)}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: `${400 * s}px` }}>
        {brand.contactPhone && <div style={{ display: 'flex', wordBreak: 'break-word' }}>{brand.contactPhone}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: `${4 * s}px` }}>
          <span style={{ display: 'flex', wordBreak: 'break-word' }}>
            {(brand.contactWebsite ?? 'www.cirqle.work').replace(/^https?:\/\//, '')}
          </span>
          {brand.contactEmail ? <span style={{ display: 'flex', wordBreak: 'break-word' }}>{`  |  ${brand.contactEmail}`}</span> : null}
        </div>
      </div>
    </div>
  )
}

/** Compact performance-table block (heading + header row + up to `maxRows`
 * data rows) — reused inside the single-canvas image export when
 * `dailyBreakdown` is enabled, same table styling as Daily's own table. */
function buildTableSnippet(data: RenderData, s: number, opts: { maxRows: number }) {
  const rows = computeDailyRows(data).slice(-opts.maxRows).reverse()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginBottom: `${24 * s}px` }}>
      <div style={{
        display: 'flex', fontSize: `${26 * s}px`, fontWeight: 800, color: INK,
        borderBottom: `${3 * s}px solid ${PURPLE}`, paddingBottom: `${6 * s}px`, marginBottom: `${12 * s}px`,
      }}>
        Last {rows.length} Days Performance
      </div>
      <TableRow s={s} cells={['Date', 'Meta Spend', 'GST', 'Reach', 'Impressions', 'CPR', 'Remaining Amount']} header />
      {rows.map((r, i) => (
        <TableRow
          key={r.date} s={s} zebra={i % 2 === 1} last={i === rows.length - 1}
          cells={[ddmmyyyy(r.date), `₹${money(r.spend)}`, `₹${money(r.gstAmount)}`, num(r.reach), num(r.impressions), `₹${money(r.cpr)}`, `₹${money(r.balance)}`]}
        />
      ))}
    </div>
  )
}

// ─── Page assembly ──────────────────────────────────────────────────────────

/** One full PDF page: chrome + header + hero/compact-meta + the requested cards + footer + watermark.
 * `probe` renders the identical chrome without the fixed page height,
 * decorative background, or watermark — measured with `cardKeys: []` to get
 * the real chrome height for budget math (see `measureCardsChromePx`). */
export function buildCardsPage(data: RenderData, opts: { width: number; height: number; continuation: boolean; cardKeys: CardKey[]; probe?: boolean }) {
  const { width, height, continuation, cardKeys, probe = false } = opts
  const s = width / 1080
  const { brand } = data
  return (
    <div style={{
      position: 'relative', display: 'flex', flexDirection: 'column',
      width: `${width}px`, ...(probe ? {} : { height: `${height}px` }), background: '#FFFFFF',
      fontFamily: 'sans-serif', color: INK, boxSizing: 'border-box', overflow: 'hidden',
    }}>
      {probe ? null : <PageChrome s={s} width={width} height={height} brand={brand} />}
      <div style={{
        position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1,
        padding: `${SAFE_AREA.top * s}px ${SAFE_AREA.right * s}px ${SAFE_AREA.bottom * s}px ${SAFE_AREA.left * s}px`,
        boxSizing: 'border-box',
      }}>
        <HeaderRow s={s} data={data} />
        <div style={{ display: 'flex', height: `${2 * s}px`, background: '#E5E7EB', marginBottom: `${28 * s}px` }} />
        {buildHeroSection(data, s, { continuation })}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          {cardKeys.map(key => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column' }}>
              {CARD_BUILDERS[key](data, s)}
            </div>
          ))}
        </div>
        <FooterRow s={s} data={data} />
      </div>
      {brand.confidentialWatermark && !probe ? <ConfidentialWatermark width={width} height={height} /> : null}
    </div>
  )
}

/**
 * Single-canvas entry point for the image exporter — a "page 1 equivalent"
 * only, matching Daily's own `maxRows` truncation philosophy for image
 * exports. `dailyBreakdown` (if enabled) is promoted ahead of most cards,
 * since Daily's own image export always prioritises showing a table; cards
 * are filled in priority order until the canvas's height budget runs out —
 * anything that doesn't fit here is still available in the PDF.
 */
export async function buildCardsReportElement(
  data: RenderData,
  opts: { width: number; height: number; fonts: ReportFont[] },
): Promise<React.ReactElement> {
  const { width, height, fonts } = opts
  const s = width / 1080
  const { brand, template } = data
  const sections = template.sections

  type Slot = { key: CardKey | 'dailyBreakdown'; render: () => React.ReactElement }
  const allSlots: Slot[] = [
    { key: 'executiveSummary', render: () => CARD_BUILDERS.executiveSummary(data, s) },
    { key: 'kpiScorecard', render: () => CARD_BUILDERS.kpiScorecard(data, s) },
    { key: 'campaignHealth', render: () => CARD_BUILDERS.campaignHealth(data, s) },
    { key: 'dailyBreakdown', render: () => buildTableSnippet(data, s, { maxRows: 5 }) },
    { key: 'benchmarkComparison', render: () => CARD_BUILDERS.benchmarkComparison(data, s) },
    { key: 'forecast', render: () => CARD_BUILDERS.forecast(data, s) },
    { key: 'aiInsights', render: () => CARD_BUILDERS.aiInsights(data, s) },
    { key: 'budgetAnalysis', render: () => CARD_BUILDERS.budgetAnalysis(data, s) },
    { key: 'recommendations', render: () => CARD_BUILDERS.recommendations(data, s) },
  ]
  const candidates = allSlots.filter(c => sections[c.key])

  // Real per-candidate height, measured in parallel at the actual target
  // width — replaces the old CARD_HEIGHT_BUDGETS/TABLE_SNIPPET_ESTIMATE
  // guesses. This is the single-canvas image path (no second page to
  // overflow onto), so it keeps "priority-fill until budget runs out, drop
  // the rest" semantics rather than switching to multi-page pagination —
  // anything dropped here is still available in the paginated PDF.
  // The chrome (header + hero + footer) is measured for real too — its
  // client/campaign/agency names wrap when long, so a fixed estimate would
  // let the last chosen card overflow into the footer.
  const [chromePx, ...heights] = await Promise.all([
    measureCardsChromePx(data, { width, height, fonts, continuation: false }),
    ...candidates.map(c => measureElementHeight(c.render(), { width, fonts })),
  ])

  let budget = height - chromePx - 10 * s

  const chosen: Slot[] = []
  candidates.forEach((c, i) => {
    if (heights[i] <= budget) { chosen.push(c); budget -= heights[i] }
  })

  return (
    <div style={{
      position: 'relative', display: 'flex', flexDirection: 'column',
      width: `${width}px`, height: `${height}px`, background: '#FFFFFF',
      fontFamily: 'sans-serif', color: INK, boxSizing: 'border-box', overflow: 'hidden',
    }}>
      <PageChrome s={s} width={width} height={height} brand={brand} />
      <div style={{
        position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1,
        padding: `${SAFE_AREA.top * s}px ${SAFE_AREA.right * s}px ${SAFE_AREA.bottom * s}px ${SAFE_AREA.left * s}px`,
        boxSizing: 'border-box',
      }}>
        <HeaderRow s={s} data={data} />
        <div style={{ display: 'flex', height: `${2 * s}px`, background: '#E5E7EB', marginBottom: `${28 * s}px` }} />
        {buildHeroSection(data, s, { continuation: false })}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          {chosen.map(c => (
            <div key={c.key} style={{ display: 'flex', flexDirection: 'column' }}>
              {c.render()}
            </div>
          ))}
        </div>
        <FooterRow s={s} data={data} />
      </div>
      {brand.confidentialWatermark ? <ConfidentialWatermark width={width} height={height} /> : null}
    </div>
  )
}
