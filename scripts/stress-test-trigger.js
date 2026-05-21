#!/usr/bin/env node
/**
 * Cashbook Trigger Stress Test Suite
 * Tests the sync_invoice_payments() PostgreSQL trigger under various conditions.
 * 
 * Run: node scripts/stress-test-trigger.js
 * Requires: @supabase/supabase-js, dotenv installed
 */

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Service role bypasses RLS
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function assert(testName, fn) {
  try {
    await fn()
    console.log(`  ✅ PASS: ${testName}`)
    passed++
  } catch (err) {
    console.error(`  ❌ FAIL: ${testName}`)
    console.error(`     ${err.message}`)
    failed++
  }
}

function assertEqual(label, actual, expected, tolerance = 0.01) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

async function getInvoice(id) {
  const { data } = await supabase.from('invoices').select('paid_amount, status').eq('id', id).single()
  return data
}

async function getAuditCount(invoiceId) {
  const { count } = await supabase
    .from('cashbook_audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('invoice_id', invoiceId)
  return count
}

async function cleanupEntries(ids) {
  if (ids.length === 0) return
  // Hard delete is fine in tests — we're using service role key and cleaning up test data
  const { error } = await supabase.from('cashbook_entries').delete().in('id', ids)
  if (error) console.warn('  ⚠ Cleanup error:', error.message)
}

async function resetInvoice(id, originalPaidAmount, originalStatus) {
  await supabase.from('invoices').update({ paid_amount: 0, status: 'sent' }).eq('id', id)
}

// Find a real invoice to use for testing
async function findTestInvoice() {
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_number, total_amount, paid_amount, status, currency')
    .not('status', 'in', '("cancelled","bad_debt")')
    .gt('total_amount', 100)
    .limit(1)
    .single()
  return data
}

async function findInvoiceCategoryId() {
  const { data } = await supabase
    .from('cashbook_categories')
    .select('id')
    .ilike('name', '%invoice%')
    .limit(1)
    .single()
  return data?.id
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

async function testBasicTrigger(inv, catId) {
  console.log('\n📋 Test 1: Basic INSERT → invoice sync')
  const amount = inv.total_amount * 0.5 // Partial payment

  const { data: entry, error } = await supabase
    .from('cashbook_entries')
    .insert({
      type: 'inflow',
      category_id: catId,
      invoice_id: inv.id,
      amount,
      currency: inv.currency || 'INR',
      amount_inr: amount,
      entry_date: new Date().toISOString().split('T')[0],
      reference: inv.invoice_number,
      description: `[STRESS TEST] Partial payment`,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)

  const updated = await getInvoice(inv.id)
  await assert('paid_amount updated after INSERT', () => {
    assertEqual('paid_amount', updated.paid_amount, amount)
  })
  await assert('status changed to partial', () => {
    if (updated.status !== 'partial') throw new Error(`Status is ${updated.status}`)
  })

  // Cleanup
  await cleanupEntries([entry.id])
  return entry.id
}

async function testFullPayment(inv, catId) {
  console.log('\n📋 Test 2: Full payment → status becomes paid')
  const amount = inv.total_amount

  const { data: entry, error } = await supabase
    .from('cashbook_entries')
    .insert({
      type: 'inflow',
      category_id: catId,
      invoice_id: inv.id,
      amount,
      currency: inv.currency || 'INR',
      amount_inr: amount,
      entry_date: new Date().toISOString().split('T')[0],
      reference: inv.invoice_number,
      description: `[STRESS TEST] Full payment`,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)

  const updated = await getInvoice(inv.id)
  await assert('paid_amount equals total_amount', () => {
    assertEqual('paid_amount', updated.paid_amount, amount)
  })
  await assert('status changed to paid', () => {
    if (updated.status !== 'paid') throw new Error(`Status is ${updated.status}, expected paid`)
  })

  await cleanupEntries([entry.id])
}

async function testSoftDelete(inv, catId) {
  console.log('\n📋 Test 3: Soft-delete → invoice reverts')
  const amount = inv.total_amount

  const { data: entry } = await supabase
    .from('cashbook_entries')
    .insert({
      type: 'inflow', category_id: catId, invoice_id: inv.id,
      amount, currency: inv.currency || 'INR', amount_inr: amount,
      entry_date: new Date().toISOString().split('T')[0],
      reference: inv.invoice_number, description: `[STRESS TEST] Soft-delete test`,
    })
    .select().single()

  const afterInsert = await getInvoice(inv.id)
  await assert('invoice is paid after insert', () => {
    if (afterInsert.status !== 'paid') throw new Error(`Status is ${afterInsert.status}`)
  })

  // Soft-delete
  await supabase.from('cashbook_entries').update({ deleted_at: new Date().toISOString() }).eq('id', entry.id)

  const afterDelete = await getInvoice(inv.id)
  await assert('paid_amount reverts to 0 after soft-delete', () => {
    assertEqual('paid_amount after soft-delete', afterDelete.paid_amount, 0)
  })
  await assert('status reverts after soft-delete', () => {
    if (afterDelete.status === 'paid') throw new Error('Status should not be paid with no active payments')
  })

  await cleanupEntries([entry.id])
}

async function testBatchInsert(inv, catId) {
  console.log('\n📋 Test 4: Batch INSERT (5 sequential payments) → correct total')
  const perPayment = inv.total_amount / 5
  const insertedIds = []

  for (let i = 0; i < 5; i++) {
    const { data: entry } = await supabase
      .from('cashbook_entries')
      .insert({
        type: 'inflow', category_id: catId, invoice_id: inv.id,
        amount: perPayment, currency: inv.currency || 'INR', amount_inr: perPayment,
        entry_date: new Date().toISOString().split('T')[0],
        reference: inv.invoice_number, description: `[STRESS TEST] Batch ${i + 1}/5`,
      })
      .select().single()
    insertedIds.push(entry.id)
  }

  const final = await getInvoice(inv.id)
  await assert('paid_amount equals sum of 5 payments', () => {
    assertEqual('paid_amount', final.paid_amount, inv.total_amount)
  })
  await assert('status is paid after 5 payments', () => {
    if (final.status !== 'paid') throw new Error(`Status is ${final.status}`)
  })

  await cleanupEntries(insertedIds)
}

async function testConcurrentInserts(inv, catId) {
  console.log('\n📋 Test 5: Concurrent INSERT (5 parallel) → no lost updates')
  const perPayment = Math.floor(inv.total_amount / 5)

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      supabase.from('cashbook_entries').insert({
        type: 'inflow', category_id: catId, invoice_id: inv.id,
        amount: perPayment, currency: inv.currency || 'INR', amount_inr: perPayment,
        entry_date: new Date().toISOString().split('T')[0],
        reference: inv.invoice_number, description: `[STRESS TEST] Concurrent ${i + 1}/5`,
      }).select().single()
    )
  )

  const ids = results.map(r => r.data?.id).filter(Boolean)
  await new Promise(r => setTimeout(r, 500)) // brief wait for trigger propagation

  const final = await getInvoice(inv.id)
  const expectedSum = perPayment * ids.length
  await assert('paid_amount correct after concurrent inserts', () => {
    assertEqual('paid_amount', final.paid_amount, expectedSum, 1)
  })

  await cleanupEntries(ids)
}

async function testAuditLog(inv, catId) {
  console.log('\n📋 Test 6: Audit log records events')
  const before = await getAuditCount(inv.id)
  
  const { data: entry } = await supabase
    .from('cashbook_entries')
    .insert({
      type: 'inflow', category_id: catId, invoice_id: inv.id,
      amount: 100, currency: inv.currency || 'INR', amount_inr: 100,
      entry_date: new Date().toISOString().split('T')[0],
      reference: inv.invoice_number, description: `[STRESS TEST] Audit log test`,
    })
    .select().single()

  await new Promise(r => setTimeout(r, 300))
  const after = await getAuditCount(inv.id)

  await assert('audit log gained at least 1 row after INSERT', () => {
    if (after <= before) throw new Error(`Audit count: before=${before}, after=${after}`)
  })

  await cleanupEntries([entry.id])
}

async function testDuplicateImport(inv, catId) {
  console.log('\n📋 Test 7: Duplicate import resilience (same amount, date, reference x2)')
  const amount = inv.total_amount / 2
  const rows = Array.from({ length: 2 }, () => ({
    type: 'inflow', category_id: catId, invoice_id: inv.id,
    amount, currency: inv.currency || 'INR', amount_inr: amount,
    entry_date: new Date().toISOString().split('T')[0],
    reference: inv.invoice_number, description: `[STRESS TEST] Duplicate import`,
  }))

  const { data: entries } = await supabase.from('cashbook_entries').insert(rows).select()
  const ids = (entries || []).map(e => e.id)

  const final = await getInvoice(inv.id)
  await assert('both duplicate rows saved (paid_amount = amount x2)', () => {
    assertEqual('paid_amount', final.paid_amount, amount * 2)
  })
  await assert('2 entries inserted', () => {
    if (ids.length !== 2) throw new Error(`Expected 2 entries, got ${ids.length}`)
  })

  await cleanupEntries(ids)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Cashbook Trigger Stress Test Suite')
  console.log('=====================================')
  console.log(`Project: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log('⚠️  Tests use a real linked invoice. All entries are cleaned up after each test.\n')

  const inv = await findTestInvoice()
  if (!inv) {
    console.error('❌ No suitable "sent" invoice found with total_amount > 100. Create one first.')
    process.exit(1)
  }
  const catId = await findInvoiceCategoryId()
  if (!catId) {
    console.error('❌ No "invoice" cashbook category found.')
    process.exit(1)
  }

  console.log(`📄 Using test invoice: ${inv.invoice_number} (total=${inv.total_amount} ${inv.currency})`)
  console.log(`📂 Using category_id: ${catId}`)

  // Reset to known state
  const initialPaid = inv.paid_amount
  await supabase.from('invoices').update({ paid_amount: 0, status: 'sent' }).eq('id', inv.id)

  await testBasicTrigger({ ...inv, paid_amount: 0 }, catId)
  await resetInvoice(inv.id)
  await testFullPayment({ ...inv, paid_amount: 0 }, catId)
  await resetInvoice(inv.id)
  await testSoftDelete({ ...inv, paid_amount: 0 }, catId)
  await resetInvoice(inv.id)
  await testBatchInsert({ ...inv, paid_amount: 0 }, catId)
  await resetInvoice(inv.id)
  await testConcurrentInserts({ ...inv, paid_amount: 0 }, catId)
  await resetInvoice(inv.id)
  await testAuditLog({ ...inv, paid_amount: 0 }, catId)
  await resetInvoice(inv.id)
  await testDuplicateImport({ ...inv, paid_amount: 0 }, catId)

  // Restore invoice to original state
  await supabase.from('invoices').update({ paid_amount: initialPaid, status: inv.status }).eq('id', inv.id)

  console.log('\n=====================================')
  console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
