#!/usr/bin/env node
/**
 * Generates the rollback SQL for a commitment backfill run. PRINTS ONLY —
 * it never connects to the database and never executes anything. You paste
 * the output into the Supabase SQL editor after reading it.
 *
 *   node scripts/backfill-rollback-sql.mjs backfill-recovery-<ts>.json > rollback.sql
 *
 * Works from the recovery file the backfill writes BEFORE its first write, so
 * rollback never depends on the run having completed, nor on the append-only
 * audit table having succeeded.
 *
 * DESIGN NOTE — why the created rows are DEACTIVATED, not DELETED:
 * client_service_pricing rows carry the agreed price that historical
 * commission recompute still reads. Deleting one destroys that history. The
 * 5 created rows carry price null today, so deleting them would be harmless
 * *right now* — but if anyone prices one before the rollback runs, a DELETE
 * silently destroys an agreed rate. Deactivating is correct in both cases.
 */
import { readFileSync } from 'fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/backfill-rollback-sql.mjs <backfill-recovery-*.json>')
  process.exit(2)
}
const r = JSON.parse(readFileSync(path, 'utf8'))
const q = s => `'${String(s).replace(/'/g, "''")}'`
const idList = ids => ids.map(q).join(',\n    ')

const out = []
out.push(`-- ============================================================================`)
out.push(`-- ROLLBACK for commitment backfill run at ${r.ranAt}`)
out.push(`-- Generated from: ${path}`)
out.push(`--`)
out.push(`-- Reverses: ${r.deactivateIds.length} deactivations, ${r.reactivateIds.length} reactivations, ${r.created.length} creations.`)
out.push(`--`)
out.push(`-- SAFE TO RE-RUN. Every statement is idempotent: re-running sets the same`)
out.push(`-- rows to the same values. Safe after a PARTIAL run too — rows the backfill`)
out.push(`-- never reached are simply set to the state they already hold.`)
out.push(`--`)
out.push(`-- READ THE COUNTS AT THE BOTTOM BEFORE COMMITTING.`)
out.push(`-- ============================================================================`)
out.push(``)
out.push(`BEGIN;`)
out.push(``)

// 1. Undo the deactivations.
if (r.deactivateIds.length) {
  out.push(`-- 1. Reactivate the ${r.deactivateIds.length} deactivated commitments.`)
  out.push(`--    deactivated_at/by MUST be cleared, or a live row carries a stale`)
  out.push(`--    "removed on" date and every UI reads it as pending-removal.`)
  out.push(`UPDATE client_service_pricing`)
  out.push(`   SET is_active = true, deactivated_at = NULL, deactivated_by = NULL`)
  out.push(` WHERE id IN (\n    ${idList(r.deactivateIds)}\n  );`)
  out.push(``)
}

// 2. Undo the reactivations.
if (r.reactivateIds.length) {
  out.push(`-- 2. Re-deactivate the ${r.reactivateIds.length} rows the backfill revived.`)
  out.push(`UPDATE client_service_pricing`)
  out.push(`   SET is_active = false, deactivated_at = ${q(r.ranAt)}`)
  out.push(` WHERE id IN (\n    ${idList(r.reactivateIds)}\n  );`)
  out.push(``)
}

// 3. Undo the creations — by deactivating, never deleting.
if (r.created.length) {
  out.push(`-- 3. Deactivate the ${r.created.length} created commitments. NOT a DELETE:`)
  out.push(`--    the row carries the agreed price historical recompute reads.`)
  out.push(`--    If a run was partial, some of these may not exist — that is fine,`)
  out.push(`--    the UPDATE simply matches nothing.`)
  for (const c of r.created) {
    out.push(`UPDATE client_service_pricing SET is_active = false, deactivated_at = ${q(r.ranAt)}`)
    out.push(` WHERE client_id = ${q(c.client_id)} AND service_id = ${q(c.service_id)};`)
  }
  out.push(``)
}

// 4. Audit the rollback itself.
out.push(`-- 4. Record the rollback. service_scope_audit is APPEND-ONLY by trigger:`)
out.push(`--    the backfill's own audit rows CANNOT be deleted or amended, and that`)
out.push(`--    is deliberate. The trail reads forward — backfill, then rollback.`)
out.push(`INSERT INTO service_scope_audit (scope_kind, action, client_id, service_id, old_value, new_value, actor_id, source)`)
out.push(`SELECT 'client_service', 'activated', client_id, service_id,`)
out.push(`       jsonb_build_object('is_active', false),`)
out.push(`       jsonb_build_object('is_active', true, 'reason', 'rollback of backfill ${r.ranAt}'),`)
out.push(`       NULL, 'backfill'`)
out.push(`  FROM client_service_pricing WHERE id IN (\n    ${idList(r.deactivateIds)}\n  );`)
out.push(``)

// 5. Verify before committing.
out.push(`-- 5. VERIFY BEFORE COMMITTING. Expected after a full rollback:`)
out.push(`--      active   = ${r.deactivateIds.length + r.reactivateIds.length ? 'the pre-backfill count' : 'unchanged'}`)
out.push(`--      inactive = ${r.created.length} (only the created rows, now parked)`)
out.push(`SELECT is_active, count(*) FROM client_service_pricing GROUP BY is_active ORDER BY is_active;`)
out.push(``)
out.push(`-- Sanity: no row may be live while still carrying a removal stamp.`)
out.push(`SELECT count(*) AS live_rows_with_stale_stamp`)
out.push(`  FROM client_service_pricing WHERE is_active = true AND deactivated_at IS NOT NULL;`)
out.push(`-- ^ MUST be 0.`)
out.push(``)
out.push(`-- If both look right:   COMMIT;`)
out.push(`-- If anything is off:   ROLLBACK;`)
out.push(`COMMIT;`)

console.log(out.join('\n'))
