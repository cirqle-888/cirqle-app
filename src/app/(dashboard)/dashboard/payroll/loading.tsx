import Header from '@/components/layout/header'

export default function PayrollLoading() {
  return (
    <div>
      {/* The real top bar, so nothing jumps when the page arrives. */}
      <Header title="HR & Payroll" />
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-9 w-24 bg-secondary/40 rounded-lg animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 bg-card border border-border rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-14 border-b border-border/40 last:border-0 animate-pulse">
              <div className="h-full bg-secondary/20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
