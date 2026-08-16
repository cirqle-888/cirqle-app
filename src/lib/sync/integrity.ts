import { createTypedAdminClient } from '@/lib/supabase/server'
import { calculateCommission } from '@/lib/calculations/commission'
import { getEffectivePerformanceRating } from '@/lib/calculations/performance-history'
import { isTaskMonthProtected } from '@/lib/payroll/compute'
import { getInvoiceDateForTaskMonth, toSequenceMonth } from '@/lib/invoices/numbering'
import { fetchAll } from '@/lib/supabase/server'

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01). See currency.ts round2.
import { round2 as r2 } from '@/lib/calculations/currency'
import { resolveEarning, CommissionAgreement } from '@/lib/agreements/resolve-earning'

/**
 * Fallback refresh for tasks that have contribution SCORES but no raw
 * `contributions` rows (e.g. scores entered via CSV score% import). The full
 * engine in recalcTaskCommissions needs raw contributions; without them the
 * stored `earnings_inr` goes stale after a billing/pricing/rating change.
 *
 * This recomputes earnings_inr with the SAME formula the Contribution Analysis
 * report uses — `remainingPool × score% × rating%` from CURRENT billing — so
 * stored earnings (and therefore payroll) match the report.
 *
 * SAFETY: only scores with score_percentage > 0 are touched. Earnings-only
 * imports (score_percentage = 0, a flat rupee amount) are left exactly as-is,
 * so historical imported earnings are never zeroed out.
 */
export async function refreshStoredEarningsFromBilling(taskId: string) {
  const supabase = createTypedAdminClient()

  const { data: task } = await supabase
    .from('tasks')
    .select('id, billing_amount_inr, client_id, service_id, task_date')
    .eq('id', taskId)
    .single()
  if (!task) return { updated: 0, message: 'Task not found' }

  // HISTORICAL EARNINGS PROTECTION — see refreshMonthStoredEarnings.
  // This rewrites contribution_scores for the task's month; if payroll for
  // that month has been paid, the payslip is already issued and the ledger
  // behind it must not move. Fails closed on an unreadable task_date.
  if (await isTaskMonthProtected(supabase as any, task.task_date)) {
    return { updated: 0, message: 'Payroll for this month is finalized — earnings left unchanged' }
  }

  const { data: scores } = await supabase
    .from('contribution_scores')
    .select('employee_id, score_percentage, earnings_inr, is_manual_override')
    .eq('task_id', taskId)
  if (!scores || scores.length === 0) return { updated: 0, message: 'No scores' }

  // Current commission % (pricing matrix), default 50 to mirror the report.
  //
  // HISTORICAL READER CONTRACT — DELIBERATE: no `.eq('is_active', true)`.
  // is_active governs what may be SOLD, never what was EARNED; filtering here
  // would reprice every past task on a deactivated pair to the 50% fallback.
  let matrixPct: number | null = null
  if (task.client_id && task.service_id) {
    const { data: pricing } = await supabase
      .from('client_service_pricing')
      .select('commission_percentage')
      .eq('client_id', task.client_id)
      .eq('service_id', task.service_id)
      .maybeSingle()
    if (pricing?.commission_percentage != null) matrixPct = pricing.commission_percentage
  }
  const commPct = matrixPct ?? 50

  // Tool deductions (Σ active tool fixed_percentage), a flat % off the pool.
  let toolPct = 0
  const { data: taskTools } = await supabase.from('task_tools').select('tool_id').eq('task_id', taskId)
  if (taskTools && taskTools.length) {
    const validToolIds = taskTools.map(t => t.tool_id).filter((id): id is string => id !== null)
    const { data: tools } = await supabase
      .from('tools').select('fixed_percentage, is_active').in('id', validToolIds)
    toolPct = (tools || []).reduce((s, t) => s + (t.is_active !== false ? Number(t.fixed_percentage) || 0 : 0), 0)
  }

  // Current performance ratings for the contributing employees.
  const empIds = Array.from(new Set(scores.map(s => s.employee_id).filter((id): id is string => id !== null)))
  const { data: emps } = await supabase.from('employees').select('id, performance_rating').in('id', empIds)
  const rating = new Map<string, number>()
  for (const e of (emps || [])) rating.set(e.id, Number(e.performance_rating) || 100)

  // Fetch agreements & rates for resolveEarning
  const { data: agreementsData } = await supabase.from('employee_commission_agreements').select('*').in('employee_id', empIds).eq('is_active', true)
  const agreements = (agreementsData || []) as CommissionAgreement[]
  const { data: ratesData } = await supabase.from('exchange_rates').select('currency, rate_to_inr')
  const rates = (ratesData || []).reduce((acc: any, r: any) => ({ ...acc, [r.currency]: Number(r.rate_to_inr) || 1 }), { INR: 1 })

  const pool = (task.billing_amount_inr || 0) * commPct / 100
  const remainingPool = pool * (1 - toolPct / 100)

  let updated = 0
  for (const s of scores) {
    // SAFETY: never recompute earnings-only imports (score% = 0), and never
    // touch manual overrides (same rule as the full engine).
    if (!(s.score_percentage && s.score_percentage > 0)) continue
    if (s.is_manual_override) continue
    
    const normalEarn = r2(remainingPool * (s.score_percentage / 100) * ((rating.get(s.employee_id!) ?? 100) / 100))
    
    const resolved = resolveEarning({
      employeeId: s.employee_id!,
      taskDate: task.task_date!,
      clientId: task.client_id,
      serviceId: task.service_id,
      normalEarning: normalEarn,
      isManualOverride: false,
      agreements,
      billingAmountInr: task.billing_amount_inr || 0,
      remainingPool,
      rates
    })

    if (
      Math.abs((s.earnings_inr || 0) - resolved.earnings_inr) > 0.01 ||
      (s as any).earning_source !== resolved.earning_source ||
      (s as any).agreement_id !== resolved.agreement_id
    ) {
      await supabase.from('contribution_scores')
        .update({ 
          earnings_inr: resolved.earnings_inr,
          earning_source: resolved.earning_source,
          agreement_id: resolved.agreement_id
        })
        .eq('task_id', taskId).eq('employee_id', s.employee_id!)
      updated++
    }
  }

  return { updated, message: `Refreshed ${updated} score(s) from current billing` }
}

/**
 * Automatically recalculates contribution scores for a given task, if raw contributions exist.
 * This should be called whenever a task's billing amount, service_id, or task_date changes.
 */
export async function recalcTaskCommissions(taskId: string, userId?: string) {
  const supabase = createTypedAdminClient()

  // 1. Fetch Task
  const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single()
  if (!task) return { error: 'Task not found' }

  // HISTORICAL EARNINGS PROTECTION — checked HERE, at the entry point, not
  // only in the refreshStoredEarningsFromBilling fallback below. This function
  // has its OWN write path (the contribution_scores upsert further down),
  // which is the branch taken whenever the task has raw contributions — i.e.
  // the common case on every task save. Guarding only the callee left that
  // path wide open for months whose payslips are already paid. Fails CLOSED
  // on an unreadable task_date.
  if (await isTaskMonthProtected(supabase as any, task.task_date)) {
    return { updated: 0, message: 'Payroll for this month is finalized — earnings left unchanged' }
  }

  // 2. Fetch Contributions
  const { data: contribs } = await supabase.from('contributions').select('*').eq('task_id', taskId).gt('value', 0)
  // No raw contributions → fall back to refreshing stored earnings from the
  // current billing (keeps score-only tasks in sync with the report + payroll).
  if (!contribs || contribs.length === 0) {
    return await refreshStoredEarningsFromBilling(taskId)
  }

  // 3. Fetch Reference Data
  const [
    employeesRes, groupsRes, parametersRes, toolsRes, toolServicesRes, groupServicesRes, pricingRes, historyRes, taskToolsRes, oldScoresRes, ratesRes, agreementsRes
  ] = await Promise.all([
    supabase.from('employees').select('id, cqid, name, performance_rating, role'),
    // Active-only — the scoring UIs (contributions page, task edit panel) are
    // fed active-only groups/params/tools, so recalcs must use the same set or
    // scores ping-pong between paths once something is archived.
    supabase.from('contribution_groups').select('*').eq('is_active', true),
    supabase.from('parameters').select('*').eq('is_active', true),
    supabase.from('tools').select('*').eq('is_active', true),
    supabase.from('tool_services').select('tool_id, service_id'),
    supabase.from('group_services').select('group_id, service_id'),
    fetchAll(supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage, price, currency').order('client_id').order('service_id')),
    (supabase as any).from('employee_performance_history').select('*').order('effective_from', { ascending: false }),
    supabase.from('task_tools').select('tool_id').eq('task_id', taskId),
    supabase.from('contribution_scores').select('*').eq('task_id', taskId),
    supabase.from('exchange_rates').select('currency, rate_to_inr'),
    supabase.from('employee_commission_agreements').select('*').eq('is_active', true)
  ])

  const employees = employeesRes.data || []
  const groups = groupsRes.data || []
  const parameters = parametersRes.data || []
  const tools = toolsRes.data || []
  const toolServices = toolServicesRes.data || []
  const groupServices = groupServicesRes.data || []
  const pricingMatrix = pricingRes.data || []
  const performanceHistory = historyRes.data || []
  const taskToolsData = taskToolsRes.data || []
  const oldScores = oldScoresRes.data || []
  const agreements = (agreementsRes?.data || []) as CommissionAgreement[]

  const linkedGroupIds = groupServices.filter(gs => gs.service_id === task.service_id).map(gs => gs.group_id)
  const taskGroups = linkedGroupIds.length > 0 ? groups.filter(g => linkedGroupIds.includes(g.id)) : groups
  
  if (linkedGroupIds.length > 0 && taskGroups.length === 0) {
    return { updated: 0, message: 'No active contribution groups for this service — earnings left unchanged' }
  }

  const taskParams = parameters.filter(p => taskGroups.some(g => g.id === p.group_id))

  const pricing = pricingMatrix.find(p => p.client_id === task.client_id && p.service_id === task.service_id)
  const commPct = pricing?.commission_percentage ?? 50
  const rates = (ratesRes?.data || []).reduce((acc: any, r: any) => ({ ...acc, [r.currency]: Number(r.rate_to_inr) || 1 }), { INR: 1 })

  // Fall back to the pricing matrix only when billing hasn't been filled in yet.
  let internalValueInr = task.billing_amount_inr || 0
  if (internalValueInr === 0 && pricing?.price) {
    const qty = task.quantity || 1
    const priceRate = rates[pricing.currency || 'INR'] || 1
    internalValueInr = (pricing.price * qty) * priceRate
  }

  const usedToolIds = new Set(taskToolsData.map(tt => tt.tool_id))
  const linkedToolIds = toolServices.filter(ts => ts.service_id === task.service_id).map(ts => ts.tool_id)
  const taskToolsForCalc = tools
    .filter(t => linkedToolIds.length > 0 ? linkedToolIds.includes(t.id) : true)
    .map(t => ({ tool: t as any, used: usedToolIds.has(t.id) }))

  const effectiveEmployees = employees.map(emp => ({
    ...emp,
    performance_rating: getEffectivePerformanceRating(emp.id, task.task_date, performanceHistory as any, emp.performance_rating || 100)
  }))

  try {
    const result = calculateCommission({
      taskId: task.id,
      billingAmountINR: internalValueInr,
      serviceCommissionPct: commPct,
      employees: effectiveEmployees as any,
      groups: taskGroups as any,
      parameters: taskParams as any,
      toolsUsed: taskToolsForCalc,
      contributions: contribs as any,
    })

    const upsertBatch: any[] = []

    // Calculate remaining pool for agreements (billing - tool deductions)
    const toolPct = taskToolsForCalc.reduce((sum, t) => sum + (t.used ? Number(t.tool.fixed_percentage || 0) : 0), 0)
    const pool = internalValueInr * commPct / 100
    const remainingPool = pool * (1 - toolPct / 100)

    result.employeeEarnings.forEach(e => {
      const oldScore = oldScores.find(s => s.employee_id === e.employeeId)
      
      if (oldScore && oldScore.is_manual_override) return // Do not touch manual overrides

      const resolved = resolveEarning({
        employeeId: e.employeeId,
        taskDate: task.task_date!,
        clientId: task.client_id,
        serviceId: task.service_id,
        normalEarning: e.earnings,
        isManualOverride: false,
        agreements,
        billingAmountInr: internalValueInr,
        remainingPool,
        rates
      })

      if (oldScore) {
        const hasDiff = 
          Math.abs((oldScore.earnings_inr || 0) - resolved.earnings_inr) > 0.01 ||
          Math.abs((oldScore.score_percentage || 0) - e.scorePercentage) > 0.01 ||
          (oldScore as any).earning_source !== resolved.earning_source ||
          (oldScore as any).agreement_id !== resolved.agreement_id

        if (hasDiff) {
          upsertBatch.push({
            task_id: task.id,
            employee_id: e.employeeId,
            score_percentage: e.scorePercentage,
            earnings_inr: resolved.earnings_inr,
            earning_source: resolved.earning_source,
            agreement_id: resolved.agreement_id,
            // Column names must match the table: previous_earnings /
            // previous_performance_rating. The old payload named three columns
            // that do not exist, so every upsert failed PGRST204 — silently,
            // because the error was discarded (see below).
            previous_earnings: oldScore.earnings_inr || 0,
            previous_performance_rating: (oldScore as any).previous_performance_rating ?? null,
            recalculated_at: new Date().toISOString(),
            recalculated_by: userId || null
          })
        }
      } else {
        upsertBatch.push({
          task_id: task.id,
          employee_id: e.employeeId,
          score_percentage: e.scorePercentage,
          earnings_inr: resolved.earnings_inr,
          earning_source: resolved.earning_source,
          agreement_id: resolved.agreement_id,
        })
      }
    })

    if (upsertBatch.length > 0) {
      // The result was previously discarded, so a rejected write reported
      // success and an updatedCount for rows that never changed. Every repair
      // path built on this — the contributions self-heal, payroll
      // recalculation — believed it had fixed earnings it had not.
      const { error: upsertErr } = await supabase
        .from('contribution_scores').upsert(upsertBatch, { onConflict: 'task_id,employee_id' })
      if (upsertErr) {
        console.error('Task recalc upsert failed:', upsertErr)
        return { error: `Failed to save recalculated earnings: ${upsertErr.message}` }
      }
    }

    return { success: true, updatedCount: upsertBatch.length }
  } catch (err) {
    console.error('Task recalc error:', err)
    return { error: 'Failed to calculate commission' }
  }
}

/**
 * Automatically syncs draft invoice items with updated task details.
 * If a task's billing_amount_inr changes, we update the `unit_price` and `total` of linked invoice items,
 * and recalculate the total of the parent draft invoice.
 */
export async function syncDraftInvoices(taskId: string) {
  const supabase = createTypedAdminClient()

  const { data: task } = await supabase.from('tasks')
    .select('id, title, status, client_id, task_date, billing_amount_inr, currency, billing_amount, quantity, deleted_at')
    .eq('id', taskId).single()
  
  if (!task) return { error: 'Task not found' }

  // 1. Find all existing invoice items linked to this task
  const { data: items } = await supabase.from('invoice_items').select('id, invoice_id, quantity').eq('task_id', taskId)
  // `tasks.billing_amount` is the LINE TOTAL (rate × qty) — tasks carry no
  // unit_price column, so the invoice line's rate is derived by dividing back
  // out. Getting this wrong is what made every PDF read "Qty 1 × <total>".
  const taskAmt = task.billing_amount || 0
  const taskQty = Number(task.quantity ?? 1) || 1
  const taskUnitPrice = Math.round((taskAmt / taskQty) * 100) / 100
  const invoiceIdsToRecalculate = new Set<string>()

    if (task.deleted_at || task.status === 'cancelled') {
      // Deleted or cancelled → strip any draft line this task carries, and never add one.
      if (items && items.length > 0) {
        const invoiceIds = Array.from(new Set(items.map(i => i.invoice_id).filter((id): id is string => id !== null)))
        const { data: invoices } = await supabase.from('invoices').select('id').in('id', invoiceIds).eq('status', 'draft')
        const draftInvoiceIds = new Set((invoices || []).map(inv => inv.id))
        for (const item of items) {
          if (item.invoice_id && draftInvoiceIds.has(item.invoice_id)) {
            await supabase.from('invoice_items').delete().eq('id', item.id!)
            invoiceIdsToRecalculate.add(item.invoice_id)
          }
        }
      }
    } else if (items && items.length > 0) {
      // Extract unique invoice IDs
      const invoiceIds = Array.from(new Set(items.map(i => i.invoice_id).filter((id): id is string => id !== null)))
  
      // Find which of these invoices are in 'draft' status
      const { data: invoices } = await supabase.from('invoices').select('id, status').in('id', invoiceIds).eq('status', 'draft')
      if (invoices && invoices.length > 0) {
        const draftInvoiceIds = new Set(invoices.map(inv => inv.id))
        const draftItemsToUpdate = items.filter(i => draftInvoiceIds.has(i.invoice_id!))
      
      for (const item of draftItemsToUpdate) {
        // Update the invoice item with latest task details. quantity/unit_price
        // both come from the task so a qty change on the task is reflected.
        await supabase.from('invoice_items').update({
          description: task.title,
          quantity: taskQty,
          unit_price: taskUnitPrice,
          total: taskAmt,
        }).eq('id', item.id!)
        
        invoiceIdsToRecalculate.add(item.invoice_id!)
      }
    }
  } else if (task.status === 'done' && task.client_id && task.task_date) {
    // 2. Task is done but not on any invoice. Try to add it to an existing draft invoice for this month.
    const fromDateObj = new Date(task.task_date)
    const taskMonth = `${fromDateObj.getFullYear()}-${String(fromDateObj.getMonth() + 1).padStart(2, '0')}`
    const invoiceDate = getInvoiceDateForTaskMonth(taskMonth)
    const sequenceMonth = toSequenceMonth(invoiceDate)

    const { data: draftInvoice } = await supabase
      .from('invoices')
      .select('id')
      .eq('client_id', task.client_id)
      .eq('status', 'draft')
      .like('invoice_number', `INV-${sequenceMonth}-%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (draftInvoice) {
      // Determine the next display order
      const { data: existingItemsInInv } = await supabase.from('invoice_items').select('display_order').eq('invoice_id', draftInvoice.id)
      const nextOrder = existingItemsInInv?.length ? Math.max(...existingItemsInInv.map(i => i.display_order || 0)) + 1 : 0
      
      const { error } = await supabase.from('invoice_items').insert({
        invoice_id: draftInvoice.id,
        task_id: task.id,
        description: task.title,
        quantity: taskQty,
        unit_price: taskUnitPrice,
        total: taskAmt,
        currency: task.currency || 'INR',
        display_order: nextOrder
      })
      
      if (!error) {
        invoiceIdsToRecalculate.add(draftInvoice.id)
      }
    }
  }

  // 3. Recalculate totals for all affected draft invoices
  for (const invId of invoiceIdsToRecalculate) {
    const { data: allItems } = await supabase.from('invoice_items').select('total').eq('invoice_id', invId)
    const { data: allExps } = await supabase.from('invoice_expense_items').select('amount').eq('invoice_id', invId)
    const { data: inv } = await supabase.from('invoices').select('discount_amount, tax_amount, previous_balance').eq('id', invId).single()
    
    const taskTotal = (allItems || []).reduce((sum, it) => sum + (it.total || 0), 0)
    const expTotal = (allExps || []).reduce((sum, e) => sum + (e.amount || 0), 0)
    const discount = inv?.discount_amount || 0
    const tax = inv?.tax_amount || 0
    const prevBal = inv?.previous_balance || 0
    
    const subtotal = r2(taskTotal + expTotal)
    const total_amount = r2(subtotal - discount + tax + prevBal)
    
    await supabase.from('invoices').update({
      subtotal,
      total_amount
    }).eq('id', invId)
  }

  return { success: true, updatedInvoices: invoiceIdsToRecalculate.size }
}

export async function syncDraftInvoiceExpenses(entryId: string) {
  const supabase = createTypedAdminClient()

  // 1. Get the entry
  const { data: entry } = await supabase.from('cashbook_entries')
    .select('id, type, amount, amount_inr, currency, description, client_id, entry_date, deleted_at')
    .eq('id', entryId).single()
    
  const invoiceIdsToRecalculate = new Set<string>()

  // 2. Check if this entry is already an expense item
  const { data: existingExp } = await supabase.from('invoice_expense_items')
    .select('id, invoice_id, amount, amount_inr, currency, original_amount, original_amount_inr, markup_type')
    .eq('cashbook_entry_id', entryId)
    .maybeSingle()

  if (!entry || entry.deleted_at || entry.type !== 'outflow' || !entry.client_id || !entry.entry_date) {
    if (existingExp) {
      const { data: inv } = await supabase.from('invoices').select('status').eq('id', existingExp.invoice_id).single()
      if (inv && inv.status === 'draft') {
        await supabase.from('invoice_expense_items').delete().eq('id', existingExp.id)
        invoiceIdsToRecalculate.add(existingExp.invoice_id)
      }
    }
  } else if (existingExp) {
    const { data: inv } = await supabase.from('invoices').select('status, currency, exchange_rate').eq('id', existingExp.invoice_id).single()
    if (inv && inv.status === 'draft') {
      let newBilling = entry.amount
      let newBillingInr = entry.amount_inr
      
      // If markup was none, we update the billing amount to match the new original amount.
      // But we need to ensure it's in the invoice currency.
      if (entry.currency !== inv.currency) {
          const invRate = inv.exchange_rate || 1
          newBilling = r2(entry.amount_inr / invRate)
      }

      if (existingExp.markup_type !== 'none') {
          // If it had a markup, we don't recalculate the billing amount automatically here
          // to avoid overwriting a custom manual markup value. Just update the original costs.
          newBilling = existingExp.amount
          newBillingInr = existingExp.amount_inr
      }
      
      await supabase.from('invoice_expense_items').update({
        original_amount: entry.amount,
        original_amount_inr: entry.amount_inr,
        amount: newBilling,
        amount_inr: newBillingInr,
        description: entry.description || ''
      }).eq('id', existingExp.id)

      invoiceIdsToRecalculate.add(existingExp.invoice_id)
    }
  } else {
    // 3. Try to add to a draft invoice for this month
    const fromDateObj = new Date(entry.entry_date)
    const entryMonth = `${fromDateObj.getFullYear()}-${String(fromDateObj.getMonth() + 1).padStart(2, '0')}`
    const invoiceDate = getInvoiceDateForTaskMonth(entryMonth)
    const sequenceMonth = toSequenceMonth(invoiceDate)

    const { data: draftInvoice } = await supabase
      .from('invoices')
      .select('id, currency, exchange_rate')
      .eq('client_id', entry.client_id)
      .eq('status', 'draft')
      .like('invoice_number', `INV-${sequenceMonth}-%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (draftInvoice) {
      let billing = entry.amount
      if (entry.currency !== draftInvoice.currency) {
          const invRate = draftInvoice.exchange_rate || 1
          billing = r2(entry.amount_inr / invRate)
      }

      const { error } = await supabase.from('invoice_expense_items').insert({
        invoice_id: draftInvoice.id,
        cashbook_entry_id: entry.id,
        description: entry.description || 'Expense',
        amount: billing,
        amount_inr: entry.amount_inr,
        currency: draftInvoice.currency || 'INR',
        original_amount: entry.amount,
        original_amount_inr: entry.amount_inr,
        markup_type: 'none',
        markup_value: 0,
        markup_amount: 0
      })

      if (!error) {
        invoiceIdsToRecalculate.add(draftInvoice.id)
      }
    }
  }

  // 4. Recalculate total for affected invoices
  for (const invId of invoiceIdsToRecalculate) {
    const { data: allItems } = await supabase.from('invoice_items').select('total').eq('invoice_id', invId)
    const { data: allExps } = await supabase.from('invoice_expense_items').select('amount').eq('invoice_id', invId)
    const { data: inv } = await supabase.from('invoices').select('discount_amount, tax_amount').eq('id', invId).single()
    
    const taskTotal = (allItems || []).reduce((sum, it) => sum + (it.total || 0), 0)
    const expTotal = (allExps || []).reduce((sum, e) => sum + (e.amount || 0), 0)
    const discount = inv?.discount_amount || 0
    const tax = inv?.tax_amount || 0
    
    const subtotal = r2(taskTotal + expTotal)
    const total_amount = r2(subtotal - discount + tax)
    
    await supabase.from('invoices').update({ subtotal, total_amount }).eq('id', invId)
  }

  return { success: true, updatedInvoices: invoiceIdsToRecalculate.size }
}
