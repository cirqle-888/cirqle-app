// Check which migrations are APPLIED vs PENDING on the live Supabase DB.
// Read-only: every probe is a `select ... limit 0`, a HEAD-style rpc existence
// check, or a seeded-row lookup. Nothing is written.
//
// Usage:  node scripts/check-pending-migrations.mjs
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local
// (same pattern as the other scripts in this folder).

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim()
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// kind: table  -> select col from table limit 0
//       column -> select col from table limit 0 (col added by the migration)
//       view   -> select * from view limit 0
//       rpc    -> PGRST202 means the function does not exist
//       row    -> seeded row must exist (eq match)
//       bucket -> storage bucket must exist
const PROBES = [
  // ── root migrations/ (001–025) ──────────────────────────────────────────
  { m: 'migrations/001_designations_and_self_registration', kind: 'table',  table: 'designations', col: 'id' },
  { m: 'migrations/002_task_variants',                      kind: 'column', table: 'tasks', col: 'parent_task_id' },
  { m: 'migrations/003_billing_snapshot',                   kind: 'column', table: 'tasks', col: 'billing_snapshot' },
  { m: 'migrations/003_tasks_import_columns',               kind: 'column', table: 'tasks', col: 'task_number' },
  { m: 'migrations/005_granular_permissions',               kind: 'row',    table: 'permissions', col: 'key', eq: 'tasks.view_pricing' },
  { m: 'migrations/006_rls_enforce_auth',                   kind: 'rpc',    rpc: 'has_permission' },
  { m: 'migrations/008_parameters_is_master',               kind: 'column', table: 'parameters', col: 'is_master' },
  { m: 'migrations/009_reports_and_task_perms',             kind: 'row',    table: 'permissions', col: 'key', eq: 'reports.view' },
  { m: 'migrations/010_activity_logs',                      kind: 'table',  table: 'activity_logs', col: 'id' },
  { m: 'migrations/011_cashbook_receipt_number',            kind: 'column', table: 'cashbook_entries', col: 'receipt_number' },
  { m: 'migrations/012_tasks_soft_delete',                  kind: 'column', table: 'tasks', col: 'deleted_at' },
  { m: 'migrations/014_timeline_extension',                 kind: 'column', table: 'activity_logs', col: 'client_id' },
  { m: 'migrations/015_chat_module',                        kind: 'table',  table: 'conversations', col: 'id' },
  { m: 'migrations/016_chat_phase2',                        kind: 'bucket', bucket: 'chat-attachments' },
  { m: 'migrations/017_approvals',                          kind: 'table',  table: 'approvals', col: 'id' },
  { m: 'migrations/018_chat_read_receipts',                 kind: 'table',  table: 'message_reads', col: 'message_id' },
  { m: 'migrations/019_chat_categories_entities',           kind: 'column', table: 'conversations', col: 'request_id' },
  { m: 'migrations/020_recruitment',                        kind: 'table',  table: 'job_positions', col: 'id' },
  { m: 'migrations/021_connect_wave2',                      kind: 'table',  table: 'workspace_items', col: 'id' },
  { m: 'migrations/022_workspaces',                         kind: 'table',  table: 'workspaces', col: 'id' },
  { m: 'migrations/025_native_push_tokens',                 kind: 'table',  table: 'native_push_tokens', col: 'id' },

  // ── supabase/migrations/ (timestamped) ──────────────────────────────────
  { m: '20240001_offer_campaigns',            kind: 'table',  table: 'offer_campaigns', col: 'id' },
  { m: '20240003_product_catalog',            kind: 'table',  table: 'product_catalog', col: 'id' },
  { m: '20240004_offer_flyer_service_flag',   kind: 'column', table: 'clients', col: 'has_offer_flyer_service' },
  { m: '20260523070451_phase9_payroll_allocations', kind: 'table', table: 'cashbook_payroll_allocations', col: 'id' },
  { m: '20260523081538_add_payslip_number',   kind: 'column', table: 'payroll', col: 'payslip_number' },
  { m: '20260523100106_add_dashboard_permission', kind: 'row', table: 'permissions', col: 'key', eq: 'dashboard.view', note: 'also seeded by fix_unique_constraints.sql — proves one of the two' },
  { m: '20260531120000_multicurrency_fx',     kind: 'column', table: 'invoices', col: 'total_amount_inr' },
  { m: '20260601000000_currency_aware_allocations', kind: 'rpc', rpc: 'recompute_invoice_from_allocations' },
  { m: '20260602000000_cashbook_client_id',   kind: 'column', table: 'cashbook_entries', col: 'client_id' },
  { m: '20260606100000_performance_history',  kind: 'table',  table: 'employee_performance_history', col: 'id' },
  { m: '20260606110000_contribution_scores_manual_override', kind: 'column', table: 'contribution_scores', col: 'is_manual_override' },
  { m: '20260607120000_payslip_emails',       kind: 'table',  table: 'payslip_emails', col: 'id' },
  { m: '20260609120000_inline_create_pricing_pending', kind: 'column', table: 'clients', col: 'pricing_pending' },
  { m: '20260609140000_commission_agreements', kind: 'table', table: 'employee_commission_agreements', col: 'id' },
  { m: '20260610120000_request_portal',       kind: 'table',  table: 'task_requests', col: 'id' },
  { m: '20260611090000_portal_refinements',   kind: 'column', table: 'task_requests', col: 'priority_rank' },
  { m: '20260611100000_cashbook_transfers',   kind: 'column', table: 'cashbook_entries', col: 'transfer_ref' },
  { m: '20260612120000_request_cancelled_value', kind: 'column', table: 'task_requests', col: 'estimated_value' },
  { m: '20260616120000_invoice_followups',    kind: 'table',  table: 'invoice_followups', col: 'id' },
  { m: '20260616130000_invoice_public_token', kind: 'column', table: 'invoices', col: 'public_token' },
  { m: '20260620120000_contributions_view_activity_permission', kind: 'row', table: 'permissions', col: 'key', eq: 'contributions.view_activity' },
  { m: '20260621000000_services_intake_kind', kind: 'column', table: 'services', col: 'intake_kind' },
  { m: '20260621010000_product_images_bucket', kind: 'bucket', bucket: 'product-images' },
  { m: '20260621030000_offer_product_badges_and_pages', kind: 'table', table: 'offer_product_badges', col: 'id' },
  { m: '20260621040000_client_hub_token',     kind: 'column', table: 'clients', col: 'hub_token' },
  { m: '20260623080000_notifications_indexes', kind: 'column', table: 'notifications', col: 'source_key' },
  { m: '20260623090000_cron_runs',            kind: 'table',  table: 'cron_runs', col: 'id' },
  { m: '20260623100000_task_assignments',     kind: 'table',  table: 'task_assignments', col: 'task_id' },
  { m: '20260627000000_add_group_services_table', kind: 'table', table: 'group_services', col: 'group_id' },
  { m: '20260628120000_advertising_module',   kind: 'table',  table: 'ad_projects', col: 'id' },
  { m: '20260628130000_advertising_daily_budget', kind: 'column', table: 'ad_projects', col: 'daily_budget' },
  { m: '20260628140000_advertising_service_and_requests', kind: 'column', table: 'ad_projects', col: 'service_id' },
  { m: '20260629080000_advertising_erp',      kind: 'table',  table: 'provider_connections', col: 'id' },
  { m: '20260629090000_system_jobs_upgrade',  kind: 'column', table: 'system_jobs', col: 'retry_delay_seconds', note: 'shares columns with 20260629120000 — see enterprise_queue rpc probe' },
  { m: '20260629120000_enterprise_queue',     kind: 'rpc',    rpc: 'requeue_stale_jobs' },
  { m: '20260629124000_phase_e1_ai_foundation', kind: 'table', table: 'ai_prompts', col: 'id' },
  { m: '20260629125000_phase_e1_5_ai_improvements', kind: 'column', table: 'ai_prompts', col: 'prompt_version' },
  { m: '20260629130000_phase_e1_5_refinement', kind: 'column', table: 'ad_ai_insights', col: 'root_cause' },
  { m: '20260629140000_phase_e2_telemetry',   kind: 'table',  table: 'ad_ai_usage', col: 'id' },
  { m: '20260629200000_client_reporting',     kind: 'table',  table: 'client_branding', col: 'id' },
  { m: '20260630120000_ad_reports_daily_and_retention', kind: 'row', table: 'company_settings', col: 'key', eq: 'report_retention_days' },
  { m: '20260630140000_ad_campaign_mapping',  kind: 'table',  table: 'ad_campaigns', col: 'id' },
  { m: '20260701120000_billing_sync_hardening', kind: 'rpc',  rpc: 'rate_to_inr_for' },
  { m: '20260703120000_ad_fund_allocations',  kind: 'table',  table: 'ad_fund_allocations', col: 'id' },
  { m: '20260703140000_ad_wallet_ledger',     kind: 'table',  table: 'ad_wallet_ledger', col: 'id' },
  { m: '20260703150000_ad_projects_archive',  kind: 'column', table: 'ad_projects', col: 'archived_at' },
  { m: '20260704120000_business_partners',    kind: 'table',  table: 'business_partners', col: 'id' },
  { m: '20260705120000_favorites',            kind: 'table',  table: 'employee_favorites', col: 'id' },
  { m: '20260705140000_clients_type (140000 applied AND 150000 NOT applied if found)', kind: 'column', table: 'clients', col: 'client_type' },
  { m: '20260705160000_scenario_snapshots',   kind: 'table',  table: 'scenario_snapshots', col: 'id' },
  { m: '20260707080643_add_is_reviewed_to_cashbook_entries', kind: 'column', table: 'cashbook_entries', col: 'is_reviewed' },
  { m: '20260707120000_bank_account_default', kind: 'column', table: 'bank_accounts', col: 'is_default' },
  { m: '20260712120000_offer_sheet_url',      kind: 'column', table: 'clients', col: 'offer_sheet_url' },
  { m: '20260714090000_finance_scope_foundation', kind: 'column', table: 'tasks', col: 'scope' },
  { m: '20260714093000_finance_views_company_wallet', kind: 'view', table: 'v_finance_journal' },
  { m: '20260714095000_wallet_credit_rpc',    kind: 'rpc',    rpc: 'credit_ad_wallet' },
  { m: '20260714150000_employee_services',    kind: 'table',  table: 'employee_services', col: 'employee_id' },
  { m: '20260714160000_cashbook_tags_and_employee_splits', kind: 'table', table: 'cashbook_tags', col: 'id' },
  { m: '20260714170000_client_partner_since', kind: 'column', table: 'clients', col: 'partner_since' },
  { m: '20260714180000_partner_commission_payments', kind: 'table', table: 'partner_commission_payments', col: 'id' },
  { m: '20260715090000_clients_module_permissions', kind: 'row', table: 'permissions', col: 'key', eq: 'clients.view' },
  { m: '20260716100000_offer_prepare_permission', kind: 'row', table: 'permissions', col: 'key', eq: 'offer.prepare' },
  { m: '20260716110000_offer_campaign_lifecycle', kind: 'column', table: 'offer_campaigns', col: 'completed_at' },
  { m: '20260716120000_social_calendar',      kind: 'table',  table: 'social_calendars', col: 'id' },
  { m: '20260722120000_client_agreements',    kind: 'table',  table: 'client_agreements', col: 'id' },

  // ── loose (non-timestamped) files in supabase/migrations ────────────────
  { m: 'loose: backfill_foreign_task_billing_inr', kind: 'column', table: 'tasks', col: 'billing_exchange_rate' },
  { m: 'loose: cashbook_invoice_link',        kind: 'column', table: 'cashbook_entries', col: 'invoice_id' },
  { m: 'loose: discount_logs',                kind: 'table',  table: 'discount_logs', col: 'id' },
  { m: 'loose: invoice_sequence',             kind: 'column', table: 'invoices', col: 'billing_period_start' },
  { m: 'loose: phase1_soft_delete',           kind: 'column', table: 'cashbook_entries', col: 'deleted_at' },
  { m: 'loose: phase2_audit_log',             kind: 'table',  table: 'cashbook_audit_log', col: 'id' },
  { m: 'loose: phase3_allocations',           kind: 'table',  table: 'cashbook_invoice_allocations', col: 'id' },
  { m: 'loose: phase10_invoice_expense_items', kind: 'table', table: 'invoice_expense_items', col: 'id' },
  { m: 'loose: phase11_expense_markup',       kind: 'column', table: 'invoice_expense_items', col: 'markup_type' },
]

// Not probeable via the REST API — run these in the Supabase SQL editor:
const SQL_EDITOR_CHECKS = `
-- migrations/007_cleanup_contribution_scores:
select 1 from pg_constraint where conname='contribution_scores_task_employee_unique';
-- migrations/013_report_layouts (RLS deny-all, probe as service role fails via REST on some setups):
select 1 from information_schema.tables where table_name='report_layouts';
-- migrations/023 + 024 (realtime publications):
select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename in ('notifications','invoices','invoice_items','invoice_expense_items');
-- 20260523082156 / 082852 (payslip fn rewrites): inspect prosrc
select prosrc from pg_proc where proname='assign_payslip_number';
-- 20260528090000 / 20260709150000 (indexes):
select indexname from pg_indexes where indexname in ('idx_invoice_items_invoice_id','idx_invoice_expense_items_invoice_id');
-- 20260615130000 (tasks 'delivered' status):
select pg_get_constraintdef(oid) from pg_constraint where conname='tasks_status_check';
-- 20260716090000 (offer 'cancelled' status)  ** flagged as must-apply in OFFER_FLYER_HANDOFF **:
select pg_get_constraintdef(oid) from pg_constraint where conname='offer_campaigns_status_check';
-- 20260714120000 (monthly report template):
select pg_get_constraintdef(oid) from pg_constraint where conname='ad_reports_template_check';
-- 20260705150000 (remove clients_type — applied if clients.client_type is ABSENT and 140000 shows applied history):
select column_name from information_schema.columns where table_name='clients' and column_name='client_type';
-- 20260629090000 vs 120000 conflict check (locked_by should be uuid if 120000 ran cleanly on a fresh column):
select data_type from information_schema.columns where table_name='system_jobs' and column_name='locked_by';
-- loose phase4/6 (triggers):
select tgname from pg_trigger where tgname in ('trigger_sync_allocations_to_invoices','trigger_auto_create_allocation_on_entry');
-- loose fix_unique_constraints:
select 1 from pg_constraint where conname='uq_discount_logs_invoice_id';
`

const results = { applied: [], pending: [], unknown: [] }

for (const p of PROBES) {
  let ok = false, detail = ''
  try {
    if (p.kind === 'rpc') {
      const { error } = await supabase.rpc(p.rpc, {})
      // PGRST202 = function not found. Any other error (wrong args, etc.) = exists.
      ok = !error || error.code !== 'PGRST202'
      detail = error ? `${error.code}` : 'callable'
    } else if (p.kind === 'bucket') {
      const { data, error } = await supabase.storage.getBucket(p.bucket)
      ok = !!data && !error
      detail = error?.message || 'bucket exists'
    } else if (p.kind === 'row') {
      const { data, error } = await supabase.from(p.table).select(p.col).eq(p.col, p.eq).limit(1)
      if (error) { results.unknown.push({ ...p, detail: error.message }); continue }
      ok = (data?.length ?? 0) > 0
      detail = ok ? 'seed row present' : 'seed row missing'
    } else if (p.kind === 'view') {
      const { error } = await supabase.from(p.table).select('*').limit(0)
      ok = !error
      detail = error?.message || 'view exists'
    } else {
      const { error } = await supabase.from(p.table).select(p.col).limit(0)
      ok = !error
      detail = error?.message || ''
    }
  } catch (e) {
    results.unknown.push({ ...p, detail: String(e) }); continue
  }
  ;(ok ? results.applied : results.pending).push({ ...p, detail })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`\n✅ APPLIED (${results.applied.length})`)
for (const r of results.applied) console.log('  ' + pad(r.m, 62) + (r.note ? ` [${r.note}]` : ''))
console.log(`\n❌ PENDING / NOT FOUND (${results.pending.length})`)
for (const r of results.pending) console.log('  ' + pad(r.m, 62) + ' — ' + r.detail + (r.note ? ` [${r.note}]` : ''))
if (results.unknown.length) {
  console.log(`\n⚠️ UNKNOWN (${results.unknown.length})`)
  for (const r of results.unknown) console.log('  ' + pad(r.m, 62) + ' — ' + r.detail)
}
console.log('\n── Not probeable via REST — paste into the Supabase SQL editor: ──')
console.log(SQL_EDITOR_CHECKS)
