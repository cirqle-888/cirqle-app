/**
 * Package reads used outside the Packages page itself.
 *
 * Kept separate from the page's server actions so the task form can ask "does
 * this client have a package on this date?" without importing a `'use server'`
 * module (which would drag the whole write path into the task bundle).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PackageRow } from './types'
import { todayISO } from '@/lib/utils/local-date'

/** The shape the task form needs to offer a choice. */
export interface PackageOption {
  id: string
  name: string
  billingType: PackageRow['billing_type']
  currency: string
  /** NULL → extras bill at the normal Pricing-Matrix price. */
  extraTaskPrice: number | null
  /** Services this package includes — the form warns when the task isn't one. */
  serviceIds: string[]
}

/**
 * Packages a task on `date` could belong to, for this client.
 *
 * Only `active` ones: a paused, completed or cancelled package must not be
 * offered as a destination for new work. Returns [] for a client with none,
 * which is how the task form knows to render nothing at all.
 *
 * Degrades to [] if the tables aren't migrated yet, so the task form keeps
 * working on an environment that hasn't run the packages migration.
 */
export async function activePackagesForClient(
  admin: SupabaseClient,
  clientId: string | null | undefined,
  date: string | null | undefined,
): Promise<PackageOption[]> {
  if (!clientId) return []
  const on = date || todayISO()

  try {
    const { data, error } = await admin
      .from('client_packages')
      .select('id, name, billing_type, currency, extra_task_price, start_date, end_date, items:client_package_items(service_id)')
      .eq('client_id', clientId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .lte('start_date', on)
      .order('created_at', { ascending: false })

    if (error) return []

    return (data ?? [])
      // end_date is nullable, so the "still running" half can't be expressed in
      // the query without excluding open-ended packages. Filtered here instead.
      .filter((p: Record<string, unknown>) => !p.end_date || (p.end_date as string) >= on)
      .map((p: Record<string, unknown>): PackageOption => ({
        id: p.id as string,
        name: p.name as string,
        billingType: p.billing_type as PackageRow['billing_type'],
        currency: p.currency as string,
        extraTaskPrice: (p.extra_task_price as number | null) ?? null,
        serviceIds: ((p.items ?? []) as { service_id: string }[]).map(i => i.service_id),
      }))
  } catch {
    return []
  }
}
