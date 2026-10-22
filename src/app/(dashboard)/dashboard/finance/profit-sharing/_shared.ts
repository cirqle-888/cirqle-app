/**
 * Shared by the Profit Sharing server actions. Not a 'use server' file: these
 * are helpers, never callable from the browser on their own.
 */

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { round2 } from '@/lib/calculations/currency'

export type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

export const ROOT = '/dashboard/finance/profit-sharing'
const MIGRATION = 'supabase/migrations/20261022100000_profit_sharing.sql'

/** Permission AND isAdmin: Admin only in this release. */
export async function guard(level: 'manage' | 'approve'):
  Promise<{ ok: true; actor: string } | { ok: false; error: string }> {
  const g = await requirePermission(level === 'approve' ? PERMS.PROFIT_SHARING_APPROVE : PERMS.PROFIT_SHARING_MANAGE)
  if (!g.ok) return g
  if (!g.isAdmin) return { ok: false, error: 'Profit Sharing is Admin-only in this release.' }
  return { ok: true, actor: g.employeeId }
}

function friendly(message: string): string {
  if (/profit_share_\w+.*(does not exist|schema cache)|PGRST205/i.test(message)) {
    return `Profit Sharing needs its database migration. Apply ${MIGRATION} in the Supabase SQL editor first.`
  }
  // Trigger messages are written for people; strip the prefix.
  return message.replace(/^.*?profit sharing: /i, '')
}

export const fail = (e: unknown): { ok: false; error: string } =>
  ({ ok: false, error: friendly(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)) })

export const done = () => revalidatePath(ROOT, 'layout')

const DATE = /^\d{4}-\d{2}-\d{2}$/
export const isDate = (s: unknown): s is string =>
  typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
export const money = (v: unknown) => round2(Number(v))
export const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
