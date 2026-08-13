/**
 * Branded Social & Marketing report — self-contained HTML using the client's
 * BrandConfig (reuses src/lib/reporting/branding-engine). This is Cirqle's own
 * visual system, NOT a re-export of Meta's reports. HTML so it renders in-app,
 * prints to PDF, and can be emailed; no satori layout work required.
 *
 * All numbers come from buildClientFacts (verified DB rollups). The AI section
 * is clearly labelled as interpretation, separate from the facts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildClientFacts } from './aggregate'
import { generateInsights, type MetaNarrative } from './ai-insights'
import { resolveBrandConfig } from '@/lib/reporting/branding-engine'

const nf = (n: number | null | undefined) => (n == null ? '—' : Intl.NumberFormat('en-IN').format(Math.round(n)))
const nfc = (n: number | null | undefined) => (n == null ? '—' : Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n))
const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Intl.NumberFormat('en-IN').format(Math.round(n))}`)
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

function delta(pct: number | null): string {
  if (pct == null) return ''
  const up = pct >= 0
  return `<span style="color:${up ? '#16a34a' : '#dc2626'};font-size:12px;font-weight:600">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span>`
}

function kpi(label: string, value: string, sub = ''): string {
  return `<div style="flex:1;min-width:130px;background:#fff;border:1px solid #ece9f5;border-radius:12px;padding:14px 16px">
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">${esc(label)}</div>
    <div style="font-size:26px;font-weight:700;color:#111827;margin-top:4px">${value}</div>
    <div style="margin-top:2px">${sub}</div>
  </div>`
}

export interface SocialReportResult { html: string; narrative: MetaNarrative; clientName: string }

export async function generateSocialReportHtml(
  admin: SupabaseClient,
  clientId: string,
  days = 30,
): Promise<SocialReportResult> {
  const [facts, clientRow] = await Promise.all([
    buildClientFacts(admin, clientId, days),
    admin.from('clients').select('name').eq('id', clientId).maybeSingle(),
  ])
  const clientName = clientRow.data?.name ?? 'Client'
  const brand = await resolveBrandConfig(clientId, clientName).catch(() => null)
  const primary = brand?.primaryColor ?? '#7C3AED'
  const accent = brand?.accentColor ?? primary
  const r = facts.rollup

  const narrative = await generateInsights(admin, `client:${clientId}`, facts)

  const periodLabel = `Last ${days} days`
  const generated = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

  const topContent = facts.topContent.slice(0, 5)
  const contentRows = topContent.length
    ? topContent.map((m: any) => `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f0f7;font-size:13px">${esc((m.caption || '(no caption)').slice(0, 60))}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f0f7;font-size:12px;color:#6b7280">${esc(m.media_product_type || 'POST')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f0f7;text-align:right;font-size:13px">${nfc(m.reach)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f0f7;text-align:right;font-size:13px">${nfc(m.total_interactions)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f0f7;text-align:right;font-size:13px">${m.engagement_rate != null ? Number(m.engagement_rate).toFixed(1) + '%' : '—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="padding:14px;text-align:center;color:#9ca3af;font-size:13px">No published content in this period.</td></tr>`

  const leadCampaigns = Object.entries(facts.leadsByCampaign).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const leadRows = leadCampaigns.length
    ? leadCampaigns.map(([name, count]) => `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f0f7;font-size:13px">${esc(name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f0f7;text-align:right;font-size:13px">${count}</td>
      </tr>`).join('')
    : `<tr><td colspan="2" style="padding:14px;text-align:center;color:#9ca3af;font-size:13px">No leads captured in this period.</td></tr>`

  const list = (items: string[]) => items.length
    ? `<ul style="margin:6px 0 0;padding-left:18px">${items.map((i) => `<li style="font-size:13px;color:#374151;margin:3px 0">${esc(i)}</li>`).join('')}</ul>`
    : '<div style="font-size:13px;color:#9ca3af">—</div>'

  const logo = brand?.whiteLabelMode === 'client' ? brand?.logoUrl : (brand?.agencyLogoUrl ?? brand?.logoUrl)
  const brandName = brand?.whiteLabelMode === 'client' ? clientName : (brand?.agencyName ?? 'Cirqle')

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(clientName)} — Social & Marketing Report</title></head>
<body style="margin:0;background:#f6f5fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:840px;margin:0 auto;padding:24px">

  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,${primary},${accent});border-radius:16px;padding:22px 26px;color:#fff">
    <div>
      <div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:.08em">Social & Marketing Report</div>
      <div style="font-size:24px;font-weight:700;margin-top:2px">${esc(clientName)}</div>
      <div style="font-size:13px;opacity:.9;margin-top:2px">${periodLabel} · Generated ${generated}</div>
    </div>
    ${logo ? `<img src="${esc(logo)}" alt="" style="max-height:44px;max-width:150px;object-fit:contain">` : `<div style="font-size:18px;font-weight:700">${esc(brandName)}</div>`}
  </div>

  <!-- KPIs -->
  <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:18px">
    ${kpi('Reach', nfc(r?.reach ?? 0), delta(r?.reachDeltaPct ?? null))}
    ${kpi('Views', nfc(r?.views ?? 0))}
    ${kpi('Engagement', nfc(r?.interactions ?? 0))}
    ${kpi('Followers', nfc(r?.followers ?? null))}
    ${kpi('Leads', nf(r?.leads ?? 0), delta(r?.leadsDeltaPct ?? null))}
    ${kpi('Content published', nf(r?.contentPublished ?? 0))}
  </div>

  ${(r?.spend ?? 0) > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px">
    ${kpi('Ad spend', inr(r?.spend))}
    ${kpi('Ad leads', nf(r?.adLeads))}
    ${kpi('Cost per lead', inr(r?.cpl ?? null))}
    ${kpi('CTR', r?.ctr != null ? r.ctr + '%' : '—')}
    ${kpi('ROAS', r?.roas != null ? r.roas + '×' : '—')}
  </div>` : ''}

  <!-- Executive summary (AI interpretation) -->
  <div style="background:#fff;border:1px solid #ece9f5;border-radius:14px;padding:18px 20px;margin-top:18px">
    <div style="font-size:11px;color:${primary};font-weight:700;text-transform:uppercase;letter-spacing:.05em">Executive summary</div>
    <p style="font-size:14px;line-height:1.55;color:#1f2937;margin:8px 0 0">${esc(narrative.summary)}</p>
    <div style="font-size:10px;color:#9ca3af;margin-top:8px">${narrative.ruleBased ? 'Generated from your data (rule-based).' : 'AI interpretation of your verified data — figures above are exact.'}</div>
  </div>

  <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:14px">
    <div style="flex:1;min-width:260px;background:#fff;border:1px solid #ece9f5;border-radius:14px;padding:16px 18px">
      <div style="font-size:13px;font-weight:700;color:#16a34a">Key wins</div>${list(narrative.wins)}
    </div>
    <div style="flex:1;min-width:260px;background:#fff;border:1px solid #ece9f5;border-radius:14px;padding:16px 18px">
      <div style="font-size:13px;font-weight:700;color:#dc2626">Weak areas</div>${list(narrative.weak)}
    </div>
  </div>

  <!-- Top content -->
  <div style="background:#fff;border:1px solid #ece9f5;border-radius:14px;padding:16px 18px;margin-top:14px">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">Top content</div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="text-align:left">
        <th style="padding:6px 10px;font-size:11px;color:#6b7280;font-weight:600">Post</th>
        <th style="padding:6px 10px;font-size:11px;color:#6b7280;font-weight:600">Type</th>
        <th style="padding:6px 10px;font-size:11px;color:#6b7280;font-weight:600;text-align:right">Reach</th>
        <th style="padding:6px 10px;font-size:11px;color:#6b7280;font-weight:600;text-align:right">Engagement</th>
        <th style="padding:6px 10px;font-size:11px;color:#6b7280;font-weight:600;text-align:right">Eng. rate</th>
      </tr></thead>
      <tbody>${contentRows}</tbody>
    </table>
    <div style="font-size:13px;font-weight:600;color:#374151;margin-top:10px">${esc(narrative.contentInsight)}</div>
  </div>

  <!-- Leads -->
  <div style="background:#fff;border:1px solid #ece9f5;border-radius:14px;padding:16px 18px;margin-top:14px">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">Lead generation</div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="text-align:left">
        <th style="padding:6px 10px;font-size:11px;color:#6b7280;font-weight:600">Campaign / source</th>
        <th style="padding:6px 10px;font-size:11px;color:#6b7280;font-weight:600;text-align:right">Leads</th>
      </tr></thead>
      <tbody>${leadRows}</tbody>
    </table>
    <div style="font-size:13px;font-weight:600;color:#374151;margin-top:10px">${esc(narrative.leadInsight)}</div>
  </div>

  <!-- Recommendations -->
  <div style="background:#faf9ff;border:1px solid ${primary}33;border-radius:14px;padding:16px 18px;margin-top:14px">
    <div style="font-size:13px;font-weight:700;color:${primary}">Recommendations for next period</div>${list(narrative.recommendations)}
  </div>

  <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:20px">
    ${esc(brand?.footerText ?? '')}${brand?.showPoweredBy !== false ? `${brand?.footerText ? ' · ' : ''}Powered by Cirqle` : ''}
  </div>
</div>
</body></html>`

  return { html, narrative, clientName }
}
