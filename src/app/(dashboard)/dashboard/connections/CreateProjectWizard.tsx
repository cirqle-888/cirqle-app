'use client'

import { useState, useEffect } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { createAdProject } from './actions'

interface Props {
  open: boolean;
  onOpenChange: (val: boolean) => void;
  adAccount: any | null;
  clientId: string;
}

export function CreateProjectWizard({ open, onOpenChange, adAccount, clientId }: Props) {
  const [step, setStep] = useState(1)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  const [formData, setFormData] = useState({
    campaign_name: '',
    currency: 'USD',
    timezone: 'UTC',
    sync_frequency: 'daily',
    sync_enabled: true,
    ai_enabled: true,
    forecast_enabled: true
  })

  // Reset form when account changes
  useEffect(() => {
    if (adAccount) {
      setFormData(prev => ({
        ...prev,
        campaign_name: `${adAccount.name} Master Sync`,
        currency: adAccount.currency || 'USD',
        timezone: adAccount.timezone || 'UTC'
      }))
    }
  }, [adAccount])

  const handleSubmit = async () => {
    if (!adAccount || !clientId) return
    setIsSubmitting(true)
    
    try {
      await createAdProject({
        ...formData,
        client_id: clientId,
        ad_account_id: adAccount.id
      })
      
      alert('Project created and sync initialized.')
      onOpenChange(false)
      window.location.reload()
    } catch (err: any) {
      alert(err.message || 'Failed to create project.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <ModalOverlay onClose={() => onOpenChange(false)}>
      <div className="bg-card text-card-foreground shadow-lg border sm:rounded-2xl rounded-t-2xl w-full sm:w-[500px] overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-6 border-b">
          <h2 className="text-xl font-semibold">Connect Ad Account</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure sync and AI settings for <strong>{adAccount?.name}</strong>.
          </p>
        </div>

        <div className="p-6 overflow-y-auto">
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Project Name</label>
                <input 
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={formData.campaign_name}
                  onChange={(e) => setFormData({ ...formData, campaign_name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Currency</label>
                  <input 
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Timezone</label>
                  <input 
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={formData.timezone}
                    onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">Sync Frequency</label>
                <select 
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={formData.sync_frequency} 
                  onChange={(e) => setFormData({ ...formData, sync_frequency: e.target.value })}
                >
                  <option value="hourly">Every Hour</option>
                  <option value="6_hours">Every 6 Hours</option>
                  <option value="daily">Daily</option>
                </select>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <label className="text-base font-medium">Enable Sync</label>
                  <p className="text-sm text-muted-foreground">Download campaigns, adsets, and daily metrics automatically.</p>
                </div>
                <input 
                  type="checkbox"
                  className="h-5 w-5"
                  checked={formData.sync_enabled}
                  onChange={(e) => setFormData({ ...formData, sync_enabled: e.target.checked })}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <label className="text-base font-medium">Enable AI Engine</label>
                  <p className="text-sm text-muted-foreground">Automatically score campaign health and generate recommendations.</p>
                </div>
                <input 
                  type="checkbox"
                  className="h-5 w-5"
                  checked={formData.ai_enabled}
                  onChange={(e) => setFormData({ ...formData, ai_enabled: e.target.checked })}
                />
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t bg-muted/50 flex gap-2 w-full justify-between mt-auto">
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setStep(2)}>Next Step</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create & Sync
              </Button>
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
