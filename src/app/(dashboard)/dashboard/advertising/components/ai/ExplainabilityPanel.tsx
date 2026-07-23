'use client'

import React from 'react'
import { X, TrendingUp, AlertTriangle, Info, Target, BarChart2 } from 'lucide-react'
import { RecommendationProps } from './RecommendationCard'

interface ExplainabilityPanelProps {
  rec: RecommendationProps
  onClose: () => void
}

export function ExplainabilityPanel({ rec, onClose }: ExplainabilityPanelProps) {
  return (
    <div className="absolute inset-0 z-10 bg-white/95 dark:bg-slate-950/95 backdrop-blur-sm p-6 overflow-y-auto animate-in slide-in-from-bottom-4 flex flex-col">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-semibold text-lg flex items-center">
          <Info className="w-5 h-5 mr-2 text-indigo-500" /> Explainable AI
        </h3>
        <button onClick={onClose} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="space-y-6 flex-1 text-sm">
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center">
            <AlertTriangle className="w-4 h-4 mr-1 text-amber-500" /> Root Cause Analysis
          </h4>
          <p className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 p-3 rounded-md border border-slate-100 dark:border-slate-800">
            {rec.root_cause || 'The AI detected statistically significant deviations in historical performance.'}
          </p>
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center">
            <Target className="w-4 h-4 mr-1 text-blue-500" /> Suggested Action
          </h4>
          <p className="text-slate-700 dark:text-slate-300">
            {rec.suggested_action || 'Review and apply changes via the campaign manager.'}
          </p>
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center">
            <BarChart2 className="w-4 h-4 mr-1 text-emerald-500" /> Business Impact & Confidence
          </h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-md border border-slate-100 dark:border-slate-800">
              <span className="block text-xs text-slate-500 mb-1">Impact</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">{rec.business_impact || 'Moderate'}</span>
            </div>
            <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-md border border-slate-100 dark:border-slate-800">
              <span className="block text-xs text-slate-500 mb-1">AI Confidence</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">{rec.confidence || 0}%</span>
            </div>
          </div>
        </section>

        {rec.supporting_metrics && (
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center">
              <TrendingUp className="w-4 h-4 mr-1 text-purple-500" /> Supporting Metrics
            </h4>
            <pre className="bg-slate-900 text-slate-300 p-3 rounded-md text-xs overflow-x-auto border border-slate-800">
              {JSON.stringify(rec.supporting_metrics, null, 2)}
            </pre>
          </section>
        )}
      </div>
    </div>
  )
}
