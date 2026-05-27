export default function DesignationsLoading() {
  return (
    <div className="md:flex md:h-[calc(100vh-4rem)]">
      {/* List pane */}
      <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-border p-3 space-y-1 md:shrink-0">
        <div className="h-8 w-28 bg-secondary/60 rounded animate-pulse mb-3" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-secondary/40 animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
        ))}
      </div>
      {/* Detail pane */}
      <div className="flex-1 p-4 md:p-6 space-y-4">
        <div className="h-7 w-48 bg-secondary/60 rounded animate-pulse" />
        <div className="h-px bg-border" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 bg-secondary/30 rounded-xl animate-pulse" style={{ animationDelay: `${i * 70}ms` }} />
        ))}
      </div>
    </div>
  )
}
