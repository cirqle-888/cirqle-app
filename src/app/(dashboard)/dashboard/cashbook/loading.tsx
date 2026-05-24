export default function CashbookLoading() {
  return (
    <div>
      <div className="h-[68px] sm:h-[72px] border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30 px-4 md:px-6 flex items-center">
        <div className="h-5 w-28 bg-secondary/60 rounded animate-pulse" />
      </div>
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
