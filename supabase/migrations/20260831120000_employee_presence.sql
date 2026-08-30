-- ============================================================================
-- employee_presence — online status + self-set status for every employee
--
-- One row per employee. Two independent halves that combine into what people
-- actually see (see src/lib/presence/status.ts, the single source of truth for
-- the rule):
--
--   AUTOMATIC   last_seen_at is bumped by a heartbeat from every open tab
--               (60s, visible tabs only). Fresh → online, stale → away, very
--               stale → offline.
--
--   MANUAL      manual_status / status_emoji / status_text are what the person
--               chose for themselves — Available, Busy, Do not disturb, Be
--               right back, Appear away, Appear offline, plus an optional
--               note ("🌴 On leave"). status_expires_at clears the pick after
--               30 minutes / an hour / today / this week.
--
-- Deliberately NOT a Realtime-presence (ephemeral channel) feature: a manual
-- status has to survive a page reload and a closed laptop, and "last seen
-- 20 minutes ago" needs a persisted timestamp. Realtime is still used, but as
-- the delivery mechanism for changes to this table, not as the store.
--
-- Cost: one UPDATE per employee per minute, of a table with as many rows as
-- there are employees. Extra tabs are free — they share a localStorage lease
-- so only one of them beats (see presence-context).
--
-- PRIVACY: no name, no email, nothing derived from them. Safe to expose to
-- every signed-in employee — which is exactly what the grant below does.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employee_presence (
  employee_id       uuid PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,

  -- Manual pick. NULL = "follow my activity", the default.
  manual_status     text CHECK (manual_status IN ('available','busy','dnd','brb','away','offline')),
  status_emoji      text CHECK (status_emoji IS NULL OR char_length(status_emoji) <= 8),
  status_text       text CHECK (status_text  IS NULL OR char_length(status_text)  <= 80),
  status_expires_at timestamptz,

  -- Automatic half.
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  device            text CHECK (device IN ('web','desktop','mobile')),

  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The roster read is "everyone whose status is worth showing", ordered by
-- recency. Tiny table, but this keeps the sort off a seq scan as the org grows.
CREATE INDEX IF NOT EXISTS idx_employee_presence_last_seen
  ON public.employee_presence (last_seen_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Reads: any signed-in employee, so the browser can subscribe to Realtime and
-- render colleagues' dots. Writes: none for `authenticated` — every mutation
-- goes through a server action on the service role, which is what stops one
-- employee from setting another's status. Same shape as the chat tables (015).

ALTER TABLE public.employee_presence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_presence_select ON public.employee_presence;
CREATE POLICY employee_presence_select ON public.employee_presence FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Least privilege (SEC-03): SELECT only, and only the columns above exist, so
-- there is nothing here to over-grant.
GRANT SELECT ON public.employee_presence TO authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────────────
-- Status changes reach open tabs the moment they land, with no polling.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.employee_presence;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
