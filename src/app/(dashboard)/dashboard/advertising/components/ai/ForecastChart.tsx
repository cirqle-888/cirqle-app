'use client'

import React from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, ComposedChart } from 'recharts'

export interface ForecastDataPoint {
  date: string
  historical?: number
  forecast?: number
  lowerBound?: number
  upperBound?: number
}

interface ForecastChartProps {
  data: ForecastDataPoint[]
  metricName: string
  title: string
}

export function ForecastChart({ data, metricName, title }: ForecastChartProps) {
  return (
    <Card className="col-span-full xl:col-span-2 shadow-sm border-slate-200 dark:border-slate-800">
      <CardHeader>
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis 
                dataKey="date" 
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 12, fill: '#64748b' }}
                tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              />
              <YAxis 
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 12, fill: '#64748b' }}
                tickFormatter={(val) => val >= 1000 ? `$${(val/1000).toFixed(1)}k` : `$${val}`}
              />
              <Tooltip 
                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                labelStyle={{ fontWeight: 'bold', color: '#0f172a' }}
              />
              
              {/* Confidence Interval Area */}
              <Area 
                type="monotone" 
                dataKey="upperBound" 
                stroke="none" 
                fill="#818cf8" 
                fillOpacity={0.1} 
              />
              <Area 
                type="monotone" 
                dataKey="lowerBound" 
                stroke="none" 
                fill="#ffffff" 
                fillOpacity={0.1} 
              />

              {/* Forecast Line */}
              <Line 
                type="monotone" 
                dataKey="forecast" 
                stroke="#6366f1" 
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                activeDot={{ r: 6 }}
                name={`${metricName} (Forecast)`}
              />
              
              {/* Historical Line */}
              <Line 
                type="monotone" 
                dataKey="historical" 
                stroke="#0f172a" 
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 6 }}
                name={`${metricName} (Historical)`}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
