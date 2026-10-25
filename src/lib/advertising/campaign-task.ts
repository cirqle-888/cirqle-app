import type { SupabaseClient } from '@supabase/supabase-js'
import { nextTaskNumber } from '@/lib/utils/task-code'
import { deriveWorkScope, retryWithoutScope, withoutScope } from '@/lib/finance/classify'
import { todayISO } from '@/lib/utils/local-date'
import { round2 } from '@/lib/calculations/currency'

// Server-only helpers for advertising. Kept out of advertising/actions.ts on
// purpose: everything exported from a 'use server' file becomes an action the
// browser can call, and these take no permission check of their own — their
// callers (createAdProject, the connections mapping) check first.

/** Convert an amount to INR via exchange_rates (mirrors tasks/actions.ts toInr). */
export async function toInr(admin: SupabaseClient, amount: number, currency?: string | null): Promise<number> {
  if (!currency || currency === 'INR') return amount
  const { data } = await admin.from('exchange_rates').select('rate_to_inr').eq('currency', currency).maybeSingle()
  const rate = (data as any)?.rate_to_inr ?? 1
  return round2(amount * rate)
}

/**
 * Create the SINGLE task that represents a campaign's work (replaces the old
 * 7-task checklist). It is a normal Cirqle task — the chosen advertising service
 * drives its contribution parameters, so the work breakdown (setup, creative,
 * media buying, …) is split via Contributions, not separate tasks. Billing =
 * the agency service charge, so team earnings flow from the agency fee (the ad
 * spend is a pass-through, billed separately on the campaign invoice).
 */
export async function createCampaignTask(
  admin: SupabaseClient,
  opts: {
    projectId: string; campaignName: string; clientId: string | null;
    serviceId: string | null; serviceCharge: number; currency: string; employeeId: string;
  },
): Promise<string | null> {
  try {
    const { data: maxRow } = await admin
      .from('tasks').select('task_number')
      .order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    const billingInr = await toInr(admin, opts.serviceCharge, opts.currency)
    const taskRow = {
      task_number: nextTaskNumber((maxRow as any)?.task_number),
      title: opts.campaignName,
      client_id: opts.clientId,
      service_id: opts.serviceId,
      status: 'pending',
      task_date: todayISO(),
      billing_amount: opts.serviceCharge,
      billing_amount_inr: billingInr,
      currency: opts.currency,
      created_by: opts.employeeId,
      scope: deriveWorkScope(opts.clientId),
    }
    const { data: t } = await retryWithoutScope(strip =>
      admin.from('tasks').insert(strip ? withoutScope(taskRow) : taskRow).select('id').single()
    )
    if (!t) return null
    await admin.from('ad_project_tasks').insert({ project_id: opts.projectId, task_id: (t as any).id })
    return (t as any).id
  } catch { return null /* tasks shape differs / transient — campaign still created */ }
}
