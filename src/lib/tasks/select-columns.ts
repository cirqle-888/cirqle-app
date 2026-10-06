/**
 * Task columns for viewers WITHOUT tasks.view_pricing.
 *
 * Every money column is left out — billing_amount(_inr), currency,
 * loss_amount, billing_mode/percent/override/rule/snapshot, is_billable,
 * honor_contributions, work_value*, billing_exchange_rate — so they never
 * enter the browser for someone who may not see prices. Quantity stays: it is
 * a count of creatives, not money.
 *
 * Used by the Tasks page's server load AND by the browser re-reads after a
 * create / duplicate (which used to ask for `*` and so pulled the price the
 * server had just filled in back into an employee's screen).
 */
export const TASK_COLUMNS_NO_PRICING =
  'id, title, task_number, status, task_date, client_id, service_id, quantity, description, created_at, updated_at, parent_task_id, variant_type, variant_label, completion_pct, is_recurring, recurring_interval, recurring_end_date, recurring_parent_id, cancelled_by, cancellation_notes'

/** The joins every task row on the Tasks page carries. */
export const TASK_JOINS = 'client:clients(id, name, code), service:services!service_id(id, name)'
