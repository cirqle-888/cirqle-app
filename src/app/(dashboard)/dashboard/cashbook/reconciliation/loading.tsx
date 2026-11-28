import Header from '@/components/layout/header'

export default function ReconciliationLoading() {
  return (
    <>
      {/* The real top bar, so nothing jumps when the page arrives. */}
      <Header title="Cash Book Checks" />
    <div className="p-4 md:p-6 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 bg-card border border-border rounded-xl animate-pulse" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-11 border-b border-border/40 last:border-0 animate-pulse bg-secondary/20" style={{ animationDelay: `${i * 40}ms` }} />
        ))}
      </div>
    </div>
    </>
  )
}
