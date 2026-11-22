-- ============================================================================
-- Shop orders — retail orders for Cirqle's own product brands (Memoura first)
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- Memoura sells personalised gifts to the public. Its buyers are NOT clients:
-- they have no agreements, packages, ad accounts or reports, so they do not go
-- in `clients`. An order is one sale to one person: what they bought, where it
-- goes, what they have paid, and where it is in the making.
--
-- Self-contained on purpose. The order carries its own customer, lines and
-- money, and points at nothing but `brands` and `employees`. If the shop is
-- ever run from its own app, that app can read and write these same two
-- objects and this screen keeps working unchanged.
--
-- Buyers' names, phones and addresses are personal data. Nothing here is
-- readable from the browser: RLS is on with no policy for `authenticated`, and
-- every read and write goes through the server (service role) behind the
-- orders.view / orders.manage permissions.
-- ============================================================================

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.shop_order_no_seq START 1;

CREATE TABLE IF NOT EXISTS public.shop_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         UUID REFERENCES public.brands(id) ON DELETE SET NULL,
  order_no         TEXT NOT NULL DEFAULT ('MEM-' || lpad(nextval('public.shop_order_no_seq')::text, 4, '0')),
  status           TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','advance_paid','preview_sent','approved','printing','shipped','delivered','cancelled')),
  source           TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','website','whatsapp','instagram','other')),
  -- Buyer
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT,
  deliver_to       TEXT,
  pincode          TEXT,
  -- What they bought: [{ id, name, meta, qty, price }] and [{ key, name, price }]
  items            JSONB NOT NULL DEFAULT '[]'::jsonb,
  extras           JSONB NOT NULL DEFAULT '[]'::jsonb,
  occasion_note    TEXT,
  needed_by        DATE,
  -- Money (INR). Totals are computed by the server from items and extras.
  items_total      NUMERIC(12,2) NOT NULL DEFAULT 0,
  extras_total     NUMERIC(12,2) NOT NULL DEFAULT 0,
  delivery_charge  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid      NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Dispatch
  courier          TEXT,
  tracking         TEXT,
  shipped_at       TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  notes            TEXT,
  created_by       UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS shop_orders_order_no_key ON public.shop_orders (order_no);
CREATE INDEX IF NOT EXISTS shop_orders_open_idx    ON public.shop_orders (status, needed_by) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS shop_orders_brand_idx   ON public.shop_orders (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_orders_created_idx ON public.shop_orders (created_at DESC);

DROP TRIGGER IF EXISTS update_shop_orders_modtime ON public.shop_orders;
CREATE TRIGGER update_shop_orders_modtime
  BEFORE UPDATE ON public.shop_orders FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Personal data: server-only. RLS on, no policy, no grants to the browser roles.
ALTER TABLE public.shop_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_orders FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.shop_order_no_seq FROM anon, authenticated;

COMMENT ON TABLE public.shop_orders IS 'Retail orders for Cirqle''s own product brands (Memoura). Buyers are not clients. Server-only: personal data.';

-- ── Permissions ──────────────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('orders', 'view',   'orders.view',   'View Orders',
    'Open Orders: shop orders with the buyer''s name, phone, address and what they paid', 97),
  ('orders', 'manage', 'orders.manage', 'Manage Orders',
    'Add and edit shop orders, change their status, record payments and dispatch details', 98)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('orders.view','orders.manage')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

NOTIFY pgrst, 'reload schema';

COMMIT;
