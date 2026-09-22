export default function BankReconciliationLoading() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="h-7 w-56 animate-pulse rounded bg-secondary/60" />
      <div className="h-px bg-border" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border border-border bg-card"
            style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, col) => (
          <div key={col} className="overflow-hidden rounded-xl border border-border bg-card">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse border-b border-border/40 bg-secondary/20 last:border-0"
                style={{ animationDelay: `${i * 40}ms` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
