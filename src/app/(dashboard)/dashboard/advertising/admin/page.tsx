import React from 'react'
import { getAdminAIUsage } from '../actions/ai-actions'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Server, Zap, Coins, Clock } from 'lucide-react'

export const metadata = {
  title: 'AI Admin Dashboard | Cirqle',
}

export default async function AIAdminDashboardPage() {
  const usageData = await getAdminAIUsage()

  // Aggregate metrics
  let totalTokens = 0
  let totalCost = 0
  let avgLatency = 0
  
  if (usageData && usageData.length > 0) {
    totalTokens = usageData.reduce((sum: number, row: any) => sum + (row.total_tokens || 0), 0)
    totalCost = usageData.reduce((sum: number, row: any) => sum + (row.estimated_cost || 0), 0)
    avgLatency = usageData.reduce((sum: number, row: any) => sum + (row.latency_ms || 0), 0) / usageData.length
  }

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center">
          <Server className="w-8 h-8 mr-3 text-slate-700 dark:text-slate-300" />
          AI Platform Telemetry
        </h1>
        <p className="text-slate-500 mt-2">
          Monitor token burn, provider costs, and latency across the LLM orchestration layer.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Token Usage</CardTitle>
            <Zap className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalTokens.toLocaleString()}</div>
            <p className="text-xs text-slate-500 mt-1">Tokens burned</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Estimated AI Cost</CardTitle>
            <Coins className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${totalCost.toFixed(4)}</div>
            <p className="text-xs text-slate-500 mt-1">Based on provider rates</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Average Latency</CardTitle>
            <Clock className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgLatency.toFixed(0)} ms</div>
            <p className="text-xs text-slate-500 mt-1">Response time</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <Server className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{usageData?.length || 0}</div>
            <p className="text-xs text-slate-500 mt-1">Logged inferencing calls</p>
          </CardContent>
        </Card>
      </div>
      
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <h3 className="font-semibold text-sm">Recent LLM Requests</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left text-slate-500 dark:text-slate-400">
            <thead className="text-xs text-slate-700 uppercase bg-slate-50 dark:bg-slate-800/50 dark:text-slate-300">
              <tr>
                <th className="px-6 py-3">Timestamp</th>
                <th className="px-6 py-3">Provider</th>
                <th className="px-6 py-3">Tokens</th>
                <th className="px-6 py-3">Latency (ms)</th>
                <th className="px-6 py-3 text-right">Cost ($)</th>
              </tr>
            </thead>
            <tbody>
              {usageData?.map((row: any, i: number) => (
                <tr key={i} className="bg-white dark:bg-slate-900 border-b dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-6 py-4">{new Date(row.created_at).toLocaleString()}</td>
                  <td className="px-6 py-4 capitalize font-medium">{row.provider}</td>
                  <td className="px-6 py-4">{row.total_tokens?.toLocaleString()}</td>
                  <td className="px-6 py-4">{row.latency_ms}</td>
                  <td className="px-6 py-4 text-right font-medium text-emerald-600 dark:text-emerald-400">${row.estimated_cost?.toFixed(5)}</td>
                </tr>
              ))}
              {(!usageData || usageData.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">No AI telemetry data logged yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
