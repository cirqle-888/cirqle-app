'use client'

import React, { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckCircle2, XCircle, AlertTriangle, TrendingUp, HelpCircle } from 'lucide-react'
import { ExplainabilityPanel } from './ExplainabilityPanel'
import { updateRecommendationStatus } from '../../actions/ai-actions'
import { useToast } from '@/components/ui/use-toast'

export interface RecommendationProps {
  id: string
  title: string
  summary: string
  root_cause?: string
  business_impact?: string
  expected_roi?: string
  estimated_savings?: number
  suggested_action?: string
  confidence?: number
  priority: 'low' | 'medium' | 'high' | 'critical'
  status: string
  timeline?: string
  supporting_metrics?: any
}

export function RecommendationCard({ rec }: { rec: RecommendationProps }) {
  const { toast } = useToast()
  const [status, setStatus] = useState(rec.status)
  const [isExplaining, setIsExplaining] = useState(false)

  const handleAction = async (newStatus: 'accepted' | 'dismissed') => {
    try {
      await updateRecommendationStatus(rec.id, newStatus)
      setStatus(newStatus)
      toast({ title: `Recommendation ${newStatus}` })
    } catch (err) {
      toast({ title: 'Failed to update status', variant: 'destructive' })
    }
  }

  const priorityColors = {
    low: 'bg-slate-100 text-slate-700',
    medium: 'bg-blue-100 text-blue-700',
    high: 'bg-orange-100 text-orange-700',
    critical: 'bg-red-100 text-red-700',
  }

  return (
    <Card className={`relative overflow-hidden transition-all duration-300 ${status === 'dismissed' ? 'opacity-50 grayscale' : 'hover:shadow-lg'}`}>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start">
          <CardTitle className="text-lg font-semibold tracking-tight">{rec.title}</CardTitle>
          <Badge className={priorityColors[rec.priority] || priorityColors.medium}>{rec.priority.toUpperCase()}</Badge>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">{rec.summary}</p>
        
        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div>
            <p className="text-xs font-medium text-slate-400 uppercase">Expected ROI</p>
            <p className="text-sm font-semibold flex items-center text-emerald-600">
              <TrendingUp className="w-3 h-3 mr-1" /> {rec.expected_roi || 'N/A'}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-400 uppercase">Est. Savings</p>
            <p className="text-sm font-semibold">${rec.estimated_savings?.toLocaleString() || '0'}</p>
          </div>
        </div>
      </CardContent>

      <CardFooter className="bg-slate-50 dark:bg-slate-900/50 flex justify-between pt-4">
        <Button variant="ghost" size="sm" onClick={() => setIsExplaining(true)} className="text-slate-500">
          <HelpCircle className="w-4 h-4 mr-2" /> Why?
        </Button>
        <div className="space-x-2">
          {status !== 'accepted' && status !== 'applied' && (
            <Button variant="outline" size="sm" onClick={() => handleAction('dismissed')}>Dismiss</Button>
          )}
          {status !== 'accepted' && status !== 'applied' && (
            <Button size="sm" onClick={() => handleAction('accepted')}>Accept</Button>
          )}
          {(status === 'accepted' || status === 'applied') && (
            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
              <CheckCircle2 className="w-3 h-3 mr-1" /> {status.toUpperCase()}
            </Badge>
          )}
        </div>
      </CardFooter>

      {isExplaining && (
        <ExplainabilityPanel 
          rec={rec} 
          onClose={() => setIsExplaining(false)} 
        />
      )}
    </Card>
  )
}
