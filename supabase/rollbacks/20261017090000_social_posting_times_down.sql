-- Rollback for 20261017090000_social_posting_times.
--
-- Read this before running it wholesale. The two new TABLES are safe to drop —
-- nothing else references them and no money path reads them. The COLUMNS are
-- not equally safe, because dropping them destroys real planning decisions:
--
--   social_calendar_items.scheduled_time   every posting time anyone has set
--   social_calendar_items.posted_at        the record of what actually went out
--   clients.social_requires_approval       which clients sign off before posting
--
-- Losing posted_at is the worst of the three: it is the only place that
-- records a post was published, and the pipeline has never been able to tell
-- the difference between "the artwork is finished" and "it went out".
--
-- So the column drops are commented out. Uncomment deliberately, having
-- decided you want the data gone. Dropping the two tables and leaving the
-- columns in place is a complete, harmless rollback of the feature: with no
-- slots and no evidence, nothing suggests or bulk-assigns a time, and the
-- columns simply sit unread.
--
-- Revoking the calendar feeds is the one step you may want on its own, and it
-- is listed first for that reason: it is also the correct response to a feed
-- URL having leaked.

BEGIN;

-- Revoke every subscribable calendar. Safe and reversible in the sense that
-- matters: a new token can be minted from the app at any time. Existing
-- subscriptions start returning 404 immediately.
UPDATE public.employees SET calendar_feed_token = NULL WHERE calendar_feed_token IS NOT NULL;

DROP TABLE IF EXISTS public.social_best_times;
DROP TABLE IF EXISTS public.social_posting_slots;

DROP INDEX IF EXISTS public.social_calendar_items_posting_idx;
DROP INDEX IF EXISTS public.employees_calendar_feed_token_idx;

-- ── Destructive. Uncomment only if you want the decisions themselves gone. ──
-- ALTER TABLE public.social_calendar_items DROP COLUMN IF EXISTS scheduled_time;
-- ALTER TABLE public.social_calendar_items DROP COLUMN IF EXISTS post_asap;
-- ALTER TABLE public.social_calendar_items DROP COLUMN IF EXISTS posting_priority;
-- ALTER TABLE public.social_calendar_items DROP COLUMN IF EXISTS posted_at;
-- ALTER TABLE public.social_calendar_items DROP COLUMN IF EXISTS posted_by;
-- ALTER TABLE public.clients   DROP COLUMN IF EXISTS social_requires_approval;
-- ALTER TABLE public.employees DROP COLUMN IF EXISTS calendar_feed_token;

-- No permission keys to remove: the migration deliberately added none, reusing
-- social.manage and social.publish.

COMMIT;
