/**
 * Client Agreements — shared types & display maps.
 *
 * Pure, framework-agnostic (no 'use server'/'use client') so it can be imported
 * by server actions, client components, and unit tests alike.
 */

// ─── Enums (kept as text in the DB; these are the allowed values) ────────────

export type AgreementStatus =
  | 'draft'
  | 'pending_approval'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'expired'

export type RenewalType = 'none' | 'manual' | 'auto'

export type CommitmentType = 'one_time' | 'retainer'

export type Cycle = 'monthly' | 'quarterly' | 'yearly'

export type CarryForwardRule = 'expire' | 'carry_forward' | 'manual'

export type Visibility = 'internal' | 'client'

export type EventActorType = 'client' | 'admin' | 'system'

export type AgreementEventAction =
  | 'created'
  | 'updated'
  | 'quotation_linked'
  | 'activated'
  | 'item_added'
  | 'item_updated'
  | 'item_removed'
  | 'term_changed'
  | 'renewed'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'adjustment'
  | 'note'

// ─── Option lists (drive the create/edit dropdowns) ──────────────────────────

export const STATUSES: { value: AgreementStatus; label: string }[] = [
  { value: 'draft',            label: 'Draft' },
  { value: 'pending_approval', label: 'Pending Approval' },
  { value: 'active',           label: 'Active' },
  { value: 'paused',           label: 'Paused' },
  { value: 'completed',        label: 'Completed' },
  { value: 'cancelled',        label: 'Cancelled' },
  { value: 'expired',          label: 'Expired' },
]

export const COMMITMENT_TYPES: { value: CommitmentType; label: string }[] = [
  { value: 'one_time', label: 'One Time' },
  { value: 'retainer', label: 'Retainer' },
]

export const CYCLES: { value: Cycle; label: string }[] = [
  { value: 'monthly',   label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly',    label: 'Yearly' },
]

export const CARRY_RULES: { value: CarryForwardRule; label: string }[] = [
  { value: 'expire',        label: 'Expire at end of cycle' },
  { value: 'carry_forward', label: 'Carry forward' },
  { value: 'manual',        label: 'Manual adjustment' },
]

export const RENEWAL_TYPES: { value: RenewalType; label: string }[] = [
  { value: 'none',   label: 'None' },
  { value: 'manual', label: 'Manual' },
  { value: 'auto',   label: 'Auto' },
]

export const VISIBILITY_TYPES: { value: Visibility; label: string }[] = [
  { value: 'internal', label: 'Internal' },
  { value: 'client',   label: 'Client Facing' },
]

export const STATUS_LABEL: Record<string, string> =
  Object.fromEntries(STATUSES.map(s => [s.value, s.label]))

/** Status chip styling (mirrors advertising/types.ts STATUS_CHIP). */
export const AGREEMENT_STATUS_CHIP: Record<string, string> = {
  draft:            'bg-secondary text-muted-foreground border-border',
  pending_approval: 'bg-amber-500/12 text-amber-700 border-amber-500/25 dark:text-amber-400',
  active:           'bg-green-500/12 text-green-700 border-green-500/25 dark:text-green-400',
  paused:           'bg-orange-500/12 text-orange-700 border-orange-500/25 dark:text-orange-400',
  completed:        'bg-emerald-500/12 text-emerald-700 border-emerald-500/25 dark:text-emerald-400',
  cancelled:        'bg-red-500/10 text-red-700/80 border-red-500/20 dark:text-red-400/80',
  expired:          'bg-gray-500/12 text-gray-700 border-gray-500/25 dark:text-gray-400',
}

// ─── Row shapes (Supabase returns snake_case) ────────────────────────────────

export interface ClientAgreementRow {
  id: string
  agreement_number: string
  client_id: string
  quotation_id: string | null
  title: string
  status: AgreementStatus
  start_date: string
  end_date: string | null
  renewal_type: RenewalType
  signed_document_url: string | null
  public_token: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface ClientAgreementItemRow {
  id: string
  agreement_id: string
  service_id: string | null
  commitment_type: CommitmentType
  committed_quantity: number | null
  cycle: Cycle | null
  effective_from: string
  effective_to: string | null
  unit_price: number | null
  currency: string
  carry_forward_rule: CarryForwardRule
  extra_unit_price: number | null
  display_order: number
  notes: string | null
  // Internal retainer allocation (never client-facing pricing; migration
  // 20260728120000). unit_price is the monthly retainer; these split it
  // internally for operational metrics only.
  creative_allocation_amount: number | null
  management_allocation_amount: number | null
  included_quantity: number | null
  /** DB-generated: creative_allocation_amount / included_quantity. Read-only. */
  allocated_unit_value: number | null
  // Work-value pricing (migration 20260807110000). Internal per-task value for
  // covered work — feeds the contribution pool, never the invoice.
  work_unit_value: number | null
  /** Employee-pool % for work on this item. NULL = engine default (50). */
  work_commission_pct: number | null
  /**
   * Client-facing name on the invoice ("Brand Identity Development"). NULL
   * falls back to the service name — which is the internal catalogue entry
   * ("Logo Design"), not necessarily the wording in the signed proposal.
   */
  invoice_label: string | null
  created_at: string
  updated_at: string
}

export interface ClientAgreementDeliverableRow {
  id: string
  item_id: string
  label: string
  content_types: string[]
  committed_quantity: number
  display_order: number
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ClientAgreementMilestoneRow {
  id: string
  item_id: string
  label: string
  display_order: number
  due_date: string | null
  visibility: Visibility
  task_id: string | null
  completed_at: string | null
  completed_by: string | null
  created_at: string
  updated_at: string
}

export interface ClientAgreementTaskRow {
  item_id: string
  task_id: string
  created_at: string
}

export interface ClientAgreementEventRow {
  id: string
  agreement_id: string
  actor_type: EventActorType
  actor_id: string | null
  actor_label: string | null
  action: AgreementEventAction
  visibility: Visibility
  detail: any
  created_at: string
}

export interface ClientAgreementAdjustmentRow {
  id: string
  item_id: string
  month: string
  qty: number
  reason: string | null
  created_by: string | null
  created_at: string
}

export interface ClientAgreementTemplateRow {
  id: string
  name: string
  description: string | null
  payload: any
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function agrRefLabel(agr: { agreement_number: string; title: string }): string {
  return `${agr.agreement_number} · ${agr.title}`
}
