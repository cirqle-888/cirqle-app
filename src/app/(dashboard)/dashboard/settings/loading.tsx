export default function SettingsLoading() {
  return (
    <div className="md:flex md:h-[calc(100dvh-73px)]">
      {/* Sidebar skeleton — desktop only */}
      <div className="hidden md:block w-52 border-r border-border p-3 space-y-1 shrink-0">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-8 rounded-lg bg-secondary/40 animate-pulse" style={{ animationDelay: `${i * 40}ms` }} />
        ))}
      </div>
      {/* Mobile select skeleton */}
      <div className="md:hidden px-4 py-3 border-b border-border">
        <div className="h-10 w-full bg-secondary/40 rounded-xl animate-pulse" />
      </div>
      {/* Content area */}
      <div className="flex-1 p-4 md:p-6 space-y-4">
        <div className="h-7 w-40 bg-secondary/60 rounded animate-pulse" />
        <div className="h-px bg-border" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 bg-secondary/30 rounded-xl animate-pulse" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    </div>
  )
}
