export default function ReportsLoading() {
  return (
    <div>
      <div className="h-[68px] sm:h-[72px] border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30 px-4 md:px-6 flex items-center">
        <div className="h-5 w-40 bg-secondary/60 rounded animate-pulse" />
      </div>
      <div className="p-6 space-y-5">
        <div className="flex gap-2 flex-wrap">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 w-24 bg-card border border-border rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 bg-card border border-border rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="h-56 bg-card border border-border rounded-xl animate-pulse" />
          <div className="h-56 bg-card border border-border rounded-xl animate-pulse" />
        </div>
      </div>
    </div>
  )
}
