import React from 'react'
import { getCampaignHealth } from '../actions/ai-actions'
import { HealthScoreCard } from '../components/ai/HealthScoreCard'
import { Activity } from 'lucide-react'

export const metadata = {
  title: 'Campaign Health | Cirqle',
}

// In a real scenario, projectId comes from URL params or context
const DEMO_PROJECT_ID = '00000000-0000-0000-0000-000000000000'

export default async function HealthDashboardPage() {
  const healthData = await getCampaignHealth(DEMO_PROJECT_ID)
  
  // Extract parsed score components if they exist
  const supporting = healthData?.supporting_metrics || {}

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center">
          <Activity className="w-8 h-8 mr-3 text-emerald-500" />
          Health & Stability
        </h1>
        <p className="text-slate-500 mt-2">
          Diagnostic overview of your campaign's performance, budget pacing, and forecast trajectory.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <HealthScoreCard 
          title="Overall Health"
          score={supporting.overall_score || 85}
          grade={supporting.overall_grade || 'B'}
          risk={supporting.risk_level || 'Low'}
        />
        <HealthScoreCard 
          title="Budget Score"
          score={supporting.budget_score || 90}
          grade={supporting.budget_grade || 'A'}
          risk="Low"
        />
        <HealthScoreCard 
          title="Performance Score"
          score={supporting.performance_score || 75}
          grade={supporting.performance_grade || 'C'}
          risk="Moderate"
        />
        <HealthScoreCard 
          title="Forecast Score"
          score={supporting.forecast_score || 88}
          grade={supporting.forecast_grade || 'B'}
          risk="Low"
        />
      </div>
      
      {healthData?.summary && (
        <div className="mt-8 p-6 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
          <h3 className="font-semibold text-lg mb-2">AI Diagnostic Summary</h3>
          <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
            {healthData.summary}
          </p>
        </div>
      )}
    </div>
  )
}
