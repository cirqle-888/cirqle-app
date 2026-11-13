import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, MessageCircle } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { pendingByClient, pendingTotals, unmatchedListNames, type PendingRequest, type PendingStage } from '@/lib/requests/pending'
import { LISTENER_KEYS, parseGroupList } from '@/lib/whatsapp-listener/rules'

export const dynamic = 'force-dynamic'

/**
 * Pending by client — who is waiting on us, and for how long.
 *
 * One row per client with open requests, the longest unanswered wait first.
 * Read-only, for staff: it never posts anything to a client or to WhatsApp.
 * Same gate as the Requests inbox.
 */

const STAGE_LABEL: Record<PendingStage, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  with_client: 'With client',
}
const STAGE_TINT: Record<PendingStage, string> = {
  not_started: 'bg-blue-500/12 text-blue-700 border-blue-500/25 dark:text-blue-400',
  in_progress: 'bg-green-500/12 text-green-700 border-green-500/25 dark:text-green-400',
  with_client: 'bg-violet-500/12 text-violet-700 border-violet-500/25 dark:text-violet-300',
}

type Embedded = { name: string } | { name: string }[] | null
const embeddedName = (c: Embedded): string | null => (Array.isArray(c) ? c[0]?.name : c?.name) ?? null

interface Row {
  id: string; ref_no: number; title: string; status: string; created_at: string; due_date: string | null
  archived_at: string | null; description: string | null; client_id: string | null; submitter_name: string | null; client: Embedded
}

export default async function PendingByClientPage() {
  const me = await loadCurrentUser().catch(() => null)
  const canView = (me?.isAdmin ?? false) || !!me?.permissions?.has('requests.view')
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()
  const [reqRes, clientsRes, settingsRes] = await Promise.all([
    fetchAll(admin.from('task_requests')
      .select('id, ref_no, title, status, created_at, due_date, archived_at, description, client_id, submitter_name, client:clients(name)')
      .is('archived_at', null)
      .not('status', 'in', '("completed","cancelled","rejected","archived")')),
    admin.from('clients').select('name'),
    admin.from('company_settings').select('value').eq('key', LISTENER_KEYS.groups).maybeSingle(),
  ])

  const requests: PendingRequest[] = ((reqRes.data || []) as Row[]).map(r => ({
    id: r.id, ref_no: r.ref_no, title: r.title, status: r.status, created_at: r.created_at, due_date: r.due_date,
    archived_at: r.archived_at, description: r.description, client_id: r.client_id,
    client_name: embeddedName(r.client), submitter_name: r.submitter_name,
  }))
  const listedNames = [...parseGroupList((settingsRes.data?.value as string | null) ?? '').values()]
  const rows = pendingByClient(requests, listedNames, new Date())
  const totals = pendingTotals(rows)
  const badListNames = unmatchedListNames(listedNames, ((clientsRes.data || []) as { name: string }[]).map(c => c.name))

  return (
    <div className="min-h-screen">
      <Header title="Pending by client" subtitle="Who is waiting on us, longest wait first" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-5xl mx-auto mt-2 space-y-5">
        <Link href="/dashboard/requests" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Requests
        </Link>

        {reqRes.error && (
          <p className="text-xs text-amber-600 dark:text-amber-400">Some requests could not be read, so this list may be incomplete.</p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Clients waiting', value: totals.clients },
            { label: 'Not started', value: totals.notStarted },
            { label: 'In progress', value: totals.inProgress },
            { label: 'With client', value: totals.withClient },
            { label: 'Past due date', value: totals.overdue },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-xl p-4">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{c.label}</p>
              <p className="text-lg font-bold mt-1 tabular-nums">{c.value}</p>
            </div>
          ))}
        </div>

        {badListNames.length > 0 && (
          <p className="text-xs rounded-lg border border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-400 px-3 py-2">
            The WhatsApp listener list names {badListNames.length === 1 ? 'a client' : 'clients'} not found in Cirqle: {badListNames.join(', ')}.
            Requests from {badListNames.length === 1 ? 'that group' : 'those groups'} will arrive without a client until the spelling matches.
          </p>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground bg-card border border-border rounded-xl p-6 text-center">Nothing is pending for any client.</p>
        ) : (
          <div className="space-y-2">
            {rows.map(c => (
              <details key={c.key} className="group bg-card border border-border rounded-xl open:shadow-sm">
                <summary className="cursor-pointer list-none px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-sm font-medium flex-1 min-w-[160px]">
                    {c.name}
                    {!c.matched && <span className="ml-2 text-[10px] font-normal text-amber-600 dark:text-amber-400">not matched to a client</span>}
                  </span>
                  {c.oldestWaitDays > 0 && c.notStarted > 0 && (
                    <span className={`text-[11px] tabular-nums ${c.oldestWaitDays >= 2 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground'}`}>
                      waiting {c.oldestWaitDays} day{c.oldestWaitDays === 1 ? '' : 's'}
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {c.notStarted} not started · {c.inProgress} in progress · {c.withClient} with client
                  </span>
                  {c.overdue > 0 && <span className="text-[11px] text-red-600 dark:text-red-400 tabular-nums">{c.overdue} past due</span>}
                  {(c.fromWhatsApp > 0 || c.hasListedChat) && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400" title={c.hasListedChat ? 'A WhatsApp chat is listed for this client' : 'Captured from WhatsApp'}>
                      <MessageCircle className="w-3 h-3" />
                      {c.fromWhatsApp > 0 ? `${c.fromWhatsApp} from WhatsApp` : 'group listed'}
                    </span>
                  )}
                </summary>
                <ul className="divide-y divide-border border-t border-border">
                  {c.items.map(i => (
                    <li key={i.id} className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${STAGE_TINT[i.stage]}`}>{STAGE_LABEL[i.stage]}</span>
                      <Link href={`/dashboard/requests?focus=${i.id}`} className="flex-1 min-w-[160px] hover:underline">
                        <span className="text-muted-foreground tabular-nums">{i.ref}</span> {i.title}
                      </Link>
                      {i.fromWhatsApp && <MessageCircle className="w-3 h-3 text-emerald-600 dark:text-emerald-400" aria-label="From WhatsApp" />}
                      {i.overdue && <span className="text-red-600 dark:text-red-400">past due</span>}
                      <span className="text-muted-foreground tabular-nums">{i.daysWaiting === 0 ? 'today' : `${i.daysWaiting}d ago`}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground/70">
          &quot;With client&quot; means the next step is theirs: content missing, a revision asked, or work delivered for review.
          To send a client their status, use Share on the Requests page.
        </p>
      </div>
    </div>
  )
}
