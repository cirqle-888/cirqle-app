import React from 'react'
import { getExecutiveSummary } from '../actions/ai-actions'
import { ExecutiveSummaryCard } from '../components/ai/ExecutiveSummaryCard'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { DollarSign, TrendingUp, Activity, BarChart3 } from 'lucide-react'

export const metadata = {
  title: 'Executive Dashboard | Cirqle',
}

// In a real scenario, clientId comes from session/auth
const DEMO_CLIENT_ID = '00000000-0000-0000-0000-000000000000'

export default async function ExecutiveDashboardPage() {
  const { performance, summary } = await getExecutiveSummary(DEMO_CLIENT_ID)

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Executive Analytics</h1>
        <p className="text-slate-500 mt-2">
          High-level macro performance augmented by AI-driven insights.
        </p>
      </div>

      <ExecutiveSummaryCard 
        title={summary?.title} 
        summary={summary?.summary} 
        confidence={summary?.confidence_score} 
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${performance.total_revenue?.toLocaleString() || '0'}</div>
            <p className="text-xs text-slate-500 mt-1">Rolling 30 days</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Spend</CardTitle>
            <Activity className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${performance.total_spend?.toLocaleString() || '0'}</div>
            <p className="text-xs text-slate-500 mt-1">Rolling 30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Profit</CardTitle>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${performance.profit?.toLocaleString() || '0'}</div>
            <p className="text-xs text-slate-500 mt-1">
              {performance.margin ? (performance.margin * 100).toFixed(1) : '0'}% Margin
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">ROAS</CardTitle>
            <BarChart3 className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{performance.roas?.toFixed(2) || '0.00'}x</div>
            <p className="text-xs text-slate-500 mt-1">Return on Ad Spend</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
