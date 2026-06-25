/**
 * Task adapter — an internal to-do. Reuses aiParse for title/client/service/
 * date extraction. Commit goes through the Tasks module's serverSaveTask.
 */
import { aiParse, findClient, normalizeDate } from '@/lib/ai/request-capture'
import type { AdapterContext, CaptureDraft, CaptureInput, DetectedClient, ModuleAdapter } from '../types'

export interface ParsedTask { client?: string; title?: string; service?: string; dueDate?: string }

export function buildTaskDraft(text: string, parsed: ParsedTask, client: DetectedClient | null): CaptureDraft {
  const title = (parsed.title || '').trim() || text.slice(0, 80)
  return {
    type: 'task',
    target: '/dashboard/tasks',
    summary: title,
    client,
    fields: {
      title,
      clientId: client?.id ?? null,
      clientName: client?.name ?? parsed.client ?? null,
      serviceName: parsed.service ?? null,
      date: normalizeDate(parsed.dueDate ?? null),
    },
  }
}

export const taskAdapter: ModuleAdapter = {
  type: 'task',
  async prepare(input: CaptureInput, _classification, ctx: AdapterContext): Promise<CaptureDraft> {
    const text = input.payload.trim()
    const parsed = await aiParse(text)
    let client = ctx.client
    if (!client && parsed.client) {
      const hit = await findClient(ctx.admin, parsed.client)
      if (hit) client = { id: hit.id, name: hit.name, matchedBy: 'name' }
    }
    return buildTaskDraft(text, parsed, client)
  },
}
