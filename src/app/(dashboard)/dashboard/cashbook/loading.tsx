import Header from '@/components/layout/header'

export default function CashbookLoading() {
  return (
    <div>
      {/* The real top bar, so nothing jumps when the page arrives. No title:
          this loading screen also covers this folder's other pages, and a
          fixed one flashed the wrong name over them. */}
      <Header title="" />
      <div className="p-4 sm:p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 bg-card border border-border rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-12 border-b border-border/40 last:border-0 animate-pulse">
              <div className="h-full bg-secondary/20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
