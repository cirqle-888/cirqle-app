-- ============================================================================
-- Posting TIMES — stop missing the moment a post was planned for
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- The planner has only ever known the DAY: social_calendar_items.scheduled_date
-- is a DATE. The time is decided per client from their own page analytics, it
-- is the part that actually gets missed, and it has had nowhere to live. A
-- poster finished on time and published at 11pm missed its slot.
--
-- Four things are added, and the split between them is the whole design:
--
--   scheduled_time   the time THIS post goes out. Optional — a plan without a
--                    time is still a valid plan, and demanding one would make
--                    the planning screen harder to use than the paper it
--                    replaced.
--   posting slots    the client's standing weekly template ("Mon/Wed/Fri
--                    19:30"), typed in by whoever read the analytics. This is
--                    the PLAN, and it is what pre-fills and bulk-assigns.
--   best times       hourly evidence — Meta's online_followers for a connected
--                    account, or a figure read off a screenshot. SUGGESTS only.
--                    Never writes a time by itself, because the person who
--                    chose 19:30 may know something the numbers cannot see.
--   feed tokens      a per-employee secret for the subscribable calendar that
--                    carries the 15-minute alarm.
--
-- No cron is added. Nothing on this plan can fire 15 minutes before anything
-- (Vercel Hobby is daily-or-slower, see api/cron/interview-reminders), so the
-- alarm is the subscriber's phone, not our server.
-- ============================================================================

BEGIN;

-- ── 1. The time on the plan ─────────────────────────────────────────────────
-- TIME, not TIMESTAMPTZ. A slot is "19:30 on the India business calendar", a
-- wall-clock intention, not an instant — storing an instant would make every
-- stored plan drift if anything about the zone ever changed. The single place
-- it becomes a real moment is postInstant() in lib/social/posting-time.ts.
ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS scheduled_time TIME;

COMMENT ON COLUMN public.social_calendar_items.scheduled_time IS
  'Wall-clock posting time on the India business calendar. NULL means no time '
  'decided yet — a valid state, not an error.';

-- The trending-poster lane. A flag rather than a sentinel time, because "post
-- this the moment it is ready" is a different statement from "post this at
-- 00:00", and a sentinel would quietly occupy a real slot in the bulk planner.
ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS post_asap BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.social_calendar_items.post_asap IS
  'Publish as soon as it is approved — trending content with no scheduled '
  'slot. Excluded from slot assignment entirely.';

-- Lower goes out first when a day holds more than one post. Separate from
-- display_order, which is only how the planner arranges cards on screen.
ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS posting_priority INTEGER NOT NULL DEFAULT 0;

-- Recorded when someone confirms the post actually went out, so the posting
-- view can stop nagging. Distinct from the pipeline's own completion: the
-- artwork being finished has never meant the post was published.
ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS posted_by UUID REFERENCES public.employees(id) ON DELETE SET NULL;

-- The posting view's hot path: "what goes out today, in time order".
CREATE INDEX IF NOT EXISTS social_calendar_items_posting_idx
  ON public.social_calendar_items (scheduled_date, scheduled_time)
  WHERE posted_at IS NULL AND status <> 'cancelled';

-- ── 2. The client's standing slots ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_posting_slots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- 0 = Sunday, matching EXTRACT(DOW) and JS getDay(). One number, one meaning,
  -- everywhere in the stack.
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  time_of_day TIME NOT NULL,
  -- Empty means every platform this client posts to. Not NULL-able, so callers
  -- never have to handle both "empty" and "unset" as the same thing.
  platforms   TEXT[] NOT NULL DEFAULT '{}',
  label       TEXT,
  -- Which slot a batch fills before the next. Lower first.
  priority    INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.social_posting_slots IS
  'A client''s standing weekly posting times — the plan, decided from their '
  'page analytics. Pre-fills the planner and drives bulk assignment.';

-- One slot per client per weekday per time. Re-adding 19:30 Monday is an edit,
-- not a second slot that would silently double-book the bulk planner.
CREATE UNIQUE INDEX IF NOT EXISTS social_posting_slots_unique_idx
  ON public.social_posting_slots (client_id, weekday, time_of_day);

CREATE INDEX IF NOT EXISTS social_posting_slots_client_idx
  ON public.social_posting_slots (client_id, weekday) WHERE active;

DROP TRIGGER IF EXISTS update_social_posting_slots_modtime ON public.social_posting_slots;
CREATE OR REPLACE TRIGGER update_social_posting_slots_modtime
  BEFORE UPDATE ON public.social_posting_slots FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ── 3. Evidence from analytics ──────────────────────────────────────────────
-- Deliberately a SEPARATE table from the slots. Merging them would make it
-- possible for a sync to overwrite a human decision, which is the one thing
-- this module must never do.
CREATE TABLE IF NOT EXISTS public.social_best_times (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- NULL when the figure describes the client generally rather than one
  -- connected account (a screenshot of someone else's dashboard, say).
  account_id  UUID REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('meta', 'screenshot', 'manual')),
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  hour        SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  -- Relative strength on whatever scale the source uses. Compared only against
  -- other rows from the SAME source — Meta's follower counts and a number read
  -- off a screenshot are not the same unit.
  score       NUMERIC NOT NULL DEFAULT 0,
  -- What this was derived from, in words, so a suggestion can always be
  -- justified to the person being asked to trust it.
  note        TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.social_best_times IS
  'Hourly engagement evidence per client. Suggests posting times; never sets '
  'one. Fed by the Meta online_followers sync and by screenshot import.';

-- A re-sync replaces a source's figures rather than piling up a second copy.
-- Two partial indexes rather than one over COALESCE(account_id, ...): a
-- NULL account_id means "about the client generally", and in a plain unique
-- index every NULL is distinct, so the same screenshot imported twice would
-- happily store two copies. Importers replace by DELETE-then-INSERT for a
-- (client, source) pair, so neither index is ever an ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS social_best_times_account_idx
  ON public.social_best_times (client_id, account_id, source, weekday, hour)
  WHERE account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS social_best_times_client_idx
  ON public.social_best_times (client_id, source, weekday, hour)
  WHERE account_id IS NULL;

CREATE INDEX IF NOT EXISTS social_best_times_lookup_idx
  ON public.social_best_times (client_id, weekday, score DESC);

-- ── 4. Does this client approve before we post? ─────────────────────────────
-- Explicit per client, like has_social_media_service. "Some clients" was the
-- requirement, and inferring it from whether anyone has ever approved
-- something would get it wrong for every new client.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS social_requires_approval BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.clients.social_requires_approval IS
  'This client signs off each post before it goes out. The posting view shows '
  'their posts as blocked until approved rather than ready.';

-- ── 5. The subscribable calendar ────────────────────────────────────────────
-- A per-employee secret in the feed URL. A calendar subscription cannot carry
-- a session cookie or an Authorization header — the phone fetches it with no
-- app involved — so the URL itself is the credential. Hence: random, long,
-- per person, and revocable by setting it to NULL.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS calendar_feed_token TEXT;

COMMENT ON COLUMN public.employees.calendar_feed_token IS
  'Secret in the webcal subscription URL. The URL IS the credential — a '
  'calendar client sends no cookie or header. NULL revokes the feed.';

CREATE UNIQUE INDEX IF NOT EXISTS employees_calendar_feed_token_idx
  ON public.employees (calendar_feed_token) WHERE calendar_feed_token IS NOT NULL;

-- Tokens are minted on demand by the app, never backfilled here: a feed nobody
-- asked for is a live secret for no reason.

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
-- TO authenticated, matching the rest of the social module (20260716120000).
-- Every read and write in this module goes through createAdminClient(), which
-- bypasses RLS; these policies exist so the anon key in the browser bundle can
-- never reach client posting plans.
ALTER TABLE public.social_posting_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_best_times    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "social_posting_slots_authenticated_all" ON public.social_posting_slots;
CREATE POLICY "social_posting_slots_authenticated_all"
ON public.social_posting_slots FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "social_best_times_authenticated_all" ON public.social_best_times;
CREATE POLICY "social_best_times_authenticated_all"
ON public.social_best_times FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 7. Permissions ──────────────────────────────────────────────────────────
-- No new keys. Setting a client's slots is planning the calendar
-- (social.manage); the posting view and the bulk planner are publishing
-- (social.publish). Both already exist and are already granted to the people
-- who do this work — inventing two more keys would mean every designation
-- needs editing before the feature works at all.

COMMIT;
