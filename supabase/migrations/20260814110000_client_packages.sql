-- Packages — a committed bundle of work sold at one agreed price.
--
-- Replaces the retired Client Agreements module, deliberately as ONE thing:
-- an invoicing + tracking layer. A package does NOT price tasks and does NOT
-- touch payroll. A task keeps its normal Pricing-Matrix price, so the employee
-- pool stays `billing_amount_inr × commission% / 100` exactly as it is for
-- every other task. The old system's second pricing basis (work_unit_value)
-- decoupled from the matrix is what produced its bugs; there is no equivalent
-- here.
--
-- What a package changes:
--   • the INVOICE — covered tasks collapse into one bulk line at the package
--     price, instead of appearing individually
--   • a PROGRESS view — delivered vs remaining against what was committed
--
-- Two deliberate design rules:
--   1. A task links to a package EXPLICITLY (tasks.package_id, set from the
--      task form). No trigger infers it. Silent trigger-based matching is the
--      specific mechanism that broke the old system repeatedly.
--   2. Which included line a task fulfils is resolved by service_id, and
--      covered-vs-extra is DERIVED at read time (first N by date are covered,
--      the rest are extra). Nothing is stamped, so nothing can go stale.

BEGIN;

-- ── 1. The package ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_packages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,

  -- Doubles as the invoice line description, so it must read well to a client:
  -- "Social Media Management", not "PKG-001".
  name              TEXT NOT NULL,

  -- 'monthly'  — bills every month the package is in force (a retainer)
  -- 'one_time' — bills once, ever (a project/package fee)
  billing_type      TEXT NOT NULL DEFAULT 'monthly'
                      CHECK (billing_type IN ('one_time', 'monthly')),

  -- What the CLIENT pays. Never used to price a task or size the pool.
  price             NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'INR',

  -- Optional agreed overage rate, per task, beyond the included quantity.
  -- NULL → an extra task simply bills at its normal Pricing-Matrix price.
  extra_task_price  NUMERIC(14,2),

  start_date        DATE NOT NULL,
  end_date          DATE,                       -- NULL = ongoing

  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),

  notes             TEXT,
  created_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

-- The hot read: "which packages are in force for this client on this date?"
CREATE INDEX IF NOT EXISTS client_packages_client_idx
  ON public.client_packages (client_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS client_packages_term_idx
  ON public.client_packages (start_date, end_date) WHERE deleted_at IS NULL;

-- ── 2. What's included ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_package_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id        UUID NOT NULL REFERENCES public.client_packages(id) ON DELETE CASCADE,
  service_id        UUID NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,

  -- 1 for a logo, 15 for a month of posts. For a 'monthly' package this is the
  -- allowance PER MONTH; for 'one_time' it is the total for the whole package.
  included_quantity INT NOT NULL DEFAULT 1 CHECK (included_quantity >= 0),

  display_order     INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One line per service. This is load-bearing: a task carries a service, and
  -- that service is what decides which included line it fulfils. Two lines on
  -- the same service would make that match ambiguous.
  UNIQUE (package_id, service_id)
);

CREATE INDEX IF NOT EXISTS client_package_items_package_idx
  ON public.client_package_items (package_id, display_order);

-- ── 3. The two links ─────────────────────────────────────────────────────────
-- tasks.package_id — set explicitly by the user from the task form. ON DELETE
-- SET NULL so deleting a package un-links its tasks rather than deleting work.
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS package_id UUID
    REFERENCES public.client_packages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_package_idx
  ON public.tasks (package_id, task_date) WHERE package_id IS NOT NULL;

-- invoice_items.package_id — marks a line as "this package's fee". It is the
-- idempotency key: a resync looks for an existing line with this package_id
-- rather than trying to match on description, so resyncing never duplicates.
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS package_id UUID
    REFERENCES public.client_packages(id) ON DELETE SET NULL;

-- At most ONE fee line per package per invoice. Enforced in the database so a
-- concurrent resync cannot slip a second one past the app's check.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_items_package_uniq
  ON public.invoice_items (invoice_id, package_id) WHERE package_id IS NOT NULL;

COMMENT ON COLUMN public.tasks.package_id IS
  'Package this task is delivered under. Set explicitly from the task form; no trigger infers it. Does not affect the task price or the contribution pool — only whether it appears as its own invoice line.';
COMMENT ON COLUMN public.invoice_items.package_id IS
  'Marks this line as a package fee. Idempotency key for invoice resync.';

-- ── 4. RLS (house pattern: permissive; real authz is app-level guards) ───────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_packages','client_package_items']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_authenticated_all', t);
  END LOOP;
END $$;

-- ── 5. Permissions ───────────────────────────────────────────────────────────
-- Reuses display_order 85-86, vacated by the retired agreements.* keys, so the
-- designations editor keeps these in the same place in the Finance band.
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('packages', 'view',   'packages.view',   'View Packages',
    'See committed packages, what is delivered and what remains',   85),
  ('packages', 'manage', 'packages.manage', 'Manage Packages',
    'Create and edit packages, their price and extra-work rate',    86)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('packages.view','packages.manage')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
