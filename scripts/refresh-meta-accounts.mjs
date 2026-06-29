/**
 * One-shot script: discovers Meta ad accounts from the stored provider
 * connection and upserts them into Supabase.
 *
 * Run from the project root:
 *   node scripts/refresh-meta-accounts.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Load .env.local ──────────────────────────────────────────────────────────
const root = path.resolve(fileURLToPath(import.meta.url), '../../')
const envPath = path.join(root, '.env.local')
const env = {}
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) env[m[1].trim()] = m[2].trim()
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌  Missing SUPABASE_URL or SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

// ── Minimal Supabase REST helper ─────────────────────────────────────────────
const SB = {
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  },
  async get(table, qs = '') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, { headers: this.headers })
    if (!r.ok) throw new Error(`Supabase GET ${table}: ${await r.text()}`)
    return r.json()
  },
  async upsert(table, body, onConflict) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Supabase UPSERT ${table}: ${await r.text()}`)
    return r.json()
  },
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log('🔍  Loading Meta provider connections from Supabase…')
const conns = await SB.get(
  'provider_connections',
  'provider=eq.meta&select=id,client_id,access_token,status&order=last_auth_at.desc'
)

if (!conns.length) {
  console.error('❌  No Meta provider connection found. Connect Meta Ads first via the Integrations page.')
  process.exit(1)
}

const conn = conns[0]
console.log(`✅  Found connection: ${conn.id}  (client: ${conn.client_id}, status: ${conn.status})`)

if (!conn.access_token) {
  console.error('❌  No access token stored. Reconnect Meta Ads via the Integrations page.')
  process.exit(1)
}

// ── Call Meta Graph API ──────────────────────────────────────────────────────
console.log('📡  Calling Meta Graph API to discover ad accounts…')
const meUrl = `https://graph.facebook.com/v19.0/me/adaccounts?fields=account_id,name,currency,timezone_name,account_status,business&access_token=${conn.access_token}&limit=100`
const meRes = await fetch(meUrl)
const meData = await meRes.json()

if (meData.error) {
  console.error('❌  Meta API error:', meData.error.message)
  if (meData.error.code === 190) {
    console.error('    The access token has expired. Reconnect Meta Ads via the Integrations page.')
  }
  process.exit(1)
}

const accounts = meData.data || []
console.log(`✅  Found ${accounts.length} ad account(s)`)

if (!accounts.length) {
  console.log('ℹ️   No ad accounts found on this Meta account. Make sure ads_management permission was granted.')
  process.exit(0)
}

// ── Upsert into Supabase ─────────────────────────────────────────────────────
console.log('💾  Upserting ad accounts…')
for (const acc of accounts) {
  const isActive = acc.account_status === 1

  // Upsert business if present
  if (acc.business?.id) {
    await SB.upsert('ad_businesses', {
      connection_id: conn.id,
      client_id: conn.client_id,
      business_id: acc.business.id,
      name: acc.business.name || `Business ${acc.business.id}`,
    }, 'connection_id,business_id')
    console.log(`   ↳ Business: ${acc.business.name || acc.business.id}`)
  }

  // Upsert ad account (unique constraint is on provider,account_id)
  await SB.upsert('ad_accounts', {
    connection_id: conn.id,
    client_id: conn.client_id,
    provider: 'meta',
    account_id: acc.account_id,
    name: acc.name,
    currency: acc.currency,
    timezone: acc.timezone_name,
    is_active: isActive,
  }, 'provider,account_id')

  console.log(`   ✓ ${acc.name} (${acc.account_id}) — ${isActive ? 'Active' : 'Inactive'} — ${acc.currency}`)
}

console.log('\n🎉  Done! Refresh the Integrations page in your browser to see the accounts.')
console.log('    Then go to each campaign → Integrations tab → select the ad account → Save Mapping → Sync Now.')
