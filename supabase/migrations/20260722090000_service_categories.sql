-- ─────────────────────────────────────────────────────────────────────────────
-- Service categories — a reusable taxonomy for the service catalog.
--
-- WHY: the catalog is 41 services (33 active) rendered as one flat list of
-- pills in the Edit Employee modal. It is already unusable and grows monotonically.
-- More importantly there is currently NO way to ask "how much of our revenue is
-- Social Media?" — the only grouping that exists is the service name itself.
--
-- AXIS: delivery discipline (what skill delivers it), NOT department or
-- designation. Designation conflates *who* with *what* — employee_services
-- already answers "who" — and a designation-shaped grouping cannot be reused in
-- reports, pricing or client-facing views. Departments get reorganised;
-- "a logo is a branding job" does not.
--
-- ONE CATEGORY PER SERVICE, deliberately. Tags feel more flexible but break
-- reporting: "revenue by category" must sum to 100% with no double counting. If
-- cross-cutting labels are needed later, add a separate service_tags table
-- rather than compromising the taxonomy.
--
-- TWO ASSIGNMENT LEVELS, stored separately (this is the point):
--     effective services = (services in my categories) ∪ (my direct services)
-- Storing a category assignment AS a category — rather than expanding it into
-- its children at save time — is what makes it dynamic. Add a 6th Offer Flyer
-- service next year and everyone assigned to that category picks it up with no
-- re-assignment. Expanding at save time would silently freeze the old set.
--
-- Audit reuses service_scope_audit: 20260720100000 declared scope_kind open
-- text precisely "so future dimensions reuse this table rather than needing
-- their own". This is that case — scope_kind = 'employee_service_category'.
--
-- Rollback: supabase/rollbacks/20260722090000_service_categories_down.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Catalog hygiene ───────────────────────────────────────────────────────
-- Two rows carry leading/trailing whitespace ("Logo Design ", "    Label &
-- Packaging Design"). Harmless until you match on name — which the category
-- seed below does, and which every CSV import already does. Fix before seeding,
-- not after.

UPDATE public.services SET name = btrim(name) WHERE name <> btrim(name);

-- ── 1. The taxonomy ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.service_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT,
  color         TEXT,                       -- tailwind-ish token for UI chips
  display_order INT  NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NULL category is a legitimate, expected state: it means "not yet classified",
-- which is exactly where the four genuinely-ambiguous services start. ON DELETE
-- SET NULL so removing a category never cascades into deleting services.
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS category_id UUID
    REFERENCES public.service_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS services_category_idx
  ON public.services (category_id) WHERE category_id IS NOT NULL;

-- ── 2. Category-level employee assignment ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.employee_service_categories (
  employee_id UUID NOT NULL REFERENCES public.employees(id)          ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.service_categories(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, category_id)
);

CREATE INDEX IF NOT EXISTS employee_service_categories_employee_idx
  ON public.employee_service_categories (employee_id);

-- RLS: `TO authenticated`, never a bare USING(true) with no TO clause — that
-- applies to PUBLIC including the anon key that ships in every browser bundle
-- (the defect 20260720100000 §2 had to fix on employee_services). Real
-- authorization is app-level; server reads use the service-role client.
ALTER TABLE public.service_categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_service_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_categories_authenticated_all ON public.service_categories;
CREATE POLICY service_categories_authenticated_all ON public.service_categories
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS employee_service_categories_authenticated_all ON public.employee_service_categories;
CREATE POLICY employee_service_categories_authenticated_all ON public.employee_service_categories
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 2b. Audit support for the new dimension ──────────────────────────────────
-- service_scope_audit.scope_kind is open text by design, but every varying-side
-- id it can store is a service_id with an FK to services(id). A category
-- assignment's varying side is a CATEGORY, so writing it into service_id would
-- fail that FK and — because audit writes are best-effort and never fail the
-- write they describe — would vanish silently. Give the dimension its own
-- column. Also widen the action CHECK is NOT needed: added/removed already cover it.

ALTER TABLE public.service_scope_audit
  ADD COLUMN IF NOT EXISTS category_id UUID
    REFERENCES public.service_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS service_scope_audit_category_idx
  ON public.service_scope_audit (category_id, created_at DESC) WHERE category_id IS NOT NULL;

-- ── 3. Seed the taxonomy ─────────────────────────────────────────────────────
-- Ordered by revenue contribution, so the UI lists the categories that matter
-- first. Offer Flyers alone is ~76% of all revenue to date.

INSERT INTO public.service_categories (name, slug, description, color, display_order) VALUES
  ('Offer Flyers',       'offer-flyers',
   'Offer flyer production, updates and revisions — the core recurring product.', 'amber',   1),
  ('Social Media',       'social-media',
   'Social posts, stories, profile assets and account-level social work.',        'violet',  2),
  ('Print & Collateral', 'print-collateral',
   'Physical and print deliverables: stationery, packaging, menus, hoardings.',   'emerald', 3),
  ('Branding & Identity','branding-identity',
   'Logos, company profiles and identity documents.',                             'rose',    4),
  ('Paid Advertising',   'paid-advertising',
   'Ad campaign setup, management and ad-spend services.',                        'sky',     5),
  ('Digital Setup',      'digital-setup',
   'Account provisioning, mail/domain configuration and automation builds.',      'cyan',    6),
  ('Video',              'video',
   'Video editing and motion work.',                                              'fuchsia', 7),
  ('General Design',     'general-design',
   'Catch-all design work not yet split into a specific discipline.',             'slate',   8)
ON CONFLICT (slug) DO NOTHING;

-- ── 4. Classify the catalog ──────────────────────────────────────────────────
-- Exact-name matching against the trimmed names from §0. Deliberately explicit
-- rather than pattern-matched: a LIKE '%Flyer%' would sweep up anything a
-- future service happens to be called, and misclassifying a service silently
-- changes who can see it once scope.by_service is granted.
--
-- DELIBERATELY LEFT UNCATEGORISED (category_id stays NULL), to be classified by
-- hand in the UI — these are genuine judgement calls about how the work is
-- sold, not facts recoverable from the data:
--     Design Services            150 tasks / 27 clients — the biggest catch-all
--     Creative Posters            45 tasks
--     Simple Informative Posters  16 tasks
--     Rivision/Updation           15 tasks

UPDATE public.services s SET category_id = c.id
FROM public.service_categories c
WHERE s.category_id IS NULL AND (
     (c.slug = 'offer-flyers' AND s.name IN (
        'Offer Flyer', 'Offer Flyer Updating', 'Revised Offer Flyer',
        'A3 Offer Flyer', 'Extra Design on Offer Flyer'))
  OR (c.slug = 'social-media' AND s.name IN (
        'Social Media Poster', 'Social Media Services',
        'Posting (including Story Size Variants)',
        'Profile Display Pictures (DPs) & Instagram Highlight Icons',
        'Facebook Cover Page Design'))
  OR (c.slug = 'print-collateral' AND s.name IN (
        'Stationary Designs', 'Label & Packaging Design', 'Menu Design',
        'Table Mat Design', 'Hoarding Design', 'Collateral Design'))
  OR (c.slug = 'branding-identity' AND s.name IN (
        'Logo Design', 'Company Profile', 'CV/Biodata'))
  -- 'Ad Running…' is matched by prefix, not exact name: two rows exist and one
  -- of them contains a literal newline inside the name ("Ad Running\n(As Agreed
  -- / _100 Ad Spend)"). Embedding that newline in a SQL literal survives
  -- Postgres but not copy-paste, editors or diff review. The prefix is narrow
  -- enough to be unambiguous here.
  OR (c.slug = 'paid-advertising' AND (
        s.name IN ('Ad Campaign Service', 'Facebook Ads Setup')
        OR s.name LIKE 'Ad Running%'))
  OR (c.slug = 'digital-setup' AND s.name IN (
        'Facebook & Instagram Account Creation + Configuration',
        'Work Space Mail Configuration', 'Domain Purchase',
        'Google Sheets Automation & Dashboard Development'))
  OR (c.slug = 'video' AND s.name IN (
        'Video Editing', 'Logo Animation Video'))
);

-- The six 'Service at _NNN' placeholder buckets plus 'Pending' and 'Variants'
-- are retired scaffolding (all inactive or zero-task; the commitment backfill
-- retired 342 rows pointing at them). Park them in General Design so they are
-- never NULL-by-accident and are easy to find and archive later.
UPDATE public.services s SET category_id = c.id
FROM public.service_categories c
WHERE c.slug = 'general-design'
  AND s.category_id IS NULL
  AND s.is_active IS NOT TRUE
  AND (s.name LIKE 'Service at %' OR s.name IN ('Pending', 'Variants'));
