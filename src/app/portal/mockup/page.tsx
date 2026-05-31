'use client'

// ────────────────────────────────────────────────────────────────
// MOCKUP: Full-row hover gradient UX
// Shows the proposed interaction for every container type
// before any production code is changed.
// ────────────────────────────────────────────────────────────────

const GRAD = 'linear-gradient(135deg,#7c3aed,#60a5fa)'
const SHADOW = '0 4px 20px rgba(124,58,237,0.35)'

// ── Shared hover style ──────────────────────────────────────────
const hoverStyle = `
  .hover-row {
    transition: background 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
    cursor: pointer;
  }
  .hover-row:hover {
    background: ${GRAD};
    box-shadow: ${SHADOW};
  }
  .hover-row:hover,
  .hover-row:hover * {
    color: white !important;
    border-color: rgba(255,255,255,0.15) !important;
  }
  .hover-row:hover > td {
    background: transparent !important;
  }
  /* Keep status badge backgrounds visible */
  .hover-row:hover .badge {
    background: rgba(255,255,255,0.2) !important;
  }
`

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </div>
  )
}

export default function MockupPage() {
  return (
    <>
      <style>{hoverStyle}</style>
      <div className="min-h-screen bg-background p-6 space-y-10">
        <div>
          <h1 className="text-foreground text-xl font-bold">Hover Gradient Row — Mockup</h1>
          <p className="text-sm text-muted-foreground mt-1">Hover each row. Purple→blue gradient fills the entire record.</p>
        </div>

        {/* ── A: DIV card (Contributions board, Invoices, Quotations) ── */}
        <Section title="A — DIV Card (Contributions board · Invoices · Quotations)" note="Container is a div/button with rounded-xl — border-radius preserved on hover">
          <div className="border border-border rounded-xl overflow-hidden bg-card divide-y divide-border/30">
            {[
              { id: 'C001', title: 'Homepage Redesign', client: 'Acme Corp', service: 'Web Design', date: '28 May 2026', amount: '₹18,000', status: 'done' },
              { id: 'C002', title: 'Brand Identity Kit', client: 'Beta Studio', service: 'Branding', date: '25 May 2026', amount: '₹12,500', status: 'in_progress' },
              { id: 'C003', title: 'Dashboard Analytics', client: 'Cirqle', service: 'Product', date: '20 May 2026', amount: '₹9,800', status: 'reviewed' },
            ].map(row => (
              <div key={row.id} className="hover-row px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-mono text-muted-foreground bg-foreground/5 border border-foreground/10 px-1.5 py-0.5 rounded badge">{row.id}</span>
                      <p className="font-medium text-sm text-foreground truncate">{row.title}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">{row.client} · {row.service}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-foreground">{row.amount}</p>
                    <p className="text-[10px] text-muted-foreground">{row.date}</p>
                  </div>
                  <span className={`badge shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full ${
                    row.status === 'done' ? 'bg-green-500/20 text-green-400' :
                    row.status === 'reviewed' ? 'bg-blue-500/20 text-blue-400' :
                    'bg-amber-500/20 text-amber-400'
                  }`}>{row.status}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── B: TABLE ROW (Tasks · Cashbook · Payroll) ── */}
        <Section title="B — TABLE ROW · <tr> (Tasks desktop · Cashbook · Payroll)" note="TR cannot have border-radius without restructuring. Gradient fills the row flush. Shadow adds elevation.">
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Task</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Client</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Amount</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {[
                  { code: 'TSK-001', title: 'Homepage Redesign', client: 'Acme Corp', date: '28 May', amount: '₹18,000', status: 'done' },
                  { code: 'TSK-002', title: 'Brand Identity Kit', client: 'Beta Studio', date: '25 May', amount: '₹12,500', status: 'in_progress' },
                  { code: 'TSK-003', title: 'Dashboard Analytics', client: 'Cirqle', date: '20 May', amount: '₹9,800', status: 'reviewed' },
                ].map(row => (
                  <tr key={row.code} className="hover-row">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-muted-foreground badge border border-foreground/10 px-1.5 py-0.5 rounded">{row.code}</span>
                        <span className="font-medium text-foreground">{row.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.client}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{row.date}</td>
                    <td className="px-4 py-3 text-right font-semibold text-foreground">{row.amount}</td>
                    <td className="px-4 py-3">
                      <span className={`badge text-[10px] font-medium px-2 py-0.5 rounded-full ${
                        row.status === 'done' ? 'bg-green-500/20 text-green-400' :
                        row.status === 'reviewed' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-amber-500/20 text-amber-400'
                      }`}>{row.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── C: Expandable card (Quotations) ── */}
        <Section title="C — Expandable Card Header (Quotations)" note="Inner header div gets the hover. Card wrapper keeps rounded corners.">
          <div className="space-y-2">
            {[
              { num: 'QUO-001', client: 'Acme Corp', amount: '₹45,000', status: 'sent' },
              { num: 'QUO-002', client: 'Beta Studio', amount: '₹28,500', status: 'accepted' },
            ].map(row => (
              <div key={row.num} className="border border-border rounded-xl overflow-hidden bg-card">
                <div className="hover-row rounded-xl px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="font-semibold text-sm text-foreground">{row.client}</p>
                      <p className="text-xs text-muted-foreground font-mono">{row.num}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-foreground">{row.amount}</span>
                    <span className={`badge text-[10px] font-medium px-2 py-0.5 rounded-full ${row.status === 'accepted' ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>{row.status}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── D: Reports button-row ── */}
        <Section title="D — Button Row (Reports)" note="Full-width button with grid layout.">
          <div className="border border-border rounded-xl overflow-hidden bg-card divide-y divide-border/30">
            {[
              { title: 'Homepage Redesign', client: 'Acme', date: 'May 2026', hrs: '12h', earn: '₹18,000' },
              { title: 'Brand Kit', client: 'Beta', date: 'May 2026', hrs: '8h', earn: '₹12,500' },
            ].map((row, i) => (
              <button key={i} className="hover-row w-full grid grid-cols-[1fr_80px_80px_100px] gap-2 px-5 py-3 text-left items-center">
                <div>
                  <p className="font-medium text-sm text-foreground">{row.title}</p>
                  <p className="text-xs text-muted-foreground">{row.client}</p>
                </div>
                <p className="text-xs text-muted-foreground text-center">{row.date}</p>
                <p className="text-xs text-muted-foreground text-center">{row.hrs}</p>
                <p className="text-sm font-semibold text-foreground text-right">{row.earn}</p>
              </button>
            ))}
          </div>
        </Section>

        <div className="text-xs text-muted-foreground border border-border/40 rounded-xl p-4 space-y-1">
          <p className="font-semibold text-foreground">Implementation notes</p>
          <p>• DIV/BUTTON containers: add <code className="bg-secondary/40 px-1 rounded">hover-row</code> class — rounds inherited from container.</p>
          <p>• TR containers: add <code className="bg-secondary/40 px-1 rounded">hover-row</code> class — gradient fills row flush (no border-radius without table restructure).</p>
          <p>• Single CSS class in globals.css — no per-module child changes needed.</p>
          <p>• Transition: 160ms ease — smooth, not jarring.</p>
          <p>• Shadow: violet-tinted elevation on hover.</p>
        </div>
      </div>
    </>
  )
}
