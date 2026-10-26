/**
 * AI Narrative Engine
 *
 * Generates the structured AI narrative for a report. Uses OpenAI if
 * OPENAI_API_KEY is set; otherwise falls back to a rule-based narrative
 * so reports always complete without API dependencies.
 *
 * Output is stored in ad_reports.ai_narrative (JSONB).
 */

import type {
  AIReport, KPIData, BenchmarkSummary, ForecastBundle, HealthSummary,
  TemplateConfig, ReportConfig, ReportProject, CampaignBreakdownRow,
} from './types'
import { describeDataQuality, type DataQuality } from './data-quality'

interface AIContext {
  config: ReportConfig
  template: TemplateConfig
  kpi: KPIData
  benchmarks: BenchmarkSummary
  forecasts: ForecastBundle
  health: HealthSummary
  project: ReportProject
  dataQuality?: DataQuality
  campaigns?: CampaignBreakdownRow[]
}

/**
 * Builds the AI narrative. Attempts OpenAI first, falls back to rule-based.
 */
export async function buildAINarrative(ctx: AIContext): Promise<AIReport> {
  if (process.env.OPENAI_API_KEY) {
    try {
      return await buildOpenAINarrative(ctx)
    } catch (err) {
      console.warn('[AI Engine] OpenAI failed, using rule-based fallback:', err)
    }
  }
  return buildRuleBasedNarrative(ctx)
}

// ─── OpenAI narrative ─────────────────────────────────────────────────────────

async function buildOpenAINarrative(ctx: AIContext): Promise<AIReport> {
  const { kpi, benchmarks, health, forecasts, project, config } = ctx
  const p = kpi.primary
  const d = kpi.derived

  const systemPrompt = `You are a senior digital marketing analyst writing a concise, data-driven report narrative.
Respond ONLY with a valid JSON object matching this schema — no markdown, no explanation:
{
  "executiveSummary": "string (2-3 sentences)",
  "keyInsights": ["string", "string", "string"],
  "risks": ["string", "string"],
  "opportunities": ["string", "string"],
  "recommendedActions": ["string", "string", "string"],
  "budgetRecommendations": "string (1-2 sentences)"
}`

  const bmNote = (v: number, f: (v: number) => string) =>
    benchmarks.source !== 'global' && v > 0 ? ` (benchmark: ${f(v)})` : ''

  const userPrompt = `Campaign: ${project.campaignName} (${project.platform}, ${project.campaignType ?? 'general'})
Period: ${config.dateFrom} to ${config.dateTo}

KEY METRICS:
- Objective result: ${d.result ? `${d.result.label}${d.result.metric ? `: ${fmtN(d.results ?? 0)}` : ` — not available (${d.result.unavailableReason ?? 'not imported'})`}` : 'not set'}${d.costPerResult != null && d.result ? ` | ${d.result.costLabel}: ₹${fmt2(d.costPerResult)}` : ''}
- Spend: ₹${fmt(p.spend)} | Budget: ₹${fmt(project.adBudget)} (${fmt1(d.budgetUtilisation)}% of allocation used to date)
- ${p.revenue > 0 ? `Revenue: ₹${fmt(p.revenue)} | ROAS: ${fmt2(p.roas)}${bmNote(benchmarks.metrics.roas, fmt2)}` : 'Revenue/ROAS: NOT TRACKED for this campaign — do not judge it on sales or ROAS.'}
- Impressions: ${fmtN(p.impressions)} | ${kpi.periodReach?.available ? `Reach (unique people over the period): ${fmtN(kpi.periodReach.value)}` : `Reach: unique figure unavailable; sum of daily reach is ${fmtN(p.reach)} (counts repeat viewers — do not call it people reached)`} | Clicks (all): ${fmtN(p.clicks)}
${ctx.campaigns && ctx.campaigns.length > 1 ? `- Client report over ${ctx.campaigns.length} campaigns. Per campaign (judge each on its own objective; do not add different result types together):\n${ctx.campaigns.map(c => `  • ${c.campaignName}: ${c.resultLabel ? `${c.results ?? 'n/a'} ${c.resultLabel.toLowerCase()}${c.costPerResult != null ? ` at ₹${fmt2(c.costPerResult)} each` : ''}` : 'no result metric'}, spend ₹${fmt(c.spend)}`).join('\n')}\n` : ''}- Data coverage: ${describeDataQuality(ctx.dataQuality) ?? 'complete for the period.'}${d.resultCoverage && d.resultCoverage.recordedDays < d.resultCoverage.days ? ` ${d.result?.label ?? 'Results'} were recorded on only ${d.resultCoverage.recordedDays} of ${d.resultCoverage.days} days.` : ''}
- CTR: ${fmt2(p.ctr)}%${bmNote(benchmarks.metrics.ctr, v => `${fmt2(v)}%`)}
- CPC: ${p.clicks > 0 ? `₹${fmt2(p.cpc)}` : 'n/a'}${bmNote(benchmarks.metrics.cpc, v => `₹${fmt2(v)}`)}
${!d.result?.metric || d.result.metric === 'leads' ? `- Leads: ${fmtN(p.leads)} | CPL: ${p.leads > 0 ? `₹${fmt2(p.cpl)}` : 'n/a (no leads)'}${bmNote(benchmarks.metrics.cpa, v => `₹${fmt2(v)}`)}
` : `- This is a ${d.result.label.toLowerCase()} campaign: judge it on ${d.result.label.toLowerCase()} and ${d.result.costLabel.toLowerCase()}, not on leads.
`}${p.revenue > 0 ? `- Revenue minus ad spend (not business profit): ₹${fmt(d.profit)} | Margin: ${fmt1(d.margin)}% | ROI: ${fmt1(d.roi)}%\n` : ''}Benchmarks: ${benchmarks.source === 'global' ? 'none available (placeholders only) — do not compare against benchmarks.' : `source ${benchmarks.source}.`}

HEALTH: ${health.result.insufficientData ? 'NOT GRADED — not enough data; do not describe the campaign as healthy or unhealthy.' : `Score ${health.score}/100, Grade ${health.grade}, Risk: ${health.risk}`}
${health.result.explanations.slice(0, 3).join(' | ')}

30-DAY FORECAST:
- Spend forecast: ₹${fmt(forecasts.spend30d.predicted_value)} (trend: ${forecasts.spend30d.trend})
- ROAS forecast trend: ${forecasts.roas30d.trend} (confidence: ${forecasts.roas30d.confidence}%)

TEMPLATE FOCUS: ${ctx.template.displayName} — emphasise ${ctx.template.primaryKPI}`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    }),
  })

  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`)

  const json = await res.json()
  const parsed = JSON.parse(json.choices[0].message.content)

  return {
    ...parsed,
    generatedAt: new Date().toISOString(),
    model: json.model,
  }
}

// ─── Rule-based narrative fallback ───────────────────────────────────────────

function buildRuleBasedNarrative(ctx: AIContext): AIReport {
  const { kpi, benchmarks, health, forecasts, project, config } = ctx
  const p = kpi.primary
  const d = kpi.derived

  const roasVsBm = benchmarks.roasVsBenchmark
  const roasDir = roasVsBm >= 0 ? 'above' : 'below'
  const ctrVsBm  = benchmarks.ctrVsBenchmark
  // Benchmarks from the placeholder tier are never compared against.
  const hasBm = benchmarks.source !== 'global'

  // A client report covers several campaigns: say so, not "the … campaign".
  const multi = (ctx.campaigns?.length ?? 0) > 1
  const executiveSummary =
    (multi
      ? `Across ${ctx.campaigns!.length} ${project.clientName} campaigns on ${project.platform} from ` +
        `${config.dateFrom} to ${config.dateTo}, ad spend was ₹${fmt(p.spend)}`
      : `The ${project.campaignName} campaign ran on ${project.platform} from ` +
        `${config.dateFrom} to ${config.dateTo}, spending ₹${fmt(p.spend)} in this period`) +
    // The result it was run for, in its own terms (conversations, leads…).
    (!multi && d.result?.metric && d.results != null
      ? (d.results > 0
          ? ` and delivering ${fmtN(d.results)} ${d.result.label.toLowerCase()} at ₹${fmt2(d.costPerResult ?? 0)} each`
          : ` with no ${d.result.label.toLowerCase()} recorded`)
      : '') +
    // Utilisation is to-date (all spend through the period end ÷ allocation),
    // so it is stated separately from the period's own spend.
    (project.walletAllocation > 0
      ? `; ${fmt1(d.budgetUtilisation)}% of ${multi ? 'their combined' : "the campaign's"} allocation is used to date. `
      : '. ') +
    // ROAS is only meaningful when revenue is tracked; a lead or awareness
    // campaign with no sales tracking is not described by a ROAS of 0.
    (p.revenue > 0
      ? `ROAS of ${fmt2(p.roas)}${roasVsBm !== 0 ? ` is ${Math.abs(Math.round(roasVsBm))}% ${roasDir} benchmark` : ''}. `
      : '') +
    (health.result.insufficientData
      ? 'There is not yet enough data to grade campaign health.'
      : `Campaign health score: ${health.score}/100 (Grade ${health.grade}).`) +
    (describeDataQuality(ctx.dataQuality) ? ` ${describeDataQuality(ctx.dataQuality)}` : '')

  const keyInsights: string[] = [
    project.walletAllocation > 0
      ? `Allocation used to date: ${fmt1(d.budgetUtilisation)}%${d.budgetUtilisation > 95 ? ' — allocation nearly exhausted' : ''}.`
      : 'No wallet allocation is recorded for this campaign.',
    // Speak in the campaign's own result (conversations, purchases…), not leads.
    d.result?.metric && d.result.metric !== 'leads'
      ? (d.results != null && d.results > 0
          ? `${fmtN(d.results)} ${d.result.label.toLowerCase()} at ₹${fmt2(d.costPerResult ?? 0)} ${d.result.costLabel.toLowerCase()}.`
          : `${fmtN(p.clicks)} clicks from ${fmtN(p.impressions)} impressions; no ${d.result.label.toLowerCase()} recorded in this period.`)
      : p.leads > 0
      ? `${fmtN(p.leads)} leads generated at ₹${fmt2(p.cpl)} cost-per-lead${hasBm && benchmarks.metrics.cpa > 0 ? ` vs ₹${fmt2(benchmarks.metrics.cpa)} benchmark (${cplComparison(p.cpl, benchmarks.metrics.cpa)})` : ''}.`
      : `${fmtN(p.clicks)} clicks from ${fmtN(p.impressions)} impressions; no leads recorded in this period.`,
    hasBm && ctrVsBm !== 0
      ? `CTR of ${fmt2(p.ctr)}% is ${Math.abs(Math.round(ctrVsBm))}% ${ctrVsBm >= 0 ? 'above' : 'below'} benchmark (${fmt2(benchmarks.metrics.ctr)}%).`
      : `CTR of ${fmt2(p.ctr)}%.`,
  ]

  const risks: string[] = [
    !health.result.insufficientData && health.score < 60
      ? `Campaign health is ${health.risk} — ${health.result.explanations[0] ?? 'review urgently'}.`
      : p.revenue > 0
      ? `ROAS of ${fmt2(p.roas)} ${roasVsBm < 0 ? `is ${Math.abs(Math.round(roasVsBm))}% below benchmark — monitor closely` : 'is healthy'}.`
      : 'Sales are not tracked for this campaign, so results are judged on its objective rather than revenue.',
    d.budgetUtilisation > 105
      ? 'Budget overspend detected — pause or reallocate spend.'
      : d.budgetUtilisation < 40
      ? 'Low budget utilisation — campaign may not reach delivery goals.'
      : `30-day spend forecast (₹${fmt(forecasts.spend30d.predicted_value)}) trend is ${forecasts.spend30d.trend}.`,
  ]

  const opportunities: string[] = [
    p.revenue <= 0
      ? 'Review creative and targeting to improve results at the same spend.'
      : forecasts.roas30d.trend === 'up'
      ? 'Upward ROAS trend forecast — consider increasing budget for next period.'
      : 'Review creative and targeting to improve ROAS trajectory.',
    hasBm && p.ctr < benchmarks.metrics.ctr
      ? `CTR is below benchmark — A/B test ad creatives to improve click-through.`
      : `Strong CTR (${fmt2(p.ctr)}%) — consider scaling reach with lookalike audiences.`,
  ]

  const recommendedActions: string[] = [
    project.walletAllocation <= 0
      ? 'Record the campaign allocation so spend can be tracked against it.'
      : d.budgetUtilisation < 80
      ? 'Review audience targeting to improve budget delivery pace.'
      : 'Maintain current spend pace — budget utilisation is optimal.',
    (!d.result?.metric || d.result.metric === 'leads') && p.leads > 0 && hasBm && p.cpl > benchmarks.metrics.cpa && benchmarks.metrics.cpa > 0
      ? `Reduce CPL — test new creative angles to bring cost below ₹${fmt2(benchmarks.metrics.cpa)} benchmark.`
      : (d.results ?? 0) > 0
      ? `Cost per ${d.result?.metric === 'messages' ? 'conversation' : d.result?.metric === 'purchases' ? 'purchase' : 'result'} is the measure to watch — focus on scaling volume.`
      : 'Confirm tracking and the campaign objective before judging cost per result.',
    health.result.insufficientData
      ? 'Review again once there is more delivery data before changing the campaign.'
      : health.score < 70
      ? `Prioritise health score improvement: ${health.result.explanations[0] ?? 'review campaign settings'}.`
      : 'Campaign is performing well — consider expanding to additional ad sets.',
  ]

  const budgetRecommendations =
    d.remainingBudget > 0
      ? `₹${fmt(d.remainingBudget)} remaining budget. ` +
        (forecasts.spend30d.trend === 'up'
          ? 'Increase daily budget to capitalise on positive ROAS trend.'
          : 'Maintain current daily budget and monitor performance.')
      : 'Budget fully utilised. Review campaign results and plan next cycle budget accordingly.'

  return {
    executiveSummary,
    keyInsights,
    risks,
    opportunities,
    recommendedActions,
    budgetRecommendations,
    generatedAt: new Date().toISOString(),
    model: 'rule-based',
  }
}

// ─── Format helpers ───────────────────────────────────────────────────────────

const fmt   = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmt1  = (n: number) => n.toFixed(1)
const fmt2  = (n: number) => n.toFixed(2)
const fmtN  = (n: number) => Math.round(n).toLocaleString('en-IN')

function cplComparison(cpl: number, bm: number): string {
  if (bm === 0) return 'no benchmark'
  const pct = ((cpl - bm) / bm) * 100
  return pct > 0 ? `${Math.abs(Math.round(pct))}% above benchmark` : `${Math.abs(Math.round(pct))}% below benchmark`
}
