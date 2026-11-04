import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import {
  createRequest, createRequestFromText, duplicateTask, createTask, createExpense, recordPayment,
} from '@/lib/shortcut/actions'

/**
 * Quick-action API for iOS/iPadOS Shortcuts (and any HTTP client).
 *
 * Auth: a single shared secret in the `Authorization: Bearer <token>` header,
 * compared to the `SHORTCUT_API_TOKEN` env var. No Supabase session — runs on
 * the service-role admin client, so the token IS the gate. Keep it secret.
 *
 *   POST /api/shortcut
 *   { "action": "...", ...fields }
 *
 * Actions:
 *   request   { title, client?, notes?, service?, dueDate? }     → Requests inbox
 *   requestAI { text }                                           → AI-parse → inbox
 *   duplicate { taskNumber }                                     → clone task to today
 *   task      { title, client?, service?, amount?, date?, qty? } → create task now
 *   expense   { amount, description?, category?, date? }         → cashbook outflow
 *   payment   { client, amount, date?, bankAccount? }           → cashbook inflow + FIFO allocate
 *
 * Every response is { ok: true, ... } or { ok: false, error }.
 * The handlers live in `src/lib/shortcut/actions.ts`, shared with the MCP server.
 */

const json = (body: unknown, status = 200) => NextResponse.json(body, { status })

/** Constant-ish-time token check. */
function authorized(req: NextRequest): boolean {
  const token = process.env.SHORTCUT_API_TOKEN
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  const got = header.replace(/^Bearer\s+/i, '').trim()
  return got.length > 0 && got === token
}

export async function POST(req: NextRequest) {
  if (process.env.SHORTCUT_API_TOKEN == null) {
    return json({ ok: false, error: 'Shortcut API is disabled (SHORTCUT_API_TOKEN not set).' }, 503)
  }
  if (!authorized(req)) return json({ ok: false, error: 'Unauthorized.' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400) }
  const action = String(body?.action || '').trim()
  const admin = createAdminClient()

  try {
    let result
    switch (action) {
      case 'request':   result = await createRequest(admin, body); break
      case 'requestAI': result = await createRequestFromText(admin, body?.text); break
      case 'duplicate': result = await duplicateTask(admin, body); break
      case 'task':      result = await createTask(admin, body); break
      case 'expense':   result = await createExpense(admin, body); break
      case 'payment':   result = await recordPayment(admin, body); break
      default:          result = { ok: false, error: `Unknown action "${action}". Use: request | requestAI | duplicate | task | expense | payment.` }
    }
    return json(result, result.ok ? 200 : 400)
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'Server error.' }, 500)
  }
}
