import { Database } from 'lucide-react'

/** Shown until the migration is applied. Nothing else in the app changes. */
export function NotInstalled() {
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-6">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 h-5 w-5 text-amber-600" />
        <div className="space-y-2 text-sm">
          <p className="font-semibold">Profit Sharing isn’t set up yet</p>
          <p className="text-muted-foreground">
            Apply <code className="rounded bg-secondary px-1">supabase/migrations/20261022100000_profit_sharing.sql</code> in
            the Supabase SQL editor. It adds the profit-sharing tables (Admin only), three permissions and five Cash Book
            categories, and changes nothing that already exists. The checks to run afterwards are in
            {' '}<code className="rounded bg-secondary px-1">supabase/APPLIED.md</code>.
          </p>
        </div>
      </div>
    </div>
  )
}
