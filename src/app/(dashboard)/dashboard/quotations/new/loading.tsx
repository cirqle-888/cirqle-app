import Header from '@/components/layout/header'

export default function QuotationsLoading() {
  return (
    <div>
      {/* The real top bar, so nothing jumps when the page arrives. */}
      <Header title="New Quotation" />
      <div className="p-4 sm:p-6 space-y-4">
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-14 border-b border-border/40 last:border-0 animate-pulse">
              <div className="h-full bg-secondary/20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
