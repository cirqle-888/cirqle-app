/**
 * Statement of Account — printable / PDF document.
 *
 * Reuses buildPageDecor from the invoice renderer so a statement and an invoice
 * carry the same letterhead: change the design settings once and both follow.
 */
import { buildPageDecor } from '@/lib/invoices/render-html'
import { getCurrencySymbol } from '@/lib/calculations/currency'
import type { StatementResult } from './build'
import { unitPriceOf } from '@/lib/invoices/line-math'

export interface StatementParty {
  name: string
  code?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
}

/** One printed line beneath its invoice. Mirrors the on-screen expansion. */
export interface StatementDocLineItem {
  id: string
  description: string | null
  quantity: number | null
  unit_price: number | null
  total: number | null
  line_date: string | null
  task_title: string | null
  task_date: string | null
  service_name: string | null
}

export interface StatementDocOpts {
  autoprint?: boolean
  /** Shown under the title, e.g. "August 2026" or "1 Apr 2026 – 30 Jun 2026". */
  periodLabel: string
  /** Omit the ledger rows and print only balances + aging. */
  summaryOnly?: boolean
  /**
   * invoice id → its lines. When present each invoice row is followed by its
   * items, which is what turns the statement into the task-level ledger a
   * client asks for when they want to see what they were billed FOR.
   */
  lineItems?: Record<string, StatementDocLineItem[]>
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

const fmtDate = (iso: string): string => {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00')
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

export function renderStatementHtml(
  statement: StatementResult,
  client: StatementParty,
  companySettings: Record<string, string>,
  opts: StatementDocOpts,
): string {
  const decor = buildPageDecor(companySettings)
  const NAVY = companySettings.invoice_primary_color || '#1a2744'
  const sym = getCurrencySymbol(statement.currency as never) || statement.currency
  const money = (n: number) => {
    const v = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return n < 0 ? `(${sym}${v})` : `${sym}${v}`
  }

  const company = companySettings.company_name || 'Cirqle Works'
  const logo = companySettings.invoice_logo_url || companySettings.company_logo_url || ''

  const itemRowsFor = (invoiceId: string): string => {
    const items = opts.lineItems?.[invoiceId]
    if (!items?.length) return ''
    const lines = items.map(it => {
      const when = it.task_date || it.line_date
      // Derived, not stored — see lib/invoices/line-math.ts. A stored rate that
      // contradicts the line total printed "2 × ₹600.00" beside a ₹600.00
      // total on a document that goes to the client.
      const unit = unitPriceOf(it)
      const qty = (it.quantity ?? 1) > 1 && unit != null
        ? `<span style="color:#94a3b8">&nbsp;·&nbsp;${it.quantity} × ${money(unit)}</span>` : ''
      return `<div style="display:flex;gap:8px;font-size:9px;color:#475569;padding:1.5px 0">
          <span style="width:44px;color:#94a3b8;flex-shrink:0">${when ? fmtDate(when) : ''}</span>
          <span style="flex:1">${esc(it.description || it.task_title || 'Item')}${it.service_name ? `<span style="color:#94a3b8"> · ${esc(it.service_name)}</span>` : ''}${qty}</span>
          <span style="width:70px;text-align:right;flex-shrink:0">${it.total != null ? money(it.total) : '—'}</span>
        </div>`
    }).join('')
    return `<tr style="background:#fbfcfd">
        <td></td>
        <td colspan="5" style="padding:4px 8px 7px 8px">
          <div style="border-left:2px solid #cbd5e1;padding-left:9px">${lines}</div>
        </td>
      </tr>`
  }

  const ledgerRows = statement.rows.map((r, i) => `
    <tr style="background:${i % 2 ? '#fafbfc' : '#fff'}">
      <td style="padding:7px 8px;font-size:10px;color:#475569;white-space:nowrap">${fmtDate(r.date)}</td>
      <td style="padding:7px 8px;font-size:10px;font-family:ui-monospace,monospace;color:#64748b;white-space:nowrap">${esc(r.ref)}</td>
      <td style="padding:7px 8px;font-size:10px;color:#0f172a">${esc(r.description)}</td>
      <td style="padding:7px 8px;font-size:10px;text-align:right;color:#0f172a;white-space:nowrap">${r.debit ? money(r.debit) : ''}</td>
      <td style="padding:7px 8px;font-size:10px;text-align:right;color:#047857;white-space:nowrap">${r.credit ? money(r.credit) : ''}</td>
      <td style="padding:7px 8px;font-size:10px;text-align:right;font-weight:600;color:#0f172a;white-space:nowrap">${money(r.balance)}</td>
    </tr>${r.kind === 'invoice' ? itemRowsFor(r.invoiceId) : ''}`).join('')

  const agingCells = statement.aging
    .filter(b => b.amount > 0)
    .map(b => `
      <td style="padding:9px 10px;text-align:center;border-left:1px solid #e8edf3">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">${esc(b.label)}</div>
        <div style="font-size:12px;font-weight:700;color:${b.label === '90+ days' ? '#b91c1c' : '#0f172a'};margin-top:3px">${money(b.amount)}</div>
      </td>`).join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Statement — ${esc(client.name)}</title>
<style>
  @page { size: A4; margin: ${decor.fullBleed ? '0' : '14mm 12mm'}; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
         color:#0f172a; ${decor.bgCss} -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { position:relative; width:800px; margin:0 auto; padding:${decor.fullBleed ? '28px 34px' : '0'}; }
  table { width:100%; border-collapse:collapse; }
  thead th { font-size:8.5px; letter-spacing:.07em; text-transform:uppercase; color:#64748b;
             padding:7px 8px; border-bottom:1.5px solid ${NAVY}; text-align:left; }
  tbody tr { border-bottom:1px solid #eef2f7; }
</style></head>
<body>
${decor.bgTop('absolute')}${decor.bgBottom('absolute')}${decor.cornerSvg('absolute')}
<div class="sheet">

  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:22px">
    <div>
      ${logo ? `<img src="${esc(logo)}" alt="" style="height:42px;object-fit:contain;margin-bottom:8px">` : ''}
      <div style="font-size:15px;font-weight:700;color:${NAVY}">${esc(company)}</div>
      ${companySettings.company_address ? `<div style="font-size:9.5px;color:#64748b;max-width:280px;line-height:1.5;margin-top:3px">${esc(companySettings.company_address)}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:${NAVY}">STATEMENT OF ACCOUNT</div>
      <div style="font-size:10px;color:#64748b;margin-top:3px">${esc(opts.periodLabel)}</div>
      <div style="font-size:9px;color:#94a3b8;margin-top:2px">Issued ${fmtDate(new Date().toISOString().slice(0, 10))}</div>
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
      <div style="font-size:8.5px;letter-spacing:.07em;text-transform:uppercase;opacity:.7">Balance due</div>
      <div style="font-size:24px;font-weight:800;letter-spacing:-.02em;margin-top:2px">${money(statement.closingBalance)}</div>
      <div style="font-size:9px;opacity:.75;margin-top:4px">${statement.invoiceCount} invoice${statement.invoiceCount === 1 ? '' : 's'} this period</div>
    </div>
  </div>

  <table style="margin-bottom:18px;border:1px solid #e8edf3;border-radius:9px;overflow:hidden">
    <tr>
      <td style="padding:9px 12px;background:#f8fafc">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Opening balance</div>
        <div style="font-size:13px;font-weight:700;margin-top:2px">${money(statement.openingBalance)}</div>
      </td>
      <td style="padding:9px 12px;background:#f8fafc;border-left:1px solid #e8edf3">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Invoiced</div>
        <div style="font-size:13px;font-weight:700;margin-top:2px">${money(statement.totalBilled)}</div>
      </td>
      <td style="padding:9px 12px;background:#f8fafc;border-left:1px solid #e8edf3">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Received</div>
        <div style="font-size:13px;font-weight:700;color:#047857;margin-top:2px">${money(statement.totalReceived)}</div>
      </td>
      <td style="padding:9px 12px;background:${NAVY}0d;border-left:1px solid #e8edf3">
        <div style="font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Closing balance</div>
        <div style="font-size:13px;font-weight:800;margin-top:2px">${money(statement.closingBalance)}</div>
      </td>
    </tr>
  </table>

  ${opts.summaryOnly || !statement.rows.length ? '' : `
  <table style="margin-bottom:18px">
    <thead><tr>
      <th style="width:62px">Date</th><th style="width:96px">Reference</th><th>Description</th>
      <th style="text-align:right;width:82px">Invoiced</th>
      <th style="text-align:right;width:82px">Received</th>
      <th style="text-align:right;width:88px">Balance</th>
    </tr></thead>
    <tbody>${ledgerRows}</tbody>
    <tfoot><tr>
      <td colspan="3" style="padding:9px 8px;font-size:10px;font-weight:700;text-align:right;border-top:1.5px solid ${NAVY}">Period totals</td>
      <td style="padding:9px 8px;font-size:10px;font-weight:700;text-align:right;border-top:1.5px solid ${NAVY}">${money(statement.totalBilled)}</td>
      <td style="padding:9px 8px;font-size:10px;font-weight:700;text-align:right;color:#047857;border-top:1.5px solid ${NAVY}">${money(statement.totalReceived)}</td>
      <td style="padding:9px 8px;font-size:11px;font-weight:800;text-align:right;border-top:1.5px solid ${NAVY}">${money(statement.closingBalance)}</td>
    </tr></tfoot>
  </table>`}

  ${agingCells ? `
  <div style="border:1px solid #e8edf3;border-radius:9px;overflow:hidden;margin-bottom:16px">
    <div style="padding:7px 12px;background:#f8fafc;font-size:9px;letter-spacing:.07em;text-transform:uppercase;color:#475569;font-weight:600;border-bottom:1px solid #e8edf3">
      Outstanding by age &nbsp;·&nbsp; total ${money(statement.totalOutstanding)}
    </div>
    <table><tr>${agingCells}</tr></table>
  </div>` : ''}

  ${statement.closingBalance > 0 && companySettings.bank_account_name ? `
  <div style="background:#f8fafc;border:1px solid #e8edf3;border-radius:9px;padding:11px 13px;margin-bottom:14px">
    <div style="font-size:8.5px;letter-spacing:.07em;text-transform:uppercase;color:#94a3b8;margin-bottom:4px">Payment information</div>
    <div style="font-size:10px;color:#334155;line-height:1.7">
      ${companySettings.bank_account_name ? `<div><strong>A/C Holder:</strong> ${esc(companySettings.bank_account_name)}</div>` : ''}
      ${companySettings.bank_account_number ? `<div><strong>A/C No:</strong> ${esc(companySettings.bank_account_number)}</div>` : ''}
      ${companySettings.bank_ifsc ? `<div><strong>IFSC:</strong> ${esc(companySettings.bank_ifsc)}</div>` : ''}
      ${companySettings.bank_name ? `<div><strong>Bank:</strong> ${esc(companySettings.bank_name)}</div>` : ''}
    </div>
  </div>` : ''}

  <div style="text-align:center;font-size:8.5px;color:#94a3b8;padding-top:10px;border-top:1px solid #eef2f7">
    This statement reflects all invoices and payments recorded up to ${fmtDate(statement.to)}.
    ${statement.closingBalance > 0 ? 'Please settle the balance due at your earliest convenience.' : 'No balance outstanding — thank you.'}
  </div>

</div>
${opts.autoprint ? '<script>window.onload=()=>{window.print()}</script>' : ''}
</body></html>`
}
