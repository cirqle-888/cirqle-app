import { Database } from 'lucide-react'

/** Shown until the migration is applied. Nothing else in the app changes. */
export function NotInstalled() {
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-6">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 h-5 w-5 text-amber-600" />
        <div className="space-y-2 text-sm">
          <p className="font-semibold">Departments & Brands isn’t set up yet</p>
          <p className="text-muted-foreground">
            Apply <code className="rounded bg-secondary px-1">supabase/migrations/20261127100000_business_units.sql</code>.
            It adds the units, their teams and agreements, invoice assignments and Cash Book tags (Admin-only tables), and
            changes nothing that already exists.
          </p>
        </div>
      </div>
    </div>
  )
}
