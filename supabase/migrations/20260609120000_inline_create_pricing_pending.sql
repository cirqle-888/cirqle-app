-- ============================================================
-- Inline client/service creation + "pending to price" workflow
-- ============================================================
-- Adds:
--   clients.pricing_pending   — set when a non-pricing user creates a client
--   services.pricing_pending  — set when a non-pricing user creates a service
--   clients.create  permission — allow adding clients (e.g. from Add Task)
--   services.create permission — allow adding services (e.g. from Add Task)
--
-- A user WITHOUT `tasks.view_pricing` who creates a client/service leaves it
-- flagged `pricing_pending = true`, so an admin / pricing person can fill in
-- the commercial details. The flag clears when pricing is set (or marked priced).
-- After applying, go to Settings → Designations to assign the new permissions.
-- ============================================================

-- 1. Pending-to-price flags ----------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS pricing_pending boolean NOT NULL DEFAULT false;
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS pricing_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.clients.pricing_pending IS
  'true = created by a non-pricing user; awaiting commercial/pricing details from an admin.';
COMMENT ON COLUMN public.services.pricing_pending IS
  'true = created by a non-pricing user; awaiting commercial/pricing details from an admin.';

-- Helpful partial indexes for the "needs pricing" counts/badges.
CREATE INDEX IF NOT EXISTS clients_pricing_pending_idx
  ON public.clients (pricing_pending) WHERE pricing_pending = true;
CREATE INDEX IF NOT EXISTS services_pricing_pending_idx
  ON public.services (pricing_pending) WHERE pricing_pending = true;

-- 2. Permission catalog --------------------------------------------------------
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('clients', 'create',
    'clients.create',
    'Add Clients',
    'Create new clients (e.g. the + Add client option in the task form). Without pricing access, new clients are flagged for an admin to price.',
    30),
  ('services', 'create',
    'services.create',
    'Add Services',
    'Create new services (e.g. the + Add service option in the task form). Without pricing access, new services are flagged for an admin to price.',
    31)
ON CONFLICT (key) DO NOTHING;

-- 3. Grant both to every Admin designation -------------------------------------
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('clients.create', 'services.create')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
