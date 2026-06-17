import { createAdminClient } from '@/lib/supabase/admin'
import { renderInvoiceHtml } from '@/lib/invoices/render-html'
import PublicInvoiceView from './public-invoice-view'

import { Metadata } from 'next'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params
  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch { return {} }

  if (!/^[0-9a-f-]{32,40}$/i.test(token)) return {}

  const { data: inv } = await admin
    .from('invoices')
    .select('invoice_number, status, client:clients(name)')
    .eq('public_token', token)
    .maybeSingle()

  if (!inv || ['cancelled', 'bad_debt'].includes(inv.status)) return {}

  const { data: settingsRows } = await admin
    .from('company_settings')
    .select('key, value')
    .in('key', ['company_name', 'logo_url_dark', 'logo_url'])
  
  const settings: Record<string, string> = {}
  ;(settingsRows || []).forEach((s: any) => { settings[s.key] = s.value })

  const companyName = settings.company_name || 'Cirqle Design'
  const logoUrl = `https://app.cirqle.work/api/logo?v=${token}`

  const title = `Invoice ${inv.invoice_number} from ${companyName}`
  const description = `View and download your invoice for ${(inv.client as any)?.name || 'your project'} from ${companyName}.`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [logoUrl],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [logoUrl],
    }
  }
}

// Public, no-login hosted invoice page. Reached via the unguessable
// invoices.public_token (see migration 20260616130000). Middleware allows /i/*.
export default async function PublicInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch { return <Unavailable /> }

  // UUID guard — avoids a malformed-input DB error on junk tokens.
  if (!/^[0-9a-f-]{32,40}$/i.test(token)) return <Unavailable />

  const { data: inv } = await admin
    .from('invoices')
    .select(`
      *,
      client:clients(id, name, code, phone, email, address),
      items:invoice_items(*, task:tasks(id, title, task_date), service:services(id, name)),
      expense_items:invoice_expense_items(*)
    `)
    .eq('public_token', token)
    .maybeSingle()

  // Don't expose cancelled / written-off invoices publicly.
  if (!inv || ['cancelled', 'bad_debt'].includes(inv.status)) return <Unavailable />

  const { data: settingsRows } = await admin.from('company_settings').select('key, value')
  const settings: Record<string, string> = {}
  ;(settingsRows || []).forEach((s: any) => { settings[s.key] = s.value })

  const html = renderInvoiceHtml(inv, settings)
  const companyName = settings.company_name || 'Cirqle Design'

  return (
    <PublicInvoiceView
      html={html}
      invoiceNumber={inv.invoice_number}
      companyName={companyName}
      logoUrl={settings.logo_url_dark || settings.logo_url || ''}
    />
  )
}

function Unavailable() {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b1020', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Invoice not available</h1>
        <p style={{ fontSize: 14, color: '#9ca3af', lineHeight: 1.5 }}>
          This invoice link is invalid or has been withdrawn. Please contact us for an updated link.
        </p>
      </div>
    </div>
  )
}
