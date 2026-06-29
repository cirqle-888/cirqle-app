'use client'

import React from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Bot, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react'

interface ExecutiveSummaryCardProps {
  summary: string
  title?: string
  confidence?: number
}

export function ExecutiveSummaryCard({ summary, title = "AI Executive Summary", confidence }: ExecutiveSummaryCardProps) {
  return (
    <Card className="bg-gradient-to-br from-indigo-50/50 to-white dark:from-indigo-950/20 dark:to-slate-950 border-indigo-100 dark:border-indigo-900/50">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg font-semibold flex items-center text-indigo-900 dark:text-indigo-300">
            <Bot className="w-5 h-5 mr-2 text-indigo-500" />
            {title}
          </CardTitle>
          {confidence && (
            <span className="text-xs font-medium px-2 py-1 bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded-full">
              {confidence}% Confidence
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="prose prose-sm dark:prose-invert max-w-none text-slate-700 dark:text-slate-300 leading-relaxed">
          {summary || "No executive summary generated yet."}
        </div>
      </CardContent>
    </Card>
  )
}
