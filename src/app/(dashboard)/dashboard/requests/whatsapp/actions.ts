'use server'

/**
 * WhatsApp insights — staff actions. Every one goes through loadChatViewer,
 * so a person only ever touches chats shared with them. Nothing here sends
 * anything to WhatsApp.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { REPORT_TABLE, parseItems } from '@/lib/whatsapp-listener/insights'
import { answerQuestion, loadChatViewer, updateAllReports } from '@/lib/whatsapp-listener/insights-run'

const PATH = '/dashboard/requests/whatsapp'

/** Ticks one pending item off a chat's list. */
export async function markPendingDone(chatId: string, itemId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient()
  const cv = await loadChatViewer(admin)
  if (!cv.me || !cv.visible.has(chatId)) return { ok: false, error: 'This chat is not shared with you.' }
  if (cv.me.isViewAs) return { ok: false, error: 'Preview mode is read-only.' }

  const { data, error } = await admin.from(REPORT_TABLE).select('id, items')
    .eq('chat_id', chatId).order('report_day', { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return { ok: false, error: 'Could not find that item.' }
  const items = parseItems(data.items)
  const next = items.filter(i => i.id !== itemId)
  if (next.length === items.length) return { ok: true } // someone else already ticked it
  const { error: saveError } = await admin.from(REPORT_TABLE)
    .update({ items: next, updated_at: new Date().toISOString() }).eq('id', data.id)
  if (saveError) return { ok: false, error: 'Could not save. Try again.' }
  revalidatePath(PATH, 'layout')
  return { ok: true }
}

/** Reads the new messages now instead of waiting for the evening run. Admins only: it spends AI calls. */
export async function refreshWhatsAppReports(): Promise<{ ok: boolean; error?: string; message?: string }> {
  const admin = createAdminClient()
  const cv = await loadChatViewer(admin)
  if (!cv.me?.isAdmin) return { ok: false, error: 'Only an admin can update the reports by hand.' }
  if (cv.me.isViewAs) return { ok: false, error: 'Preview mode is read-only.' }

  const run = await updateAllReports(admin, { budgetMs: 45_000 })
  revalidatePath(PATH, 'layout')
  if (run.failed && !run.updated) return { ok: false, error: `Could not update: ${run.errors[0] || 'the AI did not answer'}` }
  const parts = [`${run.updated} chat${run.updated === 1 ? '' : 's'} updated`]
  if (run.failed) parts.push(`${run.failed} failed`)
  if (run.outOfTime) parts.push('ran out of time, press again for the rest')
  if (!run.updated && !run.failed) parts[0] = 'No new messages since the last update'
  return { ok: true, message: `${parts.join(', ')}.` }
}

/** Answers a question from the chats the asker may see. The question and answer are not stored. */
export async function askWhatsAppChats(question: string): Promise<{ ok: boolean; error?: string; answer?: string; chats?: string[] }> {
  const admin = createAdminClient()
  const cv = await loadChatViewer(admin)
  if (!cv.me) return { ok: false, error: 'Sign in again.' }
  return answerQuestion(admin, cv, String(question || ''))
}
