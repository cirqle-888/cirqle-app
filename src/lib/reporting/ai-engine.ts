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
  TemplateConfig, ReportConfig, ReportProject,
} from './types'

interface AIContext {
  config: ReportConfig
  template: TemplateConfig
  kpi: KPIData
  benchmarks: BenchmarkSummary
  forecasts: ForecastBundle
  health: HealthSummary
  project: ReportProject
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

  const userPrompt = `Campaign: ${project.campaignName} (${project.platform}, ${project.campaignType ?? 'general'})
Period: ${config.dateFrom} to ${config.dateTo}

KEY METRICS:
- Spend: ₹${fmt(p.spend)} | Budget: ₹${fmt(project.adBudget)} (${fmt1(d.budgetUtilisation)}% utilised)
- Revenue: ₹${fmt(p.revenue)} | ROAS: ${fmt2(p.roas)} (benchmark: ${fmt2(benchmarks.metrics.roas)})
- Impressions: ${fmtN(p.impressions)} | Reach: ${fmtN(p.reach)} | Clicks: ${fmtN(p.clicks)}
- CTR: ${fmt2(p.ctr)}% (benchmark: ${fmt2(benchmarks.metrics.ctr)}%)
- CPC: ₹${fmt2(p.cpc)} (benchmark: ₹${fmt2(benchmarks.metrics.cpc)})
- Leads: ${fmtN(p.leads)} | CPL: ₹${fmt2(p.cpl)} (benchmark: ₹${fmt2(benchmarks.metrics.cpa)})
- Profit: ₹${fmt(d.profit)} | Margin: ${fmt1(d.margin)}% | ROI: ${fmt1(d.roi)}%

HEALTH: Score ${health.score}/100, Grade ${health.grade}, Risk: ${health.risk}
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

  const executiveSummary =
    `The ${project.campaignName} campaign ran on ${project.platform} from ` +
    `${config.dateFrom} to ${config.dateTo}, spending ₹${fmt(p.spend)} of ` +
    `the ₹${fmt(project.adBudget)} budget (${fmt1(d.budgetUtilisation)}% utilised). ` +
    `ROAS of ${fmt2(p.roas)} is ${Math.abs(Math.round(roasVsBm))}% ${roasDir} benchmark. ` +
    `Campaign health score: ${health.score}/100 (Grade ${health.grade}).`

  const keyInsights: string[] = [
    `Budget utilisation: ${fmt1(d.budgetUtilisation)}% — ${d.budgetUtilisation > 95 ? 'budget nearly exhausted' : d.budgetUtilisation < 50 ? 'underspending detected' : 'pacing is on track'}.`,
    `${fmtN(p.leads)} leads generated at ₹${fmt2(p.cpl)} cost-per-lead${benchmarks.metrics.cpa > 0 ? ` vs ₹${fmt2(benchmarks.metrics.cpa)} benchmark (${cplComparison(p.cpl, benchmarks.metrics.cpa)})` : ''}.`,
    `CTR of ${fmt2(p.ctr)}% is ${Math.abs(Math.round(ctrVsBm))}% ${ctrVsBm >= 0 ? 'above' : 'below'} benchmark (${fmt2(benchmarks.metrics.ctr)}%).`,
  ]

  const risks: string[] = [
    health.score < 60
      ? `Campaign health is ${health.risk} — ${health.result.explanations[0] ?? 'review urgently'}.`
      : `ROAS of ${fmt2(p.roas)} ${roasVsBm < 0 ? `is ${Math.abs(Math.round(roasVsBm))}% below benchmark — monitor closely` : 'is healthy'}.`,
    d.budgetUtilisation > 105
      ? 'Budget overspend detected — pause or reallocate spend.'
      : d.budgetUtilisation < 40
      ? 'Low budget utilisation — campaign may not reach delivery goals.'
      : `30-day spend forecast (₹${fmt(forecasts.spend30d.predicted_value)}) trend is ${forecasts.spend30d.trend}.`,
  ]

  const opportunities: string[] = [
    forecasts.roas30d.trend === 'up'
      ? 'Upward ROAS trend forecast — consider increasing budget for next period.'
      : 'Review creative and targeting to improve ROAS trajectory.',
    p.ctr < benchmarks.metrics.ctr
      ? `CTR is below benchmark — A/B test ad creatives to improve click-through.`
      : `Strong CTR (${fmt2(p.ctr)}%) — consider scaling reach with lookalike audiences.`,
  ]

  const recommendedActions: string[] = [
    d.budgetUtilisation < 80
      ? 'Review audience targeting to improve budget delivery pace.'
      : 'Maintain current spend pace — budget utilisation is optimal.',
    p.cpl > benchmarks.metrics.cpa && benchmarks.metrics.cpa > 0
      ? `Reduce CPL — test new creative angles to bring cost below ₹${fmt2(benchmarks.metrics.cpa)} benchmark.`
      : 'Leads cost-per-result is on track — focus on scaling volume.',
    health.score < 70
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
