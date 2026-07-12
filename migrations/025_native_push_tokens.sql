-- ============================================================================
-- 025_native_push_tokens — device tokens for NATIVE push (Capacitor mobile).
--
-- Web Push (VAPID) already lives in push_subscriptions (021). Native iOS/Android
-- push goes through FCM (Android) / APNs (iOS) instead, which hand the device a
-- single opaque registration token rather than an endpoint+keys triple — hence a
-- separate table. Same security shape as push_subscriptions: employees read only
-- their own rows; all writes go through the service-role server action.
--
-- Requires: employees, current_employee_id() (015).
-- ============================================================================

CREATE TABLE IF NOT EXISTS native_push_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token        text NOT NULL UNIQUE,
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_native_push_emp ON native_push_tokens (employee_id);

ALTER TABLE native_push_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS native_push_select ON native_push_tokens;
CREATE POLICY native_push_select ON native_push_tokens FOR SELECT
  USING (employee_id = current_employee_id());
-- Writes are server-action-only (service role bypasses RLS).
REVOKE INSERT, UPDATE, DELETE ON native_push_tokens FROM authenticated, anon;
