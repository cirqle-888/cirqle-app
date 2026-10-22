'use server'

/**
 * Device register and valuations (design §8–9).
 *
 * Draft → Calculated → Reviewed → Confirmed → Settled / Reinvested.
 * Nothing before Confirmed has any effect: no cost, no capital, no Cash Book
 * entry, and never a payslip line. Confirming needs an approved device policy
 * (D11); the database refuses it otherwise. A confirmed usage cost counts in
 * the profit period that contains the confirmation date (D14).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  DEVICE_CATEGORIES, DEVICE_CONDITIONS, PROVISIONAL_DEVICE_POLICY, effectiveWindow, usageEvidence, valueTransfer, valueUsage,
  type DeviceCategory, type DeviceCondition, type DeviceFacts, type DevicePolicy,
} from '@/lib/profit-sharing/device'
import { approvedDevicePolicy, loadSettingsVersions, recordEvent, type Admin } from '@/lib/profit-sharing/load'
import { done, fail, guard, isDate, money, text, type Result } from '../_shared'

export async function saveDevice(input: {
  id: string | null; memberId: string; ownership: 'employee_owned' | 'company_owned' | 'transferred'
  category: DeviceCategory; brand: string | null; model: string | null; specs: string | null; serialNumber: string | null
  purchaseDate: string | null; purchasePriceInr: number | null; priceIsEstimated: boolean; condition: DeviceCondition | null
  usageStart: string | null; usageEnd: string | null; purchaseCashbookEntryId: string | null; notes: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  if (!DEVICE_CATEGORIES.includes(input.category)) return { ok: false, error: 'Choose a device category.' }
  if (input.condition && !DEVICE_CONDITIONS.includes(input.condition)) return { ok: false, error: 'Choose a condition.' }
  for (const d of [input.purchaseDate, input.usageStart, input.usageEnd]) {
    if (d && !isDate(d)) return { ok: false, error: 'Enter valid dates.' }
  }
  if (input.usageStart && input.usageEnd && input.usageEnd < input.usageStart) return { ok: false, error: 'Usage cannot end before it starts.' }
  // A device Cirqle paid for is Cirqle's: it can never earn an employee value.
  if (input.purchaseCashbookEntryId && input.ownership === 'employee_owned') {
    return { ok: false, error: 'A device bought with a Cirqle Cash Book payment is company-owned.' }
  }
  const row = {
    member_id: input.memberId, ownership: input.ownership, category: input.category, brand: text(input.brand),
    model: text(input.model), specs: text(input.specs), serial_number: text(input.serialNumber),
    purchase_date: input.purchaseDate || null,
    purchase_price_inr: input.purchasePriceInr == null || input.purchasePriceInr === ('' as unknown) ? null : money(input.purchasePriceInr),
    price_is_estimated: !!input.priceIsEstimated, condition: input.condition || null,
    usage_start: input.usageStart || null, usage_end: input.usageEnd || null,
    purchase_cashbook_entry_id: input.purchaseCashbookEntryId || null, notes: text(input.notes),
    updated_at: new Date().toISOString(),
  }
  const admin = createAdminClient()
  const res = input.id
    ? await admin.from('profit_share_devices').update(row).eq('id', input.id).select('id').single()
    : await admin.from('profit_share_devices').insert({ ...row, created_by: g.actor }).select('id').single()
  if (res.error) return fail(res.error)
  await recordEvent(admin, { actorId: g.actor, entity: 'device', entityId: res.data.id, action: input.id ? 'updated' : 'registered' }).catch(() => {})
  done()
  return { ok: true }
}

export async function addDeviceEvent(input: {
  deviceId: string; kind: string; eventDate: string; costInr: number | null; paidBy: 'employee' | 'company' | 'none' | null; notes: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  if (!isDate(input.eventDate)) return { ok: false, error: 'Enter a valid date.' }
  if (['repair', 'maintenance'].includes(input.kind) && !input.paidBy) return { ok: false, error: 'Say who paid for the repair.' }
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_device_events').insert({
    device_id: input.deviceId, kind: input.kind, event_date: input.eventDate,
    cost_inr: input.costInr == null ? null : money(input.costInr), paid_by: input.paidBy, notes: text(input.notes), created_by: g.actor,
  })
  if (error) return fail(error)
  done()
  return { ok: true }
}

export async function createValuation(input: {
  deviceId: string; kind: 'usage' | 'transfer'; windowStart: string | null; windowEnd: string | null; asOf: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  if (input.kind === 'usage' && (!isDate(input.windowStart) || !isDate(input.windowEnd) || input.windowEnd! < input.windowStart!)) {
    return { ok: false, error: 'Choose a usage window.' }
  }
  if (input.kind === 'transfer' && !isDate(input.asOf)) return { ok: false, error: 'Choose the transfer date.' }
  const admin = createAdminClient()
  const { data: device } = await admin.from('profit_share_devices').select('ownership').eq('id', input.deviceId).maybeSingle()
  if (device?.ownership !== 'employee_owned') {
    return { ok: false, error: 'Only an employee-owned device can be valued. A company-owned device earns no value (case C).' }
  }
  const { data, error } = await admin.from('profit_share_device_valuations').insert({
    device_id: input.deviceId, kind: input.kind, status: 'draft',
    window_start: input.kind === 'usage' ? input.windowStart : null,
    window_end: input.kind === 'usage' ? input.windowEnd : null,
    as_of: input.kind === 'transfer' ? input.asOf : null,
    created_by: g.actor,
  }).select('id').single()
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'valuation', entityId: data.id, action: 'drafted' }).catch(() => {})
  done()
  return { ok: true }
}

/** Tasks the employee worked on in a window, with their service category. */
async function tasksFor(admin: Admin, employeeId: string, start: string, end: string) {
  const [scores, assigned] = await Promise.all([
    admin.from('contribution_scores').select('task_id').eq('employee_id', employeeId),
    admin.from('task_assignments').select('task_id').eq('employee_id', employeeId),
  ])
  const ids = [...new Set([...(scores.data ?? []), ...(assigned.data ?? [])].map(r => r.task_id as string))]
  const tasks: { date: string; serviceId: string | null }[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from('tasks').select('id, task_date, service_id, status')
      .in('id', ids.slice(i, i + 200)).is('deleted_at', null).gte('task_date', start).lte('task_date', end)
    if (error) throw new Error(error.message)
    for (const t of data ?? []) if (t.status !== 'cancelled') tasks.push({ date: String(t.task_date).slice(0, 10), serviceId: t.service_id ?? null })
  }
  const serviceIds = [...new Set(tasks.map(t => t.serviceId).filter(Boolean))] as string[]
  const category = new Map<string, string | null>()
  if (serviceIds.length) {
    const { data } = await admin.from('services').select('id, category_id').in('id', serviceIds)
    for (const s of data ?? []) category.set(s.id, s.category_id ?? null)
  }
  return tasks.map(t => ({ date: t.date, serviceCategoryId: t.serviceId ? category.get(t.serviceId) ?? null : null }))
}

/** Calculate (or recalculate) a draft valuation. Market value needs evidence; a verified share needs a reason. */
export async function calculateValuation(input: {
  valuationId: string; marketValueInr: number | null; marketEvidence: string | null
  verifiedShare: number | null; verifiedReason: string | null
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  if (input.marketValueInr != null && !text(input.marketEvidence)) {
    return { ok: false, error: 'A resale value needs evidence for this device (listings, quotes) — not a new-model price.' }
  }
  if (input.verifiedShare != null) {
    if (!(input.verifiedShare >= 0 && input.verifiedShare <= 1)) return { ok: false, error: 'A verified share is between 0 and 100%.' }
    if (!text(input.verifiedReason)) return { ok: false, error: 'A verified share needs the evidence behind it.' }
  }
  const admin = createAdminClient()
  try {
    const { data: v } = await admin.from('profit_share_device_valuations').select('*').eq('id', input.valuationId).single()
    if (!v || !['draft', 'calculated', 'reviewed'].includes(v.status)) return { ok: false, error: 'This valuation can no longer be recalculated.' }
    const { data: device } = await admin.from('profit_share_devices').select('*').eq('id', v.device_id).single()
    if (!device || device.ownership !== 'employee_owned') return { ok: false, error: 'Only an employee-owned device can be valued.' }
    if (!device.purchase_date || device.purchase_price_inr == null || !device.condition) {
      return { ok: false, error: 'Record the purchase date, price (or estimated replacement price) and condition first.' }
    }
    const { data: member } = await admin.from('profit_share_members')
      .select('employee_id, employee:employees!employee_id(joined_date, archived_at)').eq('id', device.member_id).single()
    const emp = (member as { employee?: { joined_date?: string | null; archived_at?: string | null } | null } | null)?.employee ?? null

    // The approved policy if there is one; otherwise the latest draft, or the
    // provisional values — usable for a draft, never for confirmation.
    const versions = await loadSettingsVersions(admin)
    const approved = approvedDevicePolicy(versions)
    const draft = versions.filter(x => x.devicePolicy).at(-1) ?? null
    const source = approved ?? draft
    const policy: DevicePolicy = source?.devicePolicy ?? PROVISIONAL_DEVICE_POLICY
    const policyStatus = approved ? 'approved' : draft ? 'draft' : 'provisional'

    const facts: DeviceFacts = {
      category: device.category, condition: device.condition, purchaseDate: String(device.purchase_date).slice(0, 10),
      priceInr: Number(device.purchase_price_inr), priceIsEstimated: !!device.price_is_estimated,
      usageStart: device.usage_start ? String(device.usage_start).slice(0, 10) : null,
      usageEnd: device.usage_end ? String(device.usage_end).slice(0, 10) : null,
      joinedDate: emp?.joined_date ? String(emp.joined_date).slice(0, 10) : null,
      exitDate: emp?.archived_at ? String(emp.archived_at).slice(0, 10) : null,
    }
    const market = input.marketValueInr == null ? null : money(input.marketValueInr)

    let update: Record<string, unknown>
    if (v.kind === 'usage') {
      const ws = String(v.window_start).slice(0, 10)
      const we = String(v.window_end).slice(0, 10)
      const win = effectiveWindow(facts, ws, we)
      const tasks = win && member?.employee_id ? await tasksFor(admin, member.employee_id, win.start, win.end) : []
      const evidence = win
        ? usageEvidence({ tasks, policy, category: facts.category, windowStart: win.start, windowEnd: win.end })
        : { availableDays: 0, deviceWorkDays: 0, tasksConsidered: 0, estimatedShare: 0 }
      const { data: events } = await admin.from('profit_share_device_events').select('event_date, cost_inr, paid_by, kind')
        .eq('device_id', device.id).in('kind', ['repair', 'maintenance']).eq('paid_by', 'employee')
      const result = valueUsage({
        facts, policy, windowStart: ws, windowEnd: we, marketValueInr: market,
        estimatedShare: evidence.estimatedShare, verifiedShare: input.verifiedShare,
        employeeRepairs: (events ?? []).map(e => ({ date: String(e.event_date).slice(0, 10), costInr: Number(e.cost_inr ?? 0) })),
      })
      if (result.marketAboveTolerance && !text(input.marketEvidence)) {
        return { ok: false, error: 'The resale value is far above the model value; record the evidence.' }
      }
      update = {
        inputs: { facts, marketValueInr: market, marketEvidence: text(input.marketEvidence), policyStatus, result },
        evidence: { ...evidence, note: 'Task categories suggest the kind of device the work needed; they do not prove which device was used.' },
        usage_basis: result.basis, verified_share: input.verifiedShare, verified_reason: text(input.verifiedReason),
        business_share: result.businessShare, value_used_inr: result.valueUsedInr,
        remaining_life_months: result.remainingLifeMonths, monthly_wear_inr: result.monthlyWearInr, proposed_inr: result.proposedInr,
      }
    } else {
      const result = valueTransfer({ facts, policy, asOf: String(v.as_of).slice(0, 10), marketValueInr: market })
      update = {
        inputs: { facts, marketValueInr: market, marketEvidence: text(input.marketEvidence), policyStatus, result },
        evidence: null, usage_basis: null, business_share: null, value_used_inr: result.proposedInr,
        remaining_life_months: null, monthly_wear_inr: null, proposed_inr: result.proposedInr,
      }
    }
    const { error } = await admin.from('profit_share_device_valuations').update({
      ...update, status: 'calculated', settings_id: approved?.id ?? draft?.id ?? null, policy_snapshot: { policyStatus, policy },
      adjusted_inr: null, adjustment_reason: null, reviewed_by: null, reviewed_at: null,
    }).eq('id', v.id)
    if (error) return fail(error)
    await recordEvent(admin, { actorId: g.actor, entity: 'valuation', entityId: v.id, action: 'calculated', detail: { policyStatus, proposed: update.proposed_inr } })
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

export async function reviewValuation(input: {
  valuationId: string; adjustedInr: number | null; adjustmentReason: string | null; outcome: 'reimburse' | 'purchase' | 'capital' | 'none'
}): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const admin = createAdminClient()
  const { data: v } = await admin.from('profit_share_device_valuations').select('kind, status, proposed_inr').eq('id', input.valuationId).single()
  if (!v || v.status !== 'calculated') return { ok: false, error: 'Calculate the valuation before reviewing it.' }
  const allowed = v.kind === 'usage' ? ['reimburse', 'capital', 'none'] : ['purchase', 'capital', 'none']
  if (!allowed.includes(input.outcome)) return { ok: false, error: 'Choose an outcome.' }
  const adjusted = input.adjustedInr == null ? null : money(input.adjustedInr)
  if (adjusted != null && adjusted !== Number(v.proposed_inr) && !text(input.adjustmentReason)) {
    return { ok: false, error: 'An adjustment needs a recorded reason.' }
  }
  const { error } = await admin.from('profit_share_device_valuations').update({
    adjusted_inr: adjusted, adjustment_reason: text(input.adjustmentReason), outcome: input.outcome,
    status: 'reviewed', reviewed_by: g.actor, reviewed_at: new Date().toISOString(),
  }).eq('id', input.valuationId)
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'valuation', entityId: input.valuationId, action: 'reviewed', detail: { adjusted, outcome: input.outcome } }).catch(() => {})
  done()
  return { ok: true }
}

export async function confirmValuation(valuationId: string): Promise<Result> {
  const g = await guard('approve')
  if (!g.ok) return g
  const admin = createAdminClient()
  const { data: v } = await admin.from('profit_share_device_valuations').select('status').eq('id', valuationId).single()
  if (!v || v.status !== 'reviewed') return { ok: false, error: 'Review the valuation before confirming it.' }
  const { error } = await admin.from('profit_share_device_valuations').update({
    status: 'confirmed', confirmed_by: g.actor, confirmed_at: new Date().toISOString(),
  }).eq('id', valuationId).eq('status', 'reviewed')
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'valuation', entityId: valuationId, action: 'confirmed' })
  done()
  return { ok: true }
}

export async function rejectValuation(valuationId: string): Promise<Result> {
  const g = await guard('manage')
  if (!g.ok) return g
  const admin = createAdminClient()
  const { error } = await admin.from('profit_share_device_valuations').update({ status: 'rejected' })
    .eq('id', valuationId).in('status', ['draft', 'calculated', 'reviewed'])
  if (error) return fail(error)
  await recordEvent(admin, { actorId: g.actor, entity: 'valuation', entityId: valuationId, action: 'rejected' }).catch(() => {})
  done()
  return { ok: true }
}
