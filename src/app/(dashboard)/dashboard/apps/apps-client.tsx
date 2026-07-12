'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import {
  Inbox, Tag, Settings as SettingsIcon, ArrowRight,
  Sparkles, Link2, Copy, Check, MessageCircle, Users, ExternalLink,
  Megaphone, Shield, ArrowUpRight, BarChart3, CreditCard,
  CheckCircle, Paintbrush, FileText, Image as ImageIcon, Briefcase
} from 'lucide-react'
import { INTAKE_KIND_META } from '@/lib/services/intake'
import { createTypedClient } from '@/lib/supabase/client'
import AppSelect from '@/components/ui/app-select'

// Data models
interface MultiServiceClient {
  id: string; name: string; phone: string | null; hub_token: string; kinds: string[]
  lastActivity: string | null; requestCount: number
}

// ─── 1. Client Hub (Hero Section) ─────────────────────────────────────────────

function ClientHubHero({ clients }: { clients: MultiServiceClient[] }) {
  const [selectedId, setSelectedId] = useState<string>(clients[0]?.id || '')
  const [copied, setCopied] = useState(false)
  const [branding, setBranding] = useState<{ logo_url: string | null; primary_color: string | null } | null>(null)
  
  useEffect(() => {
    if (!selectedId) {
      setBranding(null)
      return
    }
    let isMounted = true
    const fetchBranding = async () => {
      const supabase = createTypedClient()
      const { data } = await supabase.from('client_branding').select('logo_url, primary_color').eq('client_id', selectedId).single()
      if (isMounted) {
        setBranding(data || null)
      }
    }
    fetchBranding()
    return () => { isMounted = false }
  }, [selectedId])

  const selectedClient = clients.find(c => c.id === selectedId)
  const hubUrl = selectedClient ? `${typeof window !== 'undefined' ? window.location.origin : 'https://app.cirqle.work'}/start/${selectedClient.hub_token}` : '#'

  const handleCopy = async () => {
    if (!selectedClient) return
    await navigator.clipboard.writeText(hubUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleOpen = () => {
    if (selectedClient) window.open(hubUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-12 opacity-5 pointer-events-none">
         <Users className="w-64 h-64" />
      </div>

      <div className="p-8 sm:p-10 flex flex-col md:flex-row gap-10 relative z-10">
        <div className="flex-1 space-y-6">
           <div>
             <h2 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
               Client Hub <Sparkles className="w-5 h-5 text-violet-500" />
             </h2>
             <p className="text-base text-muted-foreground mt-2 max-w-lg">
               One secure branded portal for your clients to access every service.
             </p>
           </div>
           
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6">
             <div className="flex items-center gap-2 text-sm text-foreground/80"><Check className="w-4 h-4 text-emerald-500" /> Offer Campaigns</div>
             <div className="flex items-center gap-2 text-sm text-foreground/80"><Check className="w-4 h-4 text-emerald-500" /> Design Requests</div>
             <div className="flex items-center gap-2 text-sm text-foreground/80"><Check className="w-4 h-4 text-emerald-500" /> Advertising</div>
             <div className="flex items-center gap-2 text-sm text-muted-foreground/60"><ArrowRight className="w-4 h-4" /> Future Reports</div>
             <div className="flex items-center gap-2 text-sm text-muted-foreground/60"><ArrowRight className="w-4 h-4" /> Future Billing</div>
             <div className="flex items-center gap-2 text-sm text-muted-foreground/60"><ArrowRight className="w-4 h-4" /> Future Approvals</div>
           </div>

           <div className="flex flex-wrap items-center gap-3 pt-4">
             <button onClick={handleOpen} disabled={!selectedClient} className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-700 transition-colors shadow-sm disabled:opacity-50">
               <ExternalLink className="w-4 h-4" /> Open Client Hub
             </button>
             <button onClick={handleCopy} disabled={!selectedClient} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50">
               {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />} Copy Hub Link
             </button>
             <Link href="/dashboard/settings/workspaces" className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-secondary transition-colors">
               <Paintbrush className="w-4 h-4" /> Manage Branding
             </Link>
           </div>
        </div>

        <div className="w-full md:w-80 shrink-0 flex flex-col gap-4">
          <div className="rounded-xl border border-border/60 bg-secondary/30 p-5 h-full flex flex-col">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
              Preview Client Hub
            </h3>
            
            {clients.length > 0 ? (
              <div className="space-y-4 flex-1">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Select Client</label>
                  <AppSelect value={selectedId} onChange={e => setSelectedId(e.target.value)} className="w-full text-sm">
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </AppSelect>
                </div>

                <div className="pt-4 border-t border-border/50">
                  <div className="text-xs font-medium text-muted-foreground mb-3">Branding Status</div>
                  {branding ? (
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-card border border-border shadow-sm">
                      {branding.logo_url ? (
                        <div className="w-10 h-10 rounded-md bg-secondary/50 flex items-center justify-center overflow-hidden border border-border/50 shrink-0">
                          <img src={branding.logo_url} alt="Logo" className="w-full h-full object-contain" />
                        </div>
                      ) : (
                        <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center border border-border/50 shrink-0">
                          <ImageIcon className="w-4 h-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{selectedClient?.name}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <div className="w-3 h-3 rounded-full border border-border/50 shrink-0" style={{ backgroundColor: branding.primary_color || '#000' }} />
                          <span className="text-[10px] text-muted-foreground font-mono truncate">{branding.primary_color || 'Default'}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center p-4 rounded-lg border border-dashed border-border/80 bg-card text-xs text-muted-foreground text-center">
                      No branding configured
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="py-8 flex-1 flex items-center justify-center text-center text-sm text-muted-foreground">
                No clients currently assigned to Client Hub.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 2. Client Portals ────────────────────────────────────────────────────────

function ClientPortalCard({ 
  title, description, icon: Icon, configHref, count, isMock 
}: { 
  title: string, description: string, icon: any, configHref: string, count: number, isMock?: boolean 
}) {
  return (
    <div className="rounded-2xl border border-border/80 bg-card p-6 flex flex-col shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground tracking-tight">{title}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Active
              </span>
              <span className="text-[11px] text-muted-foreground">{count} client{count !== 1 ? 's' : ''} enabled</span>
            </div>
          </div>
        </div>
      </div>
      <p className="text-sm text-muted-foreground flex-1 mb-6 leading-relaxed">
        {description}
      </p>
      
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <button disabled={isMock} className="inline-flex justify-center items-center gap-1.5 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50">
            <Link2 className="w-3.5 h-3.5" /> Generate Link
          </button>
          <button disabled={isMock} className="inline-flex justify-center items-center gap-1.5 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50">
            <Copy className="w-3.5 h-3.5" /> Copy Link
          </button>
        </div>
        <div className="flex items-center justify-between pt-3 border-t border-border/50">
           <button disabled={isMock} className="text-xs font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors disabled:opacity-50">
             Open Portal <ArrowUpRight className="w-3 h-3" />
           </button>
           <Link href={configHref} className="text-xs font-medium text-violet-600 dark:text-violet-400 hover:text-violet-700 inline-flex items-center gap-1 transition-colors">
             <SettingsIcon className="w-3 h-3" /> Configuration
           </Link>
        </div>
      </div>
    </div>
  )
}

// ─── 3. Internal Modules ──────────────────────────────────────────────────────

const INTERNAL_MODULES = [
  { label: 'Advertising ERP', description: 'Internal campaign management, budget tracking, and meta integration.', href: '/dashboard/advertising', icon: BarChart3 },
  { label: 'Internal Operations', description: 'Task routing, billing, and internal project state.', href: '/dashboard/tasks', icon: Briefcase },
  { label: 'Admin Modules', description: 'User management, permissions, and internal configuration.', href: '/dashboard/settings', icon: Shield },
]

function InternalModules() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
      {INTERNAL_MODULES.map(mod => (
        <Link key={mod.label} href={mod.href} className="group rounded-xl border border-border/60 bg-secondary/20 p-5 hover:bg-secondary/40 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-lg bg-foreground/5 text-foreground group-hover:bg-foreground/10 transition-colors">
              <mod.icon className="w-4 h-4" />
            </div>
            <h4 className="text-sm font-semibold text-foreground">{mod.label}</h4>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{mod.description}</p>
        </Link>
      ))}
    </div>
  )
}

// ─── 4. Coming Soon ───────────────────────────────────────────────────────────

const COMING_SOON = [
  { label: 'Client Reports', icon: FileText },
  { label: 'Approvals', icon: CheckCircle },
  { label: 'Billing Portal', icon: CreditCard },
  { label: 'Brand Guidelines', icon: Paintbrush },
  { label: 'Campaign Dashboard', icon: BarChart3 },
  { label: 'Feedback Center', icon: MessageCircle },
]

function ComingSoon() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
      {COMING_SOON.map(mod => (
        <div key={mod.label} className="rounded-xl border border-dashed border-border/50 bg-secondary/10 p-5 opacity-70 flex flex-col items-center text-center select-none">
          <mod.icon className="w-5 h-5 text-muted-foreground mb-3" />
          <h4 className="text-xs font-medium text-foreground mb-1.5">{mod.label}</h4>
          <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground px-2 py-0.5 rounded-full bg-secondary border border-border/50">Coming Soon</span>
        </div>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AppsClient({ clientCounts, multiServiceClients = [] }: { clientCounts: Record<string, number>; multiServiceClients?: MultiServiceClient[] }) {
  return (
    <div className="min-h-screen pb-20">
      <Header
        title="Portals & Apps"
        subtitle="Manage client-facing touchpoints, internal operations, and enterprise intake flows."
      />
      <div className="px-4 sm:px-6 lg:px-8 max-w-[1400px] mx-auto mt-6 space-y-14">
        
        {/* 1. Client Hub (Hero Section) */}
        <section>
          <ClientHubHero clients={multiServiceClients} />
        </section>

        {/* 2. Client Portals */}
        <section className="space-y-5">
          <div>
             <h2 className="text-lg font-semibold text-foreground tracking-tight">Client Portals</h2>
             <p className="text-sm text-muted-foreground mt-1">Individual secure intake links shared directly with clients.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <ClientPortalCard
               title="Offer Campaign Intake"
               description={INTAKE_KIND_META['offer_intake']?.description || 'Supermarket / retail clients submit their offer lists securely.'}
               icon={Tag}
               configHref="/dashboard/apps/offer-intake"
               count={clientCounts['offer_intake'] || 0}
            />
            <ClientPortalCard
               title="Design / Task Request"
               description={INTAKE_KIND_META['request_portal']?.description || 'Clients submit design and standard tasks through the portal.'}
               icon={Inbox}
               configHref="/dashboard/apps/standard-request"
               count={clientCounts['request_portal'] || 0}
            />
            <ClientPortalCard
               title="Advertising Request"
               description="Clients submit new paid media and advertising campaign requests."
               icon={Megaphone}
               configHref="/dashboard/advertising"
               count={clientCounts['advertising_req'] || 0}
               isMock={true}
            />
          </div>
        </section>

        {/* 3. Internal Modules */}
        <section className="space-y-5">
          <div>
             <h2 className="text-lg font-semibold text-foreground tracking-tight">Internal Modules</h2>
             <p className="text-sm text-muted-foreground mt-1">Tools and dashboards for your internal operations team.</p>
          </div>
          <InternalModules />
        </section>

        {/* 4. Coming Soon */}
        <section className="space-y-5 pt-2">
          <div>
             <h2 className="text-lg font-semibold text-foreground tracking-tight">Coming Soon</h2>
             <p className="text-sm text-muted-foreground mt-1">Future modules planned for the Client Hub ecosystem.</p>
          </div>
          <ComingSoon />
        </section>

      </div>
    </div>
  )
}
