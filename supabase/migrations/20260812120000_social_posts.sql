-- ============================================================================
-- Cirqle Social Hub — Phase 2: content composer + publishing pipeline
-- ============================================================================
--   social_posts        — publishable content items with the full workflow
--                         draft → awaiting_approval → approved → scheduled →
--                         publishing → published | failed | cancelled
--   storage bucket      — 'social-media': uploaded post media. PUBLIC because
--                         Meta's Content Publishing API downloads media from a
--                         URL (image_url/video_url must be publicly reachable).
--                         Paths are unguessable UUIDs.
--
-- Scheduling model (verified Aug 2026): Instagram has NO native scheduling —
-- Cirqle holds the queue and publishes at time via the social-publisher cron.
-- Facebook Pages support native scheduled_publish_time (10 min–30 days); the
-- app-side queue is used for both so approval/cancel works identically.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.social_posts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  -- Optional link back to the planning calendar
  calendar_item_id  UUID REFERENCES public.social_calendar_items(id) ON DELETE SET NULL,
  content_type      TEXT NOT NULL
    CHECK (content_type IN ('image','carousel','video','reel','story_image','story_video','text','link')),
  status            TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','awaiting_approval','approved','scheduled','publishing','published','failed','cancelled')),
  caption           TEXT,
  hashtags          TEXT,                       -- appended to caption at publish
  first_comment     TEXT,                       -- IG: posted via /comments right after publish
  link_url          TEXT,                       -- FB link posts
  -- Media descriptors: [{url, type:'image'|'video', mime, size_bytes, width, height, duration_s, storage_path}]
  media             JSONB NOT NULL DEFAULT '[]',
  cover_url         TEXT,                       -- Reels cover image
  share_to_feed     BOOLEAN NOT NULL DEFAULT TRUE,  -- Reels: also show in feed
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  external_media_id TEXT,                       -- Meta media/post id after publish
  permalink         TEXT,
  publish_error     TEXT,
  publish_attempts  INTEGER NOT NULL DEFAULT 0,
  designer_id       UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  assigned_to       UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  approved_by       UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  created_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS social_posts_due_idx
  ON public.social_posts (scheduled_at) WHERE status = 'scheduled' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS social_posts_client_idx
  ON public.social_posts (client_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS social_posts_account_idx
  ON public.social_posts (account_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS social_posts_calendar_idx
  ON public.social_posts (calendar_item_id) WHERE calendar_item_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_social_posts_modtime ON public.social_posts;
CREATE OR REPLACE TRIGGER update_social_posts_modtime
  BEFORE UPDATE ON public.social_posts FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_posts_read ON public.social_posts;
CREATE POLICY social_posts_read ON public.social_posts
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- Published Cirqle post ↔ synced media item cross-link
ALTER TABLE public.social_media_items
  ADD COLUMN IF NOT EXISTS social_post_id UUID REFERENCES public.social_posts(id) ON DELETE SET NULL;

-- ── Storage bucket for post media (public: Meta fetches by URL) ─────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('social-media', 'social-media', TRUE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "social media read" ON storage.objects;
CREATE POLICY "social media read" ON storage.objects
  FOR SELECT USING (bucket_id = 'social-media');
-- Uploads/deletes go through the service role (server actions) only.

-- ── Permission catalog ───────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('social', 'publish', 'social.publish', 'Create Social Posts',
    'Create/edit social posts, upload media and send posts for approval', 93),
  ('social', 'approve', 'social.approve', 'Approve & Publish Posts',
    'Approve posts, schedule them and publish immediately to Meta', 94)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('social.publish','social.approve')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
