/**
 * Ad Spend Statement — printable / downloadable client document.
 *
 * Same letterhead as invoices, quotations and the Statement of Account:
 * buildPageDecor + the invoice design settings (colours, page style, font,
 * logo), so changing the design in Settings changes every document at once.
 *
 * Written for the client (a local business, not an accountant): what Meta
 * charged for their ads each month, the 18% GST on it, which invoice billed
 * it, the money added for their ads and what is left.
 */
import { buildPageDecor } from '@/lib/invoices/render-html'
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
  /** Money added to the client's ad wallet (shown with the balance). */
  topUps?: AdStatementTopUp[]
  /** Funds added − spend since the first top-up (incl. GST). */
  balanceInr?: number | null
  platform?: string
}

/** Only these settings ever reach the browser for documents. */
export const DOCUMENT_SETTING_KEYS = /^(company_(name|phone|website|tagline|address)|logo_url(_light)?|invoice_.+|bank_(holder|account|ifsc|upi))$/

export function documentSettings(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([k]) => DOCUMENT_SETTING_KEYS.test(k)))
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

const money = (n: number) =>
  `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signed = (n: number) => (n < 0 ? `− ${money(n)}` : money(n))

const monthName = (p: string) =>
  new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const fmtDate = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function renderAdStatementHtml(
  st: StatementClient,
  client: AdStatementParty,
  companySettings: Record<string, string>,
  opts: AdStatementOpts = {},
): string {
  const decor = buildPageDecor(companySettings)
  const NAVY = companySettings.invoice_primary_color || '#1a2744'
  const FONT = companySettings.invoice_font || "'Airbnb Cereal App', Arial, Helvetica, sans-serif"
  const platform = opts.platform || 'Meta'
  const company = companySettings.company_name || 'Cirqle Works'
  const rawLogo = companySettings.logo_url_light || companySettings.logo_url || ''
  // Remote logos go through our own origin (same as invoices); data: URIs as-is.
  const logo = !rawLogo ? '' : /^https?:\/\//.test(rawLogo) ? `${opts.origin ?? ''}/api/invoice-logo` : rawLogo
  const showLogo = companySettings.invoice_show_logo !== 'false'

  const months = [...st.months].filter(m => m.spendInclGst > 0 || m.billedInr > 0)
  const adCost = months.reduce((t, m) => t + m.campaigns.reduce((s, c) => s + c.spendExGst, 0), 0)
  const gst = months.reduce((t, m) => t + m.campaigns.reduce((s, c) => s + c.gst, 0), 0)
  const toBill = Math.max(0, st.differenceInr)
  const period = months.length
    ? months.length === 1 ? monthName(months[0].period) : `${monthName(months[0].period)} – ${monthName(months[months.length - 1].period)}`
    : '—'

  const monthRows = months.map(m => {
    const invNos = [...new Set(m.invoices.map(i => i.number).filter(Boolean))].join(', ')
    const camp = m.campaigns.map(c => `
      <tr>
        <td style="padding:6px 8px 6px 20px;font-size:10px;color:#334155">${esc(c.campaignName)}</td>
        <td style="padding:6px 8px;font-size:10px;text-align:center;color:#64748b">${c.days || ''}</td>
        <td style="padding:6px 8px;font-size:10px;text-align:right;color:#334155">${money(c.spendExGst)}</td>
        <td style="padding:6px 8px;font-size:10px;text-align:right;color:#64748b">${money(c.gst)}</td>
        <td style="padding:6px 8px;font-size:10px;text-align:right;color:#0f172a">${money(c.spendInclGst)}</td>
        <td></td>
      </tr>`).join('')
    const mAd = m.campaigns.reduce((s, c) => s + c.spendExGst, 0)
    const mGst = m.campaigns.reduce((s, c) => s + c.gst, 0)
    const billedNote = m.status === 'running' ? 'This month — billed at month end'
      : m.billedInr > 0 ? `${money(m.billedInr)}${invNos ? `<div style="font-size:8.5px;color:#64748b;font-weight:500">${esc(invNos)}</div>` : ''}`
      : 'To be billed'
    return `
      <tr style="background:${NAVY}0d">
        <td style="padding:8px;font-size:10.5px;font-weight:700;color:${NAVY}">${esc(monthName(m.period))}</td>
        <td></td>
        <td style="padding:8px;font-size:10.5px;font-weight:700;text-align:right">${money(mAd)}</td>
        <td style="padding:8px;font-size:10.5px;font-weight:700;text-align:right">${money(mGst)}</td>
        <td style="padding:8px;font-size:10.5px;font-weight:800;text-align:right">${money(m.spendInclGst)}</td>
        <td style="padding:8px;font-size:10px;font-weight:600;text-align:right;color:${m.billedInr > 0 ? '#047857' : '#b45309'}">${billedNote}</td>
      </tr>${camp}`
  }).join('')

  const topUps = (opts.topUps ?? []).slice().sort((a, b) => a.date.localeCompare(b.date))
  const added = topUps.reduce((t, x) => t + x.amountInr, 0)
  const fundsBlock = topUps.length ? `
  <div style="display:flex;gap:14px;margin-bottom:16px">
    <div style="flex:1;border:1px solid #e8edf3;border-radius:9px;overflow:hidden">
      <div style="padding:7px 12px;background:#f8fafc;font-size:9px;letter-spacing:.07em;text-transform:uppercase;color:#475569;font-weight:600;border-bottom:1px solid #e8edf3">Money added to your ad account</div>
      <table>${topUps.map(x => `
        <tr><td style="padding:6px 12px;font-size:10px;color:#475569">${fmtDate(x.date)}</td>
            <td style="padding:6px 12px;font-size:10px;text-align:right;font-weight:600">${money(x.amountInr)}</td></tr>`).join('')}
        <tr><td style="padding:7px 12px;font-size:10px;font-weight:700;border-top:1px solid #e8edf3">Total added</td>
            <td style="padding:7px 12px;font-size:10.5px;text-align:right;font-weight:800;border-top:1px solid #e8edf3">${money(added)}</td></tr>
      </table>
    </div>
    ${opts.balanceInr != null ? `
    <div style="width:250px;background:${opts.balanceInr < 0 ? '#b91c1c' : NAVY};border-radius:9px;padding:13px 15px;color:#fff;display:flex;flex-direction:column;justify-content:center">
      <div style="font-size:8.5px;letter-spacing:.07em;text-transform:uppercase;opacity:.75">${opts.balanceInr < 0 ? 'Spent more than added' : 'Balance left for ads'}</div>
      <div style="font-size:24px;font-weight:800;letter-spacing:-.02em;margin-top:2px">${signed(opts.balanceInr)}</div>
      <div style="font-size:9px;opacity:.8;margin-top:4px;line-height:1.4">${opts.balanceInr < 0 ? 'Please add funds so your ads keep running.' : 'Used for your running ads before any new top-up.'}</div>
    </div>` : ''}
  </div>` : ''

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Ad Spend Statement — ${esc(client.name)}</title>
<style>
  @page { size: A4; margin: ${decor.fullBleed ? '0' : '14mm 12mm'}; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:${FONT}; color:#0f172a; ${decor.bgCss}
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { position:relative; width:800px; margin:0 auto; padding:${decor.fullBleed ? '28px 34px' : '0'}; z-index:1; }
  table { width:100%; border-collapse:collapse; }
  thead th { font-size:8.5px; letter-spacing:.07em; text-transform:uppercase; color:#64748b;
             padding:7px 8px; border-bottom:1.5px solid ${NAVY}; text-align:left; }
  tbody tr { border-bottom:1px solid #eef2f7; break-inside: avoid; }
</style></head>
<body>
${decor.bgTop('absolute')}${decor.bgBottom('absolute')}${decor.cornerSvg('absolute')}
<div class="sheet">

  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:22px">
    <div>
      ${showLogo && logo ? `<img src="${esc(logo)}" alt="" style="height:42px;object-fit:contain;margin-bottom:8px">` : ''}
      <div style="font-size:15px;font-weight:700;color:${NAVY}">${esc(company)}</div>
      ${companySettings.company_tagline ? `<div style="font-size:9.5px;color:#64748b;margin-top:2px">${esc(companySettings.company_tagline)}</div>` : ''}
      ${companySettings.company_phone || companySettings.company_website ? `<div style="font-size:9.5px;color:#64748b;margin-top:2px">${esc([companySettings.company_phone, companySettings.company_website].filter(Boolean).join(' · '))}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:${NAVY}">AD SPEND STATEMENT</div>
      <div style="font-size:10px;color:#64748b;margin-top:3px">${esc(platform)} ads · ${esc(period)}</div>
      <div style="font-size:9px;color:#94a3b8;margin-top:2px">Issued ${fmtDate(todayISO())}</div>
    </div>
  </div>

  <div style="display:flex;gap:14px;margin-bottom:18px">
    <div style="flex:1;background:#f8fafc;border:1px solid #e8edf3;border-radius:9px;padding:11px 13px">
      <div style="font-size:8.5px;letter-spacing:.07em;text-transform:uppercase;color:#94a3b8;margin-bottom:4px">Statement for</div>
      <div style="font-size:13px;font-weight:700">${esc(client.name)}${client.code ? ` <span style="font-size:9.5px;font-weight:500;color:#94a3b8">${esc(client.code)}</span>` : ''}</div>
      ${client.address ? `<div style="font-size:9.5px;color:#64748b;line-height:1.5;margin-top:3px">${esc(client.address)}</div>` : ''}
      ${client.phone ? `<div style="font-size:9.5px;color:#64748b;margin-top:2px">${esc(client.phone)}</div>` : ''}
    </div>
    <div style="width:250px;background:${NAVY};border-radius:9px;padding:11px 13px;color:#fff">
      <div style="font-size:8.5px;letter-spacing:.07em;text-transform:uppercase;opacity:.7">Total ad spend (incl. GST)</div>
      <div style="font-size:24px;font-weight:800;letter-spacing:-.02em;margin-top:2px">${money(st.spendInclGst)}</div>
      <div style="font-size:9px;opacity:.75;margin-top:4px">${months.length} month${months.length === 1 ? '' : 's'} · as charged by ${esc(platform)}</div>
    </div>
  </div>

  <table style="margin-bottom:18px;border:1px solid #e8edf3;border-radius:9px;overflow:hidden">
    <tr>
      <td style="padding:9px 12px;background:#f8fafc">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Ad cost</div>
        <div style="font-size:13px;font-weight:700;margin-top:2px">${money(adCost)}</div>
      </td>
      <td style="padding:9px 12px;background:#f8fafc;border-left:1px solid #e8edf3">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">GST 18%</div>
        <div style="font-size:13px;font-weight:700;margin-top:2px">${money(gst)}</div>
      </td>
      <td style="padding:9px 12px;background:#f8fafc;border-left:1px solid #e8edf3">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Billed on invoices</div>
        <div style="font-size:13px;font-weight:700;color:#047857;margin-top:2px">${money(st.billedInr)}</div>
      </td>
      <td style="padding:9px 12px;background:${NAVY}0d;border-left:1px solid #e8edf3">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Still to be billed</div>
        <div style="font-size:13px;font-weight:800;margin-top:2px">${money(toBill)}</div>
      </td>
    </tr>
  </table>

  ${fundsBlock}

  <table style="margin-bottom:18px">
    <thead><tr>
      <th>Month / campaign</th>
      <th style="text-align:center;width:44px">Days</th>
      <th style="text-align:right;width:86px">Ad cost</th>
      <th style="text-align:right;width:76px">GST 18%</th>
      <th style="text-align:right;width:90px">Total</th>
      <th style="text-align:right;width:140px">Billed</th>
    </tr></thead>
    <tbody>${monthRows || `<tr><td colspan="6" style="padding:14px 8px;font-size:10px;color:#64748b;text-align:center">No ad spend in this period.</td></tr>`}</tbody>
    <tfoot><tr>
      <td colspan="2" style="padding:9px 8px;font-size:10px;font-weight:700;text-align:right;border-top:1.5px solid ${NAVY}">Total</td>
      <td style="padding:9px 8px;font-size:10px;font-weight:700;text-align:right;border-top:1.5px solid ${NAVY}">${money(adCost)}</td>
      <td style="padding:9px 8px;font-size:10px;font-weight:700;text-align:right;border-top:1.5px solid ${NAVY}">${money(gst)}</td>
      <td style="padding:9px 8px;font-size:11px;font-weight:800;text-align:right;border-top:1.5px solid ${NAVY}">${money(st.spendInclGst)}</td>
      <td style="padding:9px 8px;font-size:10px;font-weight:700;text-align:right;color:#047857;border-top:1.5px solid ${NAVY}">${money(st.billedInr)}</td>
    </tr></tfoot>
  </table>

  <div style="background:#f8fafc;border:1px solid #e8edf3;border-radius:9px;padding:10px 13px;margin-bottom:14px;font-size:9.5px;color:#475569;line-height:1.6">
    <b>How to read this:</b> "Ad cost" is what ${esc(platform)} charged to show your ads. ${esc(platform)} adds 18% GST on top, so
    "Total" is the full amount paid for your ads. We bill you exactly this amount — our service charge is shown separately on your invoice.
  </div>

  <div style="text-align:center;font-size:8.5px;color:#94a3b8;padding-top:10px;border-top:1px solid #eef2f7">
    ${esc(companySettings.invoice_footer_text || 'Thank you for your Business!')}
  </div>

</div>
${opts.autoprint ? '<script>window.onload=()=>{setTimeout(()=>window.print(),300)}</script>' : ''}
</body></html>`
}
