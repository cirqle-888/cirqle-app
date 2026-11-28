import Header from '@/components/layout/header'

export default function ReportsLoading() {
  return (
    <div>
      {/* The real top bar, so nothing jumps when the page arrives. No title:
          this loading screen also covers this folder's other pages, and a
          fixed one flashed the wrong name over them. */}
      <Header title="" />
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
