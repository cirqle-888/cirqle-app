// Skeleton while tasks page server data resolves — replaces the prior "frozen
// previous page" gap during navigation.

export default function TasksLoading() {
  return (
    <div>
      <div className="h-[68px] sm:h-[72px] border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30 px-4 md:px-6 flex items-center">
        <div className="h-5 w-24 bg-secondary/60 rounded animate-pulse" />
      </div>
      {/* Toolbar */}
      <div className="border-b border-border/40 px-4 sm:px-6 py-3 sm:py-4 space-y-2">
        <div className="flex gap-2">
          <div className="h-9 flex-1 bg-secondary/40 rounded-xl animate-pulse" />
          <div className="h-9 w-24 bg-secondary/40 rounded-xl animate-pulse" />
          <div className="h-9 w-32 bg-secondary/40 rounded-xl animate-pulse hidden sm:block" />
        </div>
      </div>
      {/* Table rows — desktop */}
      <div className="hidden sm:block p-6">
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-12 border-b border-border/40 last:border-0 animate-pulse">
              <div className="h-full bg-secondary/20" />
            </div>
          ))}
        </div>
      </div>
      {/* Mobile card list */}
      <div className="sm:hidden p-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-20 bg-card border border-border rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  )
}
