// Instant skeleton while the dashboard page Server Component fetches data.
// Without this Next.js holds the previous page until the new one is ready,
// which makes navigation feel frozen on slow networks / large payloads.

export default function DashboardLoading() {
  return (
    <div>
      <div className="h-[68px] sm:h-[72px] border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30 px-4 md:px-6 flex items-center">
        <div className="h-5 w-32 bg-secondary/60 rounded animate-pulse" />
      </div>
      <div className="p-4 sm:p-6 space-y-5">
        {/* Period selector skeleton */}
        <div className="h-10 w-64 bg-secondary/40 rounded-lg animate-pulse" />
        {/* Hero card */}
        <div className="h-32 bg-card border border-border rounded-2xl animate-pulse" />
        {/* KPI grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 bg-card border border-border rounded-xl animate-pulse" />
          ))}
        </div>
        {/* Tabs */}
        <div className="h-10 w-80 bg-secondary/40 rounded-xl animate-pulse" />
        {/* Two chart placeholders */}
        <div className="space-y-4">
          <div className="h-52 bg-card border border-border rounded-xl animate-pulse" />
          <div className="h-44 bg-card border border-border rounded-xl animate-pulse" />
        </div>
      </div>
    </div>
  )
}
