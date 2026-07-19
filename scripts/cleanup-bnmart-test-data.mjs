#!/usr/bin/env node
/**
 * Remove the B.N. Mart test data created while validating the offer-module
 * fixes on 2026-07-18, and unlink the throwaway Google Sheet that was used as
 * a safe push target.
 *
 * DRY RUN BY DEFAULT — prints exactly what it would delete and changes nothing.
 * Pass --confirm to actually apply it.
 *
 *   node scripts/cleanup-bnmart-test-data.mjs
 *   node scripts/cleanup-bnmart-test-data.mjs --confirm
 *
 * Does NOT touch the client's own master Google Sheet or any Figma file.
 */

import { readFileSync } from 'node:fs'

const CONFIRM = process.argv.includes('--confirm')

const TEST_CAMPAIGN_ID = 'f2118f8f-ea3c-4691-a399-bf1c0b9cbc0a'
const BN_MART_CLIENT_ID = 'ff5d227e-f902-4d45-a154-1a7b993171da'
const TEST_PRODUCT_NAMES = ['RLS Test Rice 5kg', 'RLS Test Oil 1L']
// The scratch sheet created purely to have a safe push target during testing.
const THROWAWAY_SHEET_FRAGMENT = '1n-1pEzbolP7RFYbjTQhB6OMlU6WVGB9DLO_PmeKjTzc'

// ── env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = { ...process.env }
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* rely on the ambient environment */ }
  return env
}

const env = loadEnv()
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE
if (!URL_BASE || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : []
}

const plan = []
const note = (msg) => plan.push(msg)

async function main() {
  console.log(CONFIRM ? '── APPLYING cleanup ──\n' : '── DRY RUN (nothing will change) ──\n')

  // 1. The test campaign and everything hanging off it
  // Deliberately does not select `source` — this script must run whether or not
  // the offer-groups migration has been applied.
  const campaigns = await rest(`offer_campaigns?select=id,status,client_id&id=eq.${TEST_CAMPAIGN_ID}`)
  if (!campaigns.length) {
    note('Test campaign: already gone.')
  } else {
    const products = await rest(`offer_products?select=id,name&campaign_id=eq.${TEST_CAMPAIGN_ID}`)
    const logs = await rest(`offer_change_logs?select=id&campaign_id=eq.${TEST_CAMPAIGN_ID}`)
    note(`Test campaign ${TEST_CAMPAIGN_ID} (status=${campaigns[0].status})`)
    note(`  → ${products.length} products: ${products.map(p => p.name).join(', ') || '(none)'}`)
    note(`  → ${logs.length} change-log rows`)

    if (campaigns[0].client_id !== BN_MART_CLIENT_ID) {
      console.error(`\nREFUSING: campaign ${TEST_CAMPAIGN_ID} belongs to a different client than expected.`)
      process.exit(1)
    }

    if (CONFIRM) {
      // offer_product_badges and offer_change_logs cascade from their parents.
      await rest(`offer_products?campaign_id=eq.${TEST_CAMPAIGN_ID}`, { method: 'DELETE' })
      await rest(`offer_change_logs?campaign_id=eq.${TEST_CAMPAIGN_ID}`, { method: 'DELETE' })
      await rest(`offer_campaigns?id=eq.${TEST_CAMPAIGN_ID}`, { method: 'DELETE' })
      note('  ✓ deleted')
    }
  }

  // 2. Catalog mirrors — only if no REAL campaign still references the name.
  for (const name of TEST_PRODUCT_NAMES) {
    const encoded = encodeURIComponent(name)
    const stillUsed = await rest(
      `offer_products?select=id,campaign_id&name=eq.${encoded}&campaign_id=neq.${TEST_CAMPAIGN_ID}`,
    )
    if (stillUsed.length) {
      note(`Catalog "${name}": KEPT — still used by ${stillUsed.length} other product row(s).`)
      continue
    }

    const clientRows = await rest(`client_product_catalog?select=id&client_id=eq.${BN_MART_CLIENT_ID}&name=eq.${encoded}`)
    const globalRows = await rest(`product_catalog?select=id&name=eq.${encoded}`)
    note(`Catalog "${name}": ${clientRows.length} client row(s), ${globalRows.length} global row(s)`)

    if (CONFIRM) {
      for (const row of globalRows) {
        await rest(`product_catalog_images?product_id=eq.${row.id}`, { method: 'DELETE' })
        await rest(`client_product_assignments?product_id=eq.${row.id}`, { method: 'DELETE' })
        await rest(`product_catalog?id=eq.${row.id}`, { method: 'DELETE' })
      }
      if (clientRows.length) {
        await rest(`client_product_catalog?client_id=eq.${BN_MART_CLIENT_ID}&name=eq.${encoded}`, { method: 'DELETE' })
      }
      note('  ✓ deleted')
    }
  }

  // 3. Unlink the throwaway push sheet
  const [client] = await rest(`clients?select=id,name,offer_sheet_url&id=eq.${BN_MART_CLIENT_ID}`)
  if (!client) {
    note('B.N. Mart: client row not found (skipped).')
  } else if (!client.offer_sheet_url) {
    note('B.N. Mart offer_sheet_url: already empty.')
  } else if (!client.offer_sheet_url.includes(THROWAWAY_SHEET_FRAGMENT)) {
    // Someone linked a real sheet since — leave it alone.
    note(`B.N. Mart offer_sheet_url: KEPT (${client.offer_sheet_url}) — not the throwaway test sheet.`)
  } else {
    note(`B.N. Mart offer_sheet_url: clearing the throwaway test sheet`)
    if (CONFIRM) {
      await rest(`clients?id=eq.${BN_MART_CLIENT_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ offer_sheet_url: null }),
      })
      note('  ✓ cleared')
    }
  }

  console.log(plan.join('\n'))
  console.log(
    CONFIRM
      ? '\n✓ Cleanup applied. Next: set B.N. Mart to Pull mode and add their master sheet + categories in Offer Intake settings.'
      : '\nNothing changed. Re-run with --confirm to apply.',
  )
}

main().catch(err => {
  console.error('\nFailed:', err.message)
  process.exit(1)
})
