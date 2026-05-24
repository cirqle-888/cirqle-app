export default function ContributionsLoading() {
  return (
    <div>
      <div className="h-[68px] sm:h-[72px] border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30 px-4 md:px-6 flex items-center">
        <div className="h-5 w-32 bg-secondary/60 rounded animate-pulse" />
      </div>
      <div className="border-b border-border/40 px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex gap-2">
          <div className="h-9 flex-1 bg-secondary/40 rounded-xl animate-pulse" />
          <div className="h-9 w-24 bg-secondary/40 rounded-xl animate-pulse" />
        </div>
      </div>
      <div className="p-4 sm:p-6 space-y-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-16 bg-card border border-border rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  )
}
