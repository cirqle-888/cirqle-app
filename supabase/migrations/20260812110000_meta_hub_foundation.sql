-- ============================================================================
-- Meta Hub — Phase 0 foundation
-- ============================================================================
-- 1. provider_connections: token metadata columns + hard RLS lockdown.
--    docs/db-state.md (1 Aug 2026) flagged this table as readable with the
--    public anon key while holding PLAINTEXT Meta tokens. From this migration
--    on: RLS enabled with ZERO policies — only the service-role key (server
--    code) can touch it. App code already goes through createAdminClient().
--    Tokens are now written AES-256-GCM encrypted by the app
--    (src/lib/integrations/tokens.ts); legacy plaintext rows keep working and
--    are re-encrypted on next write.
--    ⚠ OPERATIONS: rotate the existing Meta tokens after applying this
--    (disconnect + reconnect each provider in /dashboard/advertising/integrations)
--    since the old plaintext values must be treated as leaked.
-- 2. webhook_events: durable, idempotent log of every webhook delivery
--    (Meta leadgen etc.) — used for dedup, debugging and replay.
-- ============================================================================

BEGIN;

-- ── 1a. Token / connection metadata ─────────────────────────────────────────
ALTER TABLE public.provider_connections
  ADD COLUMN IF NOT EXISTS granted_scopes TEXT[],
  ADD COLUMN IF NOT EXISTS token_type     TEXT,             -- 'user' | 'page' | 'system_user'
  ADD COLUMN IF NOT EXISTS api_version    TEXT,             -- Graph version at last auth
  ADD COLUMN IF NOT EXISTS last_error     TEXT;

-- ── 1b. RLS lockdown: service-role only ─────────────────────────────────────
ALTER TABLE public.provider_connections ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'provider_connections'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.provider_connections', pol.policyname);
  END LOOP;
END $$;
-- No policies re-created on purpose: anon + authenticated get nothing;
-- the service-role key bypasses RLS.

-- ── 2. Webhook event log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL DEFAULT 'meta',
  topic           TEXT NOT NULL,                    -- e.g. 'page' | 'instagram'
  field           TEXT,                             -- e.g. 'leadgen' | 'feed' | 'comments'
  object_id       TEXT,                             -- page id / ig user id the event belongs to
  -- Idempotency: a stable key derived from the event payload
  -- (e.g. 'leadgen:<leadgen_id>'). Unique so the same delivery can never be
  -- processed twice, even under Meta's at-least-once retry semantics.
  event_key       TEXT,
  payload         JSONB NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processed','failed','skipped','duplicate')),
  error           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_key_uniq
  ON public.webhook_events (provider, event_key) WHERE event_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_events_received_idx
  ON public.webhook_events (provider, field, received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_events_status_idx
  ON public.webhook_events (status) WHERE status IN ('received','failed');

-- Service-role only (payloads can contain PII from lead submissions).
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

COMMIT;
