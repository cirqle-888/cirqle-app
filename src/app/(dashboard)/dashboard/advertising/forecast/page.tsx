import React from 'react'
import { getForecastData } from '../actions/ai-actions'
import { ForecastChart } from '../components/ai/ForecastChart'
import { LineChart, CalendarDays } from 'lucide-react'

export const metadata = {
  title: 'Forecast Dashboard | Cirqle',
}

const DEMO_PROJECT_ID = '00000000-0000-0000-0000-000000000000'

export default async function ForecastDashboardPage() {
  const { historical, forecast } = await getForecastData(DEMO_PROJECT_ID)

  // Construct chart dataset merging historical and predicted bounds
  const chartData: any[] = []
  
  if (historical) {
    historical.forEach((h: any) => {
      chartData.push({
        date: h.date,
        historical: h.revenue,
      })
    })
  }

  // If there's forecast data in the AI insight, append it
  if (forecast && Array.isArray(forecast.predicted_data)) {
    forecast.predicted_data.forEach((f: any) => {
      chartData.push({
        date: f.date,
        forecast: f.predicted_value,
        lowerBound: f.lower_bound,
        upperBound: f.upper_bound,
      })
    })
  }

  // Fallback demo data if DB is empty
  const demoData = [
    { date: '2026-06-01', historical: 4000 },
    { date: '2026-06-15', historical: 5500 },
    { date: '2026-06-29', historical: 6200 },
    { date: '2026-07-15', forecast: 7100, lowerBound: 6500, upperBound: 7800 },
    { date: '2026-07-29', forecast: 8500, lowerBound: 7200, upperBound: 9800 },
  ]

  const dataToRender = chartData.length > 0 ? chartData : demoData

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center">
            <LineChart className="w-8 h-8 mr-3 text-indigo-500" />
            Predictive Forecasts
          </h1>
          <p className="text-slate-500 mt-2">
            AI-driven trajectory models for Revenue, Spend, and ROAS.
          </p>
        </div>
        <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
          <button className="px-3 py-1 text-sm font-medium rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white">7D</button>
          <button className="px-3 py-1 text-sm font-medium rounded-md bg-white dark:bg-slate-700 shadow-sm text-slate-900 dark:text-white">30D</button>
          <button className="px-3 py-1 text-sm font-medium rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white">90D</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8">
        <ForecastChart 
          title="Revenue Projection (Holt Linear Trend)"
          metricName="Revenue"
          data={dataToRender}
        />
        {/* Additional charts for Spend/ROAS would go here reusing ForecastChart */}
      </div>
    </div>
  )
}
