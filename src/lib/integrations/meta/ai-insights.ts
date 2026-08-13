/**
 * AI performance insights (Groq, reusing src/lib/ai/groq). The AI receives ONLY
 * facts computed from the database — it never invents numbers. Output cleanly
 * separates FACTS (the rollup we pass in) from AI INTERPRETATION (this narrative).
 *
 * Cached in meta_insight_cache keyed by a hash of the facts so repeated dashboard
 * loads and report generations don't re-hit the LLM.
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callGroqJSON } from '@/lib/ai/groq'

export interface MetaNarrative {
  summary: string
  wins: string[]
  weak: string[]
  contentInsight: string
  leadInsight: string
  recommendations: string[]
  /** true when this is a deterministic fallback (AI unavailable). */
  ruleBased?: boolean
}

function hashFacts(facts: unknown): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32)
}

const SYSTEM_PROMPT = `You are a social media & paid-ads analyst for a marketing agency.
You will be given a JSON object of VERIFIED metrics already computed from the database.
Write concise, specific, professional insights. Rules:
- Use ONLY numbers present in the facts. NEVER invent or estimate a metric.
- Reference real percentages/values from the facts (e.g. "reach rose 38%").
- Be honest about declines. If data is sparse, say so briefly.
- Currency is INR (₹).
Return ONLY a JSON object with these keys (no prose outside JSON):
{
 "summary": "2-3 sentence overview of what happened",
 "wins": ["short bullet", "..."],
 "weak": ["short bullet about declines/underperformers", "..."],
 "contentInsight": "1-2 sentences on which content type performed best",
 "leadInsight": "1-2 sentences on lead volume / cost / best campaign",
 "recommendations": ["actionable next step", "..."]
}`

/** Deterministic narrative used when GROQ_API_KEY is unset or the call fails. */
export function ruleBasedNarrative(facts: any): MetaNarrative {
  const r = facts?.rollup ?? {}
  const reachTxt = r.reachDeltaPct != null ? `Reach ${r.reachDeltaPct >= 0 ? 'rose' : 'fell'} ${Math.abs(r.reachDeltaPct)}% to ${fmt(r.reach)}.` : `Reach was ${fmt(r.reach)}.`
  const leadTxt = r.leadsDeltaPct != null ? `Leads ${r.leadsDeltaPct >= 0 ? 'up' : 'down'} ${Math.abs(r.leadsDeltaPct)}% (${r.leads}).` : `${r.leads ?? 0} leads captured.`
  const wins: string[] = []
  const weak: string[] = []
  if (r.reachDeltaPct != null && r.reachDeltaPct > 0) wins.push(`Reach grew ${r.reachDeltaPct}%.`)
  if (r.leadsDeltaPct != null && r.leadsDeltaPct > 0) wins.push(`Lead volume grew ${r.leadsDeltaPct}%.`)
  if (r.roas != null && r.roas >= 1) wins.push(`ROAS at ${r.roas}×.`)
  if (r.reachDeltaPct != null && r.reachDeltaPct < 0) weak.push(`Reach declined ${Math.abs(r.reachDeltaPct)}%.`)
  if (r.leadsDeltaPct != null && r.leadsDeltaPct < 0) weak.push(`Leads declined ${Math.abs(r.leadsDeltaPct)}%.`)
  if (r.cpl != null && r.cpl > 500) weak.push(`Cost per lead is ₹${r.cpl}.`)
  const bestCampaign = Object.entries(facts?.leadsByCampaign ?? {}).sort((a: any, b: any) => b[1] - a[1])[0]
  return {
    summary: `${reachTxt} ${leadTxt} ${r.contentPublished ?? 0} posts published.`.trim(),
    wins: wins.length ? wins : ['Steady delivery across connected accounts.'],
    weak: weak.length ? weak : ['No significant declines detected.'],
    contentInsight: `${r.contentPublished ?? 0} pieces published; engagement totalled ${fmt(r.interactions)}.`,
    leadInsight: bestCampaign ? `Top lead source: ${bestCampaign[0]} (${bestCampaign[1]} leads). ${r.cpl != null ? `CPL ₹${r.cpl}.` : ''}` : leadTxt,
    recommendations: buildRecs(r),
    ruleBased: true,
  }
}

function buildRecs(r: any): string[] {
  const recs: string[] = []
  if (r.cpl != null && r.cpl > 500) recs.push('Tighten ad targeting or refresh creative to bring cost per lead down.')
  if (r.reachDeltaPct != null && r.reachDeltaPct < 0) recs.push('Increase short-form video (Reels) frequency to recover reach.')
  if ((r.contentPublished ?? 0) < 8) recs.push('Raise publishing cadence — under 8 posts this period.')
  if (!recs.length) recs.push('Maintain the current content mix; scale the best-performing formats.')
  return recs
}

const fmt = (n: number | null | undefined) => n == null ? '—' : Intl.NumberFormat('en-IN', { notation: 'compact' }).format(n)

/**
 * Generate (or read cached) AI insights for a fact bundle. `scope` is a cache
 * key like `client:<id>` or `agency`.
 */
export async function generateInsights(
  admin: SupabaseClient,
  scope: string,
  facts: any,
): Promise<MetaNarrative> {
  const factsHash = hashFacts(facts)

  // Cache hit?
  try {
    const { data: cached } = await admin
      .from('meta_insight_cache')
      .select('narrative')
      .eq('scope', scope)
      .eq('facts_hash', factsHash)
      .maybeSingle()
    if (cached?.narrative) return cached.narrative as MetaNarrative
  } catch { /* table may not exist yet */ }

  let narrative: MetaNarrative
  try {
    if (!process.env.GROQ_API_KEY) {
      narrative = ruleBasedNarrative(facts)
    } else {
      const raw = await callGroqJSON(SYSTEM_PROMPT, JSON.stringify(facts), { maxTokens: 700 })
      narrative = {
        summary: String(raw.summary ?? ''),
        wins: Array.isArray(raw.wins) ? raw.wins.map(String) : [],
        weak: Array.isArray(raw.weak) ? raw.weak.map(String) : [],
        contentInsight: String(raw.contentInsight ?? ''),
        leadInsight: String(raw.leadInsight ?? ''),
        recommendations: Array.isArray(raw.recommendations) ? raw.recommendations.map(String) : [],
      }
      // If the model returned an empty shell, fall back to deterministic.
      if (!narrative.summary && !narrative.wins.length) narrative = ruleBasedNarrative(facts)
    }
  } catch {
    narrative = ruleBasedNarrative(facts)
  }

  // Cache (best-effort; skip caching rule-based so a later AI run can replace it)
  if (!narrative.ruleBased) {
    await admin.from('meta_insight_cache').insert({ scope, facts_hash: factsHash, narrative }).then(null, () => {})
  }
  return narrative
}
