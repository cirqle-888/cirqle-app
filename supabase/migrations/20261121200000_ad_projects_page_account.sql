-- ============================================================================
-- Which page a campaign advertises
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- A company (internal) campaign is only "client_id NULL", so every ad Cirqle
-- runs for itself lands in one bucket. Cirqle now has more than one page of its
-- own: Cirqle Works, and Cirqle Flyers (the offer-flyer service, @cirqle_flyers).
-- Their ads run from the same shared ad account as client campaigns, so neither
-- the client nor the ad account says which page a campaign is for.
--
-- page_account_id names the Facebook Page or Instagram account the campaign
-- promotes. The app offers Cirqle's own accounts (owner_type = 'cirqle') for a
-- company campaign and the client's accounts for a client campaign. NULL means
-- not set, which is how every existing campaign reads.
-- ============================================================================

BEGIN;

ALTER TABLE public.ad_projects
  ADD COLUMN IF NOT EXISTS page_account_id UUID
    REFERENCES public.social_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.ad_projects.page_account_id IS
  'The Facebook Page / Instagram account this campaign advertises (social_accounts). '
  'For company campaigns this tells Cirqle''s own pages apart, e.g. Cirqle Works '
  'and Cirqle Flyers. NULL = not set.';

CREATE INDEX IF NOT EXISTS ad_projects_page_account_idx
  ON public.ad_projects (page_account_id)
  WHERE page_account_id IS NOT NULL;

COMMIT;
