'use client'

import React from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'

interface HealthScoreProps {
  score: number
  grade: string
  risk: 'Low' | 'Moderate' | 'High' | 'Critical'
  title?: string
}

export function HealthScoreBadge({ grade, risk }: { grade: string, risk: string }) {
  const colorMap: Record<string, string> = {
    A: 'bg-emerald-500',
    B: 'bg-blue-500',
    C: 'bg-yellow-500',
    D: 'bg-orange-500',
    F: 'bg-red-500',
  }
  return (
    <div className={`w-12 h-12 flex items-center justify-center rounded-full text-white font-bold text-xl ${colorMap[grade] || 'bg-slate-500'}`}>
      {grade}
    </div>
  )
}

export function HealthScoreCard({ score, grade, risk, title = "Overall Health" }: HealthScoreProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start">
          <CardTitle className="text-base font-medium text-slate-600 dark:text-slate-400">{title}</CardTitle>
          <HealthScoreBadge grade={grade} risk={risk} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mt-4">
          <div className="flex justify-between text-sm mb-1">
            <span className="font-medium">Score</span>
            <span className="font-medium">{score}/100</span>
          </div>
          <Progress value={score} className="h-2" />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-slate-500">Risk Level</span>
          <span className={`text-xs font-semibold px-2 py-1 rounded-md ${
            risk === 'Low' ? 'bg-emerald-100 text-emerald-700' :
            risk === 'Moderate' ? 'bg-amber-100 text-amber-700' :
            'bg-red-100 text-red-700'
          }`}>
            {risk}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
