import Header from '@/components/layout/header'

export default function ContributionsLoading() {
  return (
    <div>
      {/* The real top bar, so nothing jumps when the page arrives. No title:
          this loading screen also covers this folder's other pages, and a
          fixed one flashed the wrong name over them. */}
      <Header title="" />
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
