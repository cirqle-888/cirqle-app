/**
 * Ad Spend Statement — printable / downloadable client document.
 *
 * Looks like the branded "Meta Ads Daily Report": the same brand tokens
 * (reporting/layouts/shared), Meta logo, round KPI icons, purple table header
 * and footer — and the same page background, which comes from Settings →
 * invoice design (custom top/bottom images, via buildPageDecor) exactly as the
 * reports and invoices use it.
 *
 * Written for the client (a local business, not an accountant): what Meta
 * charged for their ads each month, the 18% GST on it, which invoice billed
 * it, the money added for their ads and what is left.
 */
import { buildPageDecor } from '@/lib/invoices/render-html'
import { PURPLE, INK, GREY_PILL, RED_PILL } from '@/lib/reporting/layouts/shared'
import { META_LOGO_DATA_URI } from '@/lib/reporting/layouts/meta-logo'
import { todayISO } from '@/lib/utils/local-date'
import type { StatementClient } from './funds-core'

export interface AdStatementParty {
  name: string
  code?: string | null
  address?: string | null
  phone?: string | null
}

export interface AdStatementTopUp {
  /** YYYY-MM-DD */
  date: string
  amountInr: number
}

export interface AdStatementOpts {
  autoprint?: boolean
  /** App origin, so a downloaded file still finds the logo. */
  origin?: string
  /** Money added to the client's ad wallet. */
  topUps?: AdStatementTopUp[]
  /** Funds added − spend since the first top-up (incl. GST). */
  balanceInr?: number | null
  platform?: string
}

/** Only these settings ever reach the browser for documents. */
export const DOCUMENT_SETTING_KEYS = /^(company_(name|phone|website|tagline|address|email)|logo_url(_light)?|invoice_.+|bank_(holder|account|ifsc|upi))$/

export function documentSettings(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([k]) => DOCUMENT_SETTING_KEYS.test(k)))
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

const money = (n: number) =>
  `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signed = (n: number) => (n < 0 ? `−${money(n)}` : money(n))

const monthName = (p: string) =>
  new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`

// White line icons — same paths as reporting/layouts/shared Icon().
const ICON: Record<string, string> = {
  rupee: '<path d="M6 4h12"/><path d="M6 8h12"/><path d="M8 8c5 0 5 7 0 7H7l7 6"/>',
  percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
}

function kpi(label: string, value: string, grad: [string, string], icon: string): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;width:128px">
    <div style="width:58px;height:58px;border-radius:58px;background:linear-gradient(135deg,${grad[0]},${grad[1]});display:flex;align-items:center;justify-content:center;margin-bottom:9px">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${ICON[icon]}</svg>
    </div>
    <div style="font-size:12px;font-weight:600;color:#6B7280;margin-bottom:2px;text-align:center">${esc(label)}</div>
    <div style="font-size:19px;font-weight:800;color:${INK};text-align:center;white-space:nowrap">${esc(value)}</div>
  </div>`
}
const divider = '<div style="width:1px;height:50px;background:#E5E7EB;margin-top:4px"></div>'

const pill = (bg: string, label: string, value: string) =>
  `<div style="display:inline-flex;gap:6px;align-items:center;background:${bg};color:#fff;border-radius:10px;padding:10px 20px;font-size:14px">
     <span style="font-weight:500">${esc(label)} :</span><span style="font-weight:800">${esc(value)}</span></div>`

const metaPair = (k: string, v: string) =>
  `<span style="white-space:nowrap"><span style="color:#6B7280">${esc(k)} :</span> <span style="font-weight:700;color:${INK}">${esc(v)}</span></span>`

const th = (label: string, align: 'left' | 'right' | 'center' = 'right', w?: number) =>
  `<th style="background:${PURPLE};color:#fff;font-size:11.5px;font-weight:700;padding:10px 10px;text-align:${align};${w ? `width:${w}px;` : ''}">${esc(label)}</th>`

export function renderAdStatementHtml(
  st: StatementClient,
  client: AdStatementParty,
  companySettings: Record<string, string>,
  opts: AdStatementOpts = {},
): string {
  const decor = buildPageDecor(companySettings)
  const platform = opts.platform || 'Meta'
  const agency = companySettings.company_name || 'Cirqle Works'
  const website = (companySettings.company_website || 'cirqle.work').replace(/^https?:\/\//, '')
  const email = companySettings.company_email || 'farooq@cirqle.work'
  const rawLogo = companySettings.logo_url_light || companySettings.logo_url || ''
  // Remote logos go through our own origin (as invoices do); data: URIs as-is.
  const logo = !rawLogo ? '' : /^https?:\/\//.test(rawLogo) ? `${opts.origin ?? ''}/api/invoice-logo` : rawLogo

  const months = st.months.filter(m => m.spendInclGst > 0 || m.billedInr > 0)
  const adCost = months.reduce((t, m) => t + m.campaigns.reduce((s, c) => s + c.spendExGst, 0), 0)
  const gst = months.reduce((t, m) => t + m.campaigns.reduce((s, c) => s + c.gst, 0), 0)
  const toBill = Math.max(0, st.differenceInr)
  const campaigns = new Set(months.flatMap(m => m.campaigns.map(c => c.campaignKey))).size
  const period = months.length
    ? months.length === 1 ? monthName(months[0].period) : `${monthName(months[0].period)} - ${monthName(months[months.length - 1].period)}`
    : '—'
  const topUps = (opts.topUps ?? []).slice().sort((a, b) => b.date.localeCompare(a.date))
  const added = topUps.reduce((t, x) => t + x.amountInr, 0)

  const td = (v: string, extra = '') => `<td style="padding:9px 10px;font-size:12px;text-align:right;color:#374151;${extra}">${v}</td>`
  let zebra = false
  const rows = [...months].reverse().map(m => {
    const invNos = [...new Set(m.invoices.map(i => i.number).filter(Boolean))].join(', ')
    const billed = m.status === 'running' ? `<span style="color:#6B7280;font-weight:600">Month end</span>`
      : m.billedInr > 0 ? `${money(m.billedInr)}${invNos ? `<div style="font-size:9.5px;color:#6B7280;font-weight:500">${esc(invNos)}</div>` : ''}`
      : `<span style="color:${RED_PILL}">To be billed</span>`
    const head = `<tr style="background:#EDE9FE">
        <td style="padding:9px 10px;font-size:12.5px;font-weight:800;color:${INK}">${esc(monthName(m.period))}</td>
        ${td('', '')}
        ${td(money(m.campaigns.reduce((s, c) => s + c.spendExGst, 0)), 'font-weight:700')}
        ${td(money(m.campaigns.reduce((s, c) => s + c.gst, 0)), 'font-weight:700')}
        ${td(money(m.spendInclGst), `font-weight:800;color:${INK}`)}
        ${td(billed, `font-weight:700;color:${PURPLE}`)}
      </tr>`
    const camp = m.campaigns.map(c => {
      zebra = !zebra
      return `<tr style="background:${zebra ? '#FFFFFF' : '#F5F3FF'}">
        <td style="padding:8px 10px 8px 18px;font-size:11.5px;color:#374151">${esc(c.campaignName)}</td>
        ${td(String(c.days || ''), 'text-align:center;color:#6B7280')}
        ${td(money(c.spendExGst))}
        ${td(money(c.gst), 'color:#6B7280')}
        ${td(money(c.spendInclGst), `color:${INK};font-weight:600`)}
        ${td('')}
      </tr>`
    }).join('')
    return head + camp
  }).join('')

  const balance = opts.balanceInr
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(platform)} Ads Spend Statement — ${esc(client.name)}</title>
<style>
  @page { size: A4; margin: ${decor.fullBleed ? '0' : '12mm'}; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Noto Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
         color:${INK}; ${decor.bgCss} -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .sheet { position:relative; width:800px; min-height:1130px; margin:0 auto; padding:${decor.fullBleed ? '44px 40px 40px' : '0'};
           display:flex; flex-direction:column; z-index:1; }
  table { width:100%; border-collapse:collapse; }
  tr { break-inside: avoid; }
</style></head>
<body>
${decor.bgTop('absolute')}${decor.bgBottom('absolute')}${decor.cornerSvg('absolute')}
<div class="sheet">

  <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:16px">
    <div style="width:170px;height:42px;display:flex;align-items:center">
      ${logo ? `<img src="${esc(logo)}" alt="" style="max-width:170px;max-height:42px;object-fit:contain">`
             : `<span style="font-size:22px;font-weight:800;color:${PURPLE}">${esc(agency)}</span>`}
    </div>
    <div style="font-size:19px;font-weight:600;color:${INK}">${esc(longDate(todayISO()))}</div>
    <div style="width:170px;display:flex;justify-content:flex-end">
      ${platform === 'Meta' ? `<img src="${META_LOGO_DATA_URI}" alt="Meta" style="height:22px">` : `<span style="font-size:20px;font-weight:800">${esc(platform)}</span>`}
    </div>
  </div>
  <div style="height:1.5px;background:#E5E7EB;margin-bottom:22px"></div>

  <div style="text-align:center;font-size:36px;font-weight:900;letter-spacing:-.5px;color:${INK};margin-bottom:14px">${esc(platform)} Ads Spend Statement</div>

  <div style="display:flex;flex-direction:column;align-items:center;gap:5px;font-size:14px;margin-bottom:24px">
    <div style="display:flex;gap:26px;flex-wrap:wrap;justify-content:center">${metaPair('Client', client.name)}${client.code ? metaPair('Client Code', client.code) : ''}</div>
    <div style="display:flex;gap:26px;flex-wrap:wrap;justify-content:center">${metaPair('Statement Period', period)}${metaPair('Campaigns', String(campaigns))}</div>
  </div>

  <div style="display:flex;justify-content:center;gap:10px;margin-bottom:22px">
    ${kpi('Ad Cost', money(adCost), ['#8B5CF6', '#6D28D9'], 'rupee')}${divider}
    ${kpi('GST 18%', money(gst), ['#FB923C', '#EF4444'], 'percent')}${divider}
    ${kpi(`${platform} Spend`, money(st.spendInclGst), ['#A855F7', '#7C3AED'], 'rupee')}${divider}
    ${kpi('Billed', money(st.billedInr), ['#22B8F2', '#2563EB'], 'doc')}${divider}
    ${kpi('Money Added', added > 0 ? money(added) : '—', ['#6366F1', '#4F46E5'], 'check')}
  </div>

  <div style="display:flex;justify-content:center;gap:14px;flex-wrap:wrap;margin-bottom:26px">
    ${toBill > 1 ? pill(RED_PILL, 'Still to be Billed', money(toBill)) : pill('#16A34A', 'Billing', 'Up to date')}
    ${balance != null ? pill(balance < 0 ? RED_PILL : GREY_PILL, balance < 0 ? 'Spent more than Added' : 'Balance Left for Ads', signed(balance)) : ''}
  </div>

  <div style="display:flex;align-items:baseline;gap:10px;padding-bottom:8px;border-bottom:2px solid ${PURPLE};margin-bottom:12px">
    <span style="font-size:20px;font-weight:800;color:${INK}">Monthly Spend Breakdown</span>
    <span style="font-size:13px;color:#6B7280">(${esc(client.name)})</span>
  </div>
  <table style="margin-bottom:22px;border:1px solid #EDE9FE">
    <thead><tr>
      ${th('Month / Campaign', 'left')}${th('Days', 'center', 46)}${th('Ad Cost', 'right', 92)}${th('GST', 'right', 80)}${th('Total', 'right', 96)}${th('Billed', 'right', 120)}
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="6" style="padding:16px;text-align:center;color:#9CA3AF;font-size:12px">No ad spend in this period.</td></tr>`}</tbody>
    <tfoot><tr style="border-top:2px solid ${PURPLE}">
      <td style="padding:10px;font-size:12.5px;font-weight:800">Total</td><td></td>
      ${td(money(adCost), 'font-weight:800')}${td(money(gst), 'font-weight:800')}
      ${td(money(st.spendInclGst), `font-weight:900;color:${INK}`)}${td(money(st.billedInr), `font-weight:800;color:${PURPLE}`)}
    </tr></tfoot>
  </table>

  ${topUps.length ? `
  <div style="display:flex;align-items:baseline;gap:10px;padding-bottom:8px;border-bottom:2px solid ${PURPLE};margin-bottom:12px">
    <span style="font-size:20px;font-weight:800;color:${INK}">Money Added to Your Ad Account</span>
  </div>
  <table style="margin-bottom:22px;border:1px solid #EDE9FE">
    <thead><tr>${th('Date', 'left')}${th('Amount', 'right', 140)}</tr></thead>
    <tbody>${topUps.map((x, i) => `<tr style="background:${i % 2 ? '#F5F3FF' : '#FFFFFF'}">
      <td style="padding:9px 10px;font-size:12px;color:#374151">${ddmmyyyy(x.date)}</td>${td(money(x.amountInr), `color:${PURPLE};font-weight:700`)}</tr>`).join('')}</tbody>
    <tfoot><tr style="border-top:2px solid ${PURPLE}"><td style="padding:10px;font-size:12.5px;font-weight:800">Total Added</td>${td(money(added), 'font-weight:900')}</tr></tfoot>
  </table>` : ''}

  <div style="background:#F5F3FF;border:1px solid #EDE9FE;border-radius:10px;padding:11px 14px;font-size:11.5px;color:#4B5563;line-height:1.6;margin-bottom:18px">
    <b style="color:${INK}">How to read this:</b> "Ad Cost" is what ${esc(platform)} charged to show your ads. ${esc(platform)} adds 18% GST,
    so "Total" is the full amount paid for your ads. We bill you exactly this amount — our service charge is shown separately on your invoice.
  </div>

  <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:center;padding-top:16px;border-top:1.5px solid #E5E7EB;font-size:12.5px;color:#6B7280">
    <span style="font-weight:800;color:${PURPLE};font-size:15px">${esc(agency)}</span>
    <span>${esc(website)}${email ? `  |  ${esc(email)}` : ''}</span>
  </div>

</div>
${opts.autoprint ? '<script>window.onload=()=>{setTimeout(()=>window.print(),300)}</script>' : ''}
</body></html>`
}
