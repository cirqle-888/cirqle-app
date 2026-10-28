import type { SupabaseClient } from '@supabase/supabase-js'

export interface AdvertisingRate {
  serviceId: string
  type: 'percent'
  value: number
}

/** A zero client rate is intentional; never replace it with the default. */
export function advertisingRate(serviceId: string, defaultPrice: unknown, clientPrice: unknown): AdvertisingRate | null {
  const raw = clientPrice ?? defaultPrice
  if (raw == null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? { serviceId, type: 'percent', value } : null
}

/** Explicitly configured service only: never guess from a service name. */
export async function resolveAutomaticAdvertisingRate(admin: SupabaseClient, clientId: string): Promise<AdvertisingRate | null> {
  const { data: service, error } = await admin.from('services')
    .select('id, default_price').eq('advertising_default', true)
    .eq('is_active', true).eq('pricing_type', 'percentage_of_spend').maybeSingle()
  if (error) throw new Error(`Advertising pricing setup unavailable: ${error.message}`)
  if (!service) return null
  const { data: override, error: pricingError } = await admin.from('client_service_pricing')
    .select('price').eq('client_id', clientId).eq('service_id', service.id).maybeSingle()
  if (pricingError) throw new Error(`Advertising client pricing unavailable: ${pricingError.message}`)
  return advertisingRate(service.id, service.default_price, override?.price)
}

/** Fail closed if invoice history cannot be checked. */
export async function campaignBillingIsLocked(admin: SupabaseClient, projectId: string, taskId?: string): Promise<boolean> {
  const { data: invoices, error } = await admin.from('invoices').select('status').eq('ad_project_id', projectId)
  if (error || invoices?.some(i => i.status !== 'draft')) return true
  if (!taskId) return false
  const { data: items, error: itemError } = await admin.from('invoice_items')
    .select('invoice:invoices(status)').eq('task_id', taskId)
  if (itemError) return true
  return (items ?? []).some(item => {
    const invoice = item.invoice as unknown as { status: string } | { status: string }[] | null
    const rows = Array.isArray(invoice) ? invoice : invoice ? [invoice] : []
    return !rows.length || rows.some(i => i.status !== 'draft')
  })
}
