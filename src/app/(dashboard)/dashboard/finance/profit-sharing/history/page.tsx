import { loadEvents } from '../_data'
import { requireProfitSharingPage } from '../_page'
import { NotInstalled } from '../_not-installed'
import { Card, Empty, Table } from '../_components'
import { td } from '../_format'

export const dynamic = 'force-dynamic'

/** The append-only audit trail (design §11.2). Actors are shown by CQID. */
export default async function HistoryPage() {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />
  const events = await loadEvents(admin, 500)
  const actorIds = [...new Set(events.map(e => e.actorId).filter(Boolean))] as string[]
  const { data: actors } = actorIds.length ? await admin.from('employees').select('id, cqid').in('id', actorIds) : { data: [] }
  const cqid = new Map((actors ?? []).map(a => [a.id, a.cqid]))

  return (
    <Card title="Audit history" subtitle="Every change in Profit Sharing, newest first. This log cannot be edited or deleted. Frozen inputs of each confirmed period are kept with it.">
      {events.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
        <Table head={['When', 'Who', 'What', 'Action', 'Detail']}>
          {events.map(e => (
            <tr key={e.id} className="border-b border-border/60">
              <td className={`${td} whitespace-nowrap`}>{e.at.slice(0, 16).replace('T', ' ')}</td>
              <td className={td}>{e.actorId ? cqid.get(e.actorId) ?? '—' : '—'}</td>
              <td className={td}>{e.entity}</td>
              <td className={td}>{e.action.replace(/_/g, ' ')}</td>
              <td className={`${td} max-w-[360px] truncate font-mono text-[11px] text-muted-foreground`}>{e.detail ? JSON.stringify(e.detail) : ''}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
