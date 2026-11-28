import Header from '@/components/layout/header'

export default function ImportLoading() {
  return (
    <>
      {/* The real top bar, so nothing jumps when the page arrives. */}
      <Header title="Bulk Import" />
    <div className="p-4 md:p-6 space-y-4 max-w-2xl">
      <div className="h-40 bg-card border border-border rounded-xl animate-pulse" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-12 bg-secondary/30 rounded-xl animate-pulse" style={{ animationDelay: `${i * 60}ms` }} />
      ))}
    </div>
    </>
  )
}
