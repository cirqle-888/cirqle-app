import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { userCanSee } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import { listPackages } from './actions'
import PackagesClient, { type PackageBilling } from './packages-client'

interface FeeLineRow {
  package_id: string | null
  invoice: {
    id: string; invoice_number: string | null; status: string | null
    total_amount: number | null; amount_paid: number | null
  } | { id: string; invoice_number: string | null; status: string | null
    total_amount: number | null; amount_paid: number | null }[] | null
}

// Progress moves with every task that lands — never cache.
export const dynamic = 'force-dynamic'

/**
 * Packages — what a client has committed to, and how much of it is delivered.
 *
 * The page ships the linked tasks rather than a pre-computed progress figure,
 * so the client re-derives coverage with the same pure function the invoice
 * builder uses (@/lib/packages/progress). One engine, one answer — the old
 * agreements module kept a stored progress figure that drifted from what the
 * invoice actually did.
 */
export default async function PackagesPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || userCanSee(me, PERMS.PACKAGES_VIEW))) redirect('/dashboard')

  // Editing is gated in the server actions too (packages.manage); this only
  // decides whether the UI offers the buttons.
  const canManage = isAdmin || userCanSee(me, PERMS.PACKAGES_MANAGE)

  const admin = createAdminClient()
  const [packagesRes, clientsRes, servicesRes] = await Promise.all([
    listPackages(),
    // ALL clients, not just active ones. `clients` has no deleted_at — it uses
    // is_active — and an archived client must still resolve to a name on a
    // package that already exists. The picker filters to active separately.
    admin.from('clients').select('id, name, code, is_active').order('name'),
    admin.from('services').select('id, name, is_active').order('name'),
  ])

  // Only tasks actually linked to a package. Bounded by the partial index
  // tasks_package_idx, so this stays cheap however large `tasks` grows.
  const { data: linkedTasks } = await admin
    .from('tasks')
    .select('id, package_id, service_id, task_date, task_number, title, status, billing_amount, currency')
    .not('package_id', 'is', null)
    .is('deleted_at', null)
    .order('task_date', { ascending: true })

  // Where each package has actually been billed, and whether that invoice is
  // settled. Archiving is only ever safe once the money is in, so the card has
  // to be able to say so rather than leave it to memory.
  //
  // Degrades silently: pre-migration, `invoice_items.package_id` does not exist
  // and every card simply shows no billing line.
  let billing: PackageBilling[] = []
  try {
    const { data: feeLines } = await admin
      .from('invoice_items')
      .select('package_id, total, invoice:invoices(id, invoice_number, status, total_amount, amount_paid)')
      .not('package_id', 'is', null)

    const byPackage = new Map<string, PackageBilling>()
    for (const row of (feeLines ?? []) as unknown as FeeLineRow[]) {
      const inv = Array.isArray(row.invoice) ? row.invoice[0] : row.invoice
      if (!row.package_id || !inv) continue
      const entry = byPackage.get(row.package_id) ?? {
        packageId: row.package_id, invoices: [], allPaid: true, anyBilled: false,
      }
      // "Paid" means the invoice is settled, not merely marked sent. A partial
      // payment is not paid — treating it as such would archive a package with
      // money still outstanding.
      const paid = inv.status === 'paid'
        || (Number(inv.amount_paid ?? 0) > 0 && Number(inv.amount_paid ?? 0) >= Number(inv.total_amount ?? 0))
      entry.invoices.push({
        id: inv.id,
        number: inv.invoice_number ?? null,
        status: inv.status ?? null,
        paid,
      })
      entry.anyBilled = true
      if (!paid) entry.allPaid = false
      byPackage.set(row.package_id, entry)
    }
    billing = [...byPackage.values()]
  } catch { /* invoice_items.package_id not migrated yet */ }

  return (
    <PackagesClient
      billing={billing}
      initialPackages={packagesRes.ok ? (packagesRes.data ?? []) : []}
      loadError={packagesRes.ok ? null : (packagesRes.error ?? null)}
      clients={(clientsRes.data ?? []) as { id: string; name: string; code: string | null; is_active: boolean | null }[]}
      services={(servicesRes.data ?? []) as { id: string; name: string; is_active: boolean | null }[]}
      linkedTasks={(linkedTasks ?? []) as never[]}
      canManage={canManage}
    />
  )
}
